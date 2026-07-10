import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { logger } from './logger.js';
import { SearXNGClient } from './searxng-client.js';
import { ScrapeClient, ScrapeClientResponse } from './scrape-client.js';
import { RedisCache } from './redis-cache.js';
import { normalizeUrl } from './url-normalizer.js';
import { extractRelevantPassages } from './passage-extractor.js';
import { stripMarkdownFromData, ContentMode } from './content-utils.js';
import { FourgetClient } from './fourget-client.js';
import { mergeSearchResults } from './search-merger.js';
import express from 'express';
import http from 'http';

config();

// ── Module-level constants ────────────────────────────────────────────
const DEFAULT_LIMIT       = Number(process.env.WEB_SEARCH_LIMIT)          || 25;
const FIT_MIN_WORDS       = Number(process.env.FIT_MIN_WORDS)             || 250;
const MAX_RETRIES         = Number(process.env.WEB_SEARCH_MAX_RETRIES)    || 1;
const CRAWL_PER_URL_TIMEOUT_MS  = Number(process.env.WEB_SEARCH_CRAWL_TIMEOUT_MS)  || 1000;
const CRAWL_BATCH_TIMEOUT_MS    = Number(process.env.WEB_SEARCH_CRAWL_BATCH_TIMEOUT_MS) || 1500;
const CRAWL_POOL_SIZE           = Number(process.env.WEB_SEARCH_CRAWL_POOL_SIZE)      || 15;
const DEEP_PER_URL_TIMEOUT_MS   = 20_000;
const DEEP_BATCH_TIMEOUT_MS     = 60_000;
const DEEP_POOL_SIZE            = 8;

// Cache TTL configuration (milliseconds)
const URL_SCRAPE_CACHE_TTL_MS   = Number(process.env.MCP_URL_SCRAPE_CACHE_TTL_MS)   || 86_400_000; // 24h
const SEARCH_CACHE_TTL_MS       = Number(process.env.MCP_SEARCH_CACHE_TTL_MS)        || 300_000;    // 5 min
const COMPOSITE_CACHE_TTL_MS    = Number(process.env.MCP_COMPOSITE_CACHE_TTL_MS)     || 300_000;    // 5 min

// Passage extraction configuration
const RELEVANCE_TOP_N           = Number(process.env.MCP_RELEVANCE_TOP_N)            || 5;
const RELEVANCE_CONTEXT_WINDOW  = Number(process.env.MCP_RELEVANCE_CONTEXT_WINDOW)   || 1;
const RELEVANCE_MIN_SCORE       = Number(process.env.MCP_RELEVANCE_MIN_SCORE)        || 0.0;

// Research tool defaults
const RESEARCH_MAX_RESULTS_SINGLE  = 3;
const RESEARCH_MAX_RESULTS_MULTI   = 5;
const RESEARCH_SCRAPE_TIMEOUT_MS   = 10000;
const RESEARCH_NORMAL_POOL_SIZE    = 15;
const RESEARCH_CACHE_PREFIX        = 'research';

// ── Server class ──────────────────────────────────────────────────────
export class SearXNGMCPServer {
  private server: Server;
  private searxng: SearXNGClient;
  private fourget: FourgetClient;
  private cache: RedisCache;
  private _scrapeClient?: ScrapeClient;
  // network server state (optional)
  private expressApp?: express.Application;
  private httpServer?: http.Server;
  private sseSessions = new Map<string, any>();

  constructor() {
    this.server = new Server(
      {
        name: 'searxng-crw-mcp',
        version: '3.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize clients
    this.searxng = new SearXNGClient(process.env.SEARXNG_URL || 'http://localhost:8081');
    this.fourget = new FourgetClient(process.env.FOURGET_URL || 'http://localhost:8090');
    this.cache = new RedisCache(process.env.REDIS_URL);

    this.setupToolHandlers();

    // Optional: start a small internal HTTP server that exposes
    // - GET /health
    // - GET /mcp/sse  (accepts SSE connections and registers an MCP transport)
    // - POST /mcp/sse (receive client POST messages for SSE sessions)
    // - POST /mcp/tool/:name (convenience proxy for common tools)
    try {
      const port = Number(process.env.MCP_HTTP_PORT || process.env.MCP_PORT || 3003);
      const token = process.env.MCP_INTERNAL_TOKEN;

      const app = express();
      app.use(express.json({ limit: '1mb' }));

      if (token) {
        app.use((req, res, next) => {
          const auth = String(req.headers.authorization || '');
          if (!auth || auth !== `Bearer ${token}`) {
            logger.warn('mcp:http:auth:deny', { path: req.path, ip: req.ip });
            return res.status(401).json({ ok: false, error: 'unauthorized' });
          }
          next();
        });
      }

      app.get('/health', async (_req, res) => {
        const searx = await this.searxng.healthCheck().catch(() => false);
        const crw = await this.getScrapeClient().healthCheck().catch(() => false);
        return res.status(200).json({ ok: true, searxng: searx, crw: crw });
      });

      app.get(['/mcp/sse', '/sse'], async (req, res) => {
        try {
          const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
          const endpoint = process.env.MCP_SSE_PATH || '/mcp/sse';
          const transport = new SSEServerTransport(endpoint, res as any);

          // start() will initialize the SSE response
          await transport.start();

          // register the transport for incoming POST messages
          this.sseSessions.set(String(transport.sessionId), transport);

          transport.onclose = () => {
            logger.info('mcp:http:sse:closed', { sessionId: transport.sessionId });
            this.sseSessions.delete(String(transport.sessionId));
          };

          await this.server.connect(transport);
          logger.info('mcp:http:sse:connected', { sessionId: transport.sessionId });
        } catch (err) {
          logger.error('mcp:http:sse:error', { message: String(err) });
          res.status(500).end();
        }
      });

      app.post(['/mcp/sse', '/sse', '/mcp/sse/:sessionId'], async (req, res) => {
        const sessionId = req.params.sessionId || req.query.sessionId || req.headers['x-session-id'];
        const transport = sessionId ? this.sseSessions.get(String(sessionId)) : undefined;
        if (!transport) return res.status(404).json({ ok: false, error: 'session not found' });

        try {
          await transport.handlePostMessage(req as any, res as any);
        } catch (err) {
          logger.error('mcp:http:sse:post:error', { message: String(err) });
          res.status(500).json({ ok: false, error: 'post error' });
        }
      });

      app.post(['/mcp/tool/:name', '/mcp/call'], async (req, res) => {
        const toolName = req.params.name || req.body?.name;
        const args = req.body?.arguments || req.body?.args || req.body?.params || {};
        if (!toolName) return res.status(400).json({ ok: false, error: 'tool name required' });

        try {
          switch (toolName) {
            case 'search_web':
              return res.json({ ok: true, result: await this.handleSearchWeb(args) });
            case 'scrape_url':
              return res.json({ ok: true, result: await this.handleScrapeUrl(args) });
            case 'search_and_scrape':
              return res.json({ ok: true, result: await this.handleSearchAndScrape(args) });
            default:
              return res.status(404).json({ ok: false, error: 'tool not supported via HTTP proxy' });
          }
        } catch (err: any) {
          logger.error('mcp:http:tool:error', { tool: toolName, message: err?.message || String(err) });
          return res.status(500).json({ ok: false, error: err?.message || 'tool error' });
        }
      });

      this.expressApp = app;
      this.httpServer = app.listen(port, () => logger.info('mcp:http:server:listen', { port }));
      this.httpServer.on("error", () => {});
    } catch (err) {
      logger.warn('mcp:http:disabled', { reason: String(err) });
    }
  }

  /** Lazily initialise the scrape client so env-var fallback order works. */
  private getScrapeClient(): ScrapeClient {
    if (!this._scrapeClient) {
      const baseUrl = (process.env.CRW_URL || process.env.CRAWL4AI_URL || 'http://localhost:8001').replace(/\/$/, '');
      this._scrapeClient = new ScrapeClient(baseUrl);
    }
    return this._scrapeClient;
  }

  /**
   * Scrape a URL via CRW with per-URL caching (24h TTL).
   * Uses normalized URLs for cache keys to maximize reuse.
   * Returns the raw ScrapeClientResponse — callers shape output as needed.
   */
  private async cachedScrapeUrl(
    url: string,
    formats: string[],
    timeout: number = 30000
  ): Promise<ScrapeClientResponse> {
    const normalized = normalizeUrl(url);
    const cacheKey = `scrape_url:${normalized}:${(formats || ['markdown']).join(',')}`;
    const cached = await this.cache.get<ScrapeClientResponse>(cacheKey);
    if (cached) return cached;

    const result = await this.getScrapeClient().scrape(url, {
      formats: formats || ['markdown'],
      timeout,
      wait_for: 0,
      proxy_url: process.env.PROXY_URL,
    });

    await this.cache.set(cacheKey, result, URL_SCRAPE_CACHE_TTL_MS);
    return result;
  }

  // ── Tool registration ───────────────────────────────────────────────
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'search_web',
            description: 'Search the web using SearXNG (truly self-hosted search)',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query',
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of results to return',
                  default: 25,
                },
                categories: {
                  type: 'string',
                  description: 'Search categories (general, images, news, etc.)',
                },
                engines: {
                  type: 'string',
                  description: 'Comma-separated list of engines (e.g., "google,bing")',
                },
                language: {
                  type: 'string',
                  description: 'Search language (en, es, fr, etc.)',
                  default: 'en',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'research',
            description:
              'Search the web and perform research at configurable depth and breadth. '
              + 'Depth: "quick" (search snippets only, fastest), "normal" (search + scrape top results with BM25 extraction, default), '
              + '"deep" (search → map site → crawl pages → aggregate BM25, future). '
              + 'Breadth: "single" (focus on best result, default), "multi" (all top results).',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query',
                },
                depth: {
                  type: 'string',
                  enum: ['quick', 'normal', 'deep'],
                  description: 'Research depth: "quick" (search snippets only), "normal" (search + scrape, default), "deep" (site crawling, future)',
                  default: 'normal',
                },
                breadth: {
                  type: 'string',
                  enum: ['single', 'multi'],
                  description: 'Source breadth: "single" (one best result, default), "multi" (all top results)',
                  default: 'single',
                },
                max_results: {
                  type: 'number',
                  description: 'Maximum number of search results to process (default: 3 for single, 5 for multi)',
                },
                max_pages: {
                  type: 'number',
                  description: 'Maximum total pages to crawl (deep mode only, default: 10)',
                },
                categories: {
                  type: 'string',
                  description: 'Search categories to filter by (e.g. "news", "science")',
                },
                formats: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Output formats for scraped content (default: ["markdown"])',
                },
                content_mode: {
                  type: 'string',
                  enum: ['full', 'relevant_only', 'snippet'],
                  description: 'Response content mode: "full" (everything), "relevant_only" (no full markdown), "snippet" (compact, no context)',
                  default: 'full',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'scrape_url',
            description: 'Scrape a URL using CRW (fast content extraction)',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to scrape',
                },
                formats: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Output formats',
                  default: ['markdown'],
                },
                wait_for: {
                  type: 'number',
                  description: 'Wait time in milliseconds',
                  default: 0,
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in milliseconds',
                  default: 30000,
                },
                content_mode: {
                  type: 'string',
                  enum: ['full', 'relevant_only', 'snippet'],
                  description: 'Response mode: "full" returns everything, "relevant_only" strips full markdown, "snippet" returns only key passages with no context',
                  default: 'full',
                },
              },
              required: ['url'],
            },
          },
        ] as Tool[],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_web':
            return await this.handleSearchWeb(args);
          case 'research':
            return await this.handleResearch(args);
          case 'scrape_url':
            return await this.handleScrapeUrl(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        logger.error(`Error executing tool ${name}:`, error);
        throw error;
      }
    });
  }

  // ── Tool handlers ───────────────────────────────────────────────────

  /**
   * Web search via SearXNG + 4get with caching, parallel fetch, and merged deduplicated results.
   */
  private async handleSearchWeb(args: any) {
    const { query, maxResults, categories, engines, language } = args;
    const scraper = args.scraper || 'brave';

    logger.info(`Searching web (merged): ${query}`);

    // Check cache — include scraper in key
    const cacheKey = `search:merged:${query}:${categories || ''}:${engines || ''}:${language || 'en'}:${scraper}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const limit = Math.min(maxResults || DEFAULT_LIMIT, 50);
    let lastError: any;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Call both sources in parallel
        const [searxngSettled, fourgetSettled] = await Promise.allSettled([
          this.searxng.search(query, {
            engines,
            categories,
            language: language || 'en',
            pageno: 1,
            format: 'json',
          }),
          this.fourget.search(query, scraper),
        ]);

        const searxngResults = searxngSettled.status === 'fulfilled'
          ? searxngSettled.value.results || []
          : [];
        const fourgetResults = fourgetSettled.status === 'fulfilled'
          ? fourgetSettled.value.web || []
          : [];

        if (fourgetSettled.status === 'rejected') {
          logger.warn(`4get search failed for "${query}":`, fourgetSettled.reason);
        }

        if (searxngResults.length === 0 && fourgetResults.length === 0) {
          lastError = new Error('No results found from any source');
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
        }

        // Merge + deduplicate
        const merged = mergeSearchResults(searxngResults, fourgetResults, {
          maxResults: limit,
        });

        const response = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  query,
                  total_results: merged.length,
                  results: merged.map((r) => ({
                    title: r.title,
                    url: r.url,
                    content: r.content,
                    publishedDate: r.publishedDate,
                    source: r.source,
                  })),
                  suggestion: undefined,
                  engine_info: {
                    sources_consulted: {
                      searxng: searxngSettled.status === 'fulfilled',
                      fourget: fourgetSettled.status === 'fulfilled',
                    },
                  },
                },
                null,
                2
              ),
            },
          ],
        };

        await this.cache.set(cacheKey, response, SEARCH_CACHE_TTL_MS);
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    logger.error('Merged search failed:', lastError);
    throw new Error(`Search failed: ${lastError instanceof Error ? lastError.message : 'Unknown error'}`);
  }

  /**
   * Scrape a single URL via CRW with caching.
   * Delegates to cachedScrapeUrl for unified per-URL caching.
   */
  private async handleScrapeUrl(args: any) {
    const { url, formats, timeout, content_mode } = args;

    logger.info(`Scraping with CRW: ${url}`);

    try {
      const result = await this.cachedScrapeUrl(
        url,
        formats || ['markdown'],
        timeout || 30000
      );

      // Extract passages (no query for direct scrape — returns first N paragraphs)
      let relevantPassages: any = undefined;
      if (result.data?.markdown) {
        const ctxWindow = content_mode === 'snippet' ? 0 : RELEVANCE_CONTEXT_WINDOW;
        relevantPassages = extractRelevantPassages(result.data.markdown, '', {
          topN: RELEVANCE_TOP_N,
          contextWindow: ctxWindow,
          minScore: 0,
        });
      }

      // Strip full markdown if not in 'full' mode
      const responseData: any = { ...result };
      if (responseData.data) {
        responseData.data = stripMarkdownFromData(responseData.data, content_mode);
      }

      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...responseData,
                relevant_passages: relevantPassages,
              },
              null,
              2
            ),
          },
        ],
      };

      return response;
    } catch (error) {
      logger.error('CRW scrape failed:', error);
      throw new Error(`CRW scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Search + scrape workflow: searches SearXNG then scrapes promising URLs
   * with a concurrency-limited worker pool.
   */
  private async handleSearchAndScrape(args: any) {
    const { query, maxResults, mode, scrapeAll, categories, formats, content_mode } = args;
    const contentMode = content_mode || 'full';
    const isDeep = mode === 'deep';
    const perUrlTimeout = isDeep ? DEEP_PER_URL_TIMEOUT_MS : CRAWL_PER_URL_TIMEOUT_MS;
    const batchTimeout = isDeep ? DEEP_BATCH_TIMEOUT_MS : CRAWL_BATCH_TIMEOUT_MS;
    const poolSize = isDeep ? DEEP_POOL_SIZE : CRAWL_POOL_SIZE;

    logger.info(`Search and scrape workflow: ${query}${isDeep ? ' (deep mode)' : ''}`);

    const startTime = Date.now();

    try {
      // 1. Check cache for search results
      const formatKey = (formats || ['markdown']).join(',');
      const cacheKey = `search_and_scrape:${query}:${maxResults || ''}:${mode || ''}:${scrapeAll || ''}:${categories || ''}:${formatKey}:${contentMode}`;
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;

      // 2. Search with optional retry
      let searchResults: Awaited<ReturnType<SearXNGClient['search']>> | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          searchResults = await this.searxng.search(query, {
            categories,
            language: 'en',
            format: 'json',
          });
          if (searchResults.results && searchResults.results.length > 0) break;
        } catch (e) {
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 500));
          } else {
            throw e;
          }
        }
      }

      if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query,
                  search_results: 0,
                  scraped_results: [],
                  elapsed_ms: Date.now() - startTime,
                  message: 'No search results found',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // 3. Determine which URLs to scrape
      const limit = Math.min(maxResults || 3, isDeep ? 50 : 10);
      const topResults = searchResults.results.slice(0, limit);

      type UrlEntry = { url: string; title: string; snippet: string };
      let urlsToScrape: UrlEntry[] = topResults.map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content,
      }));

      // 4. Only scrape URLs whose snippet is too short (unless forced)
      if (!scrapeAll && !isDeep) {
        urlsToScrape = urlsToScrape.filter((entry) => !entry.snippet || entry.snippet.length < 200);
      }

      logger.info(`Scraping ${urlsToScrape.length} of ${topResults.length} URLs with CRW (pool: ${poolSize})`);

      // 5. Worker pool – scrape each URL individually for per-result error handling
      const scrapedResults: Array<{
        url: string;
        success: boolean;
        data?: any;
        relevant_passages?: any;
        error?: string;
        title: string;
        snippet: string;
      }> = [];

      for (let i = 0; i < urlsToScrape.length; i += poolSize) {
        const batch = urlsToScrape.slice(i, i + poolSize);
        const batchResults = await Promise.allSettled(
          batch.map((entry) => this.scrapeSingleUrl(entry.url, perUrlTimeout, isDeep, formats))
        );

        for (let j = 0; j < batchResults.length; j++) {
          const settled = batchResults[j];
          const entry = batch[j];

          if (settled.status === 'fulfilled') {
            // 8. Content-fit check: skip results with too few words
            const wordCount = settled.value.data?.metadata?.word_count || 0;
            if (!isDeep && !scrapeAll && wordCount < FIT_MIN_WORDS) {
              continue;
            }

            const scrapeData = settled.value.data;
            // Extract relevant passages if we have markdown content
            let relevantPassages: any = undefined;
            if (scrapeData?.markdown) {
              relevantPassages = extractRelevantPassages(
                scrapeData.markdown,
                query,
                {
                  topN: RELEVANCE_TOP_N,
                  contextWindow: RELEVANCE_CONTEXT_WINDOW,
                  minScore: RELEVANCE_MIN_SCORE,
                }
              );
            }

            scrapedResults.push({
              url: entry.url,
              success: settled.value.success,
              data: scrapeData,
              relevant_passages: relevantPassages,
              title: entry.title,
              snippet: entry.snippet,
            });
          } else {
            scrapedResults.push({
              url: entry.url,
              success: false,
              error: settled.reason?.message || 'Scrape failed',
              title: entry.title,
              snippet: entry.snippet,
            });
          }
        }
      }

      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query,
                mode: isDeep ? 'deep' : 'quick',
                search_results: searchResults.number_of_results,
                scraped_count: scrapedResults.filter((r) => r.success).length,
                elapsed_ms: Date.now() - startTime,
                results: scrapedResults.map((r) => {
                  const resultData = stripMarkdownFromData(r.data, contentMode as ContentMode);

                  return {
                    search_info: {
                      title: r.title,
                      url: r.url,
                      snippet: r.snippet,
                    },
                    scraped_content: {
                      success: r.success,
                      data: r.success ? resultData : undefined,
                      error: !r.success ? r.error : undefined,
                      relevant_passages: r.relevant_passages,
                    },
                    success: r.success,
                  };
                }),
              },
              null,
              2
            ),
          },
        ],
      };

      await this.cache.set(cacheKey, response);
      return response;
    } catch (error) {
      logger.error('Search and scrape workflow failed:', error);
      throw new Error(`Search and scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Research tool: search the web with configurable depth and breadth.
   *
   * Depth:  "quick" (search snippets only), "normal" (search + scrape + BM25, default),
   *         "deep" (search → map → crawl → aggregate BM25, future)
   * Breadth: "single" (best result, default), "multi" (all top results)
   */
  private async handleResearch(args: any) {
    const { query, depth, breadth, max_results, categories, formats, content_mode } = args;
    const contentMode = (content_mode || 'full') as ContentMode;
    const researchDepth = depth || 'normal';
    const researchBreadth = breadth || 'single';

    // Validate depth — deep is not yet implemented
    if (researchDepth === 'deep') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            error: 'Deep research mode (site crawling) is not yet implemented. Use depth: "quick" or depth: "normal".',
            research_metadata: { depth: 'deep', breadth: researchBreadth, pages_scraped: 0, errors: [] },
            results: [],
          }, null, 2),
        }],
      };
    }

    const startTime = Date.now();
    const formatKey = (formats || ['markdown']).join(',');

    // Composite cache key
    const cacheKey = `${RESEARCH_CACHE_PREFIX}:${query}:${researchDepth}:${researchBreadth}:${max_results || ''}:${categories || ''}:${formatKey}:${contentMode}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      // 1. Search with retry
      let searchResults: Awaited<ReturnType<SearXNGClient['search']>> | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          searchResults = await this.searxng.search(query, {
            categories,
            language: 'en',
            format: 'json',
          });
          if (searchResults.results && searchResults.results.length > 0) break;
        } catch (e) {
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 500));
          } else {
            throw e;
          }
        }
      }

      if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            query,
            number_of_results: 0,
            unresponsive_engines: [],
            research_metadata: {
              depth: researchDepth,
              breadth: researchBreadth,
              pages_scraped: 0,
              errors: [],
            },
            results: [],
          }, null, 2) }],
        };
      }

      // 2. Determine result count
      const defaultMaxResults = researchBreadth === 'single' ? RESEARCH_MAX_RESULTS_SINGLE : RESEARCH_MAX_RESULTS_MULTI;
      const resultLimit = Math.min(max_results || defaultMaxResults, 10);
      const topResults = searchResults.results.slice(0, resultLimit);

      // 3. Dispatch by depth
      if (researchDepth === 'quick') {
        return this.handleQuickResearch(query, researchBreadth, topResults, contentMode,
          searchResults.number_of_results, searchResults.unresponsive_engines, startTime);
      }

      // depth === 'normal' — scrape + BM25
      return this.handleNormalResearch(query, researchBreadth, topResults, contentMode, formats,
        searchResults.number_of_results, searchResults.unresponsive_engines, startTime, cacheKey);
    } catch (error) {
      logger.error('Research workflow failed:', error);
      throw new Error(`Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Quick research: search snippets only, no scraping.
   */
  private handleQuickResearch(
    query: string,
    breadth: string,
    topResults: Array<{ url: string; title: string; content: string }>,
    contentMode: ContentMode,
    numberOfResults: number,
    unresponsiveEngines: string[],
    startTime: number,
  ) {
    const resultCount = breadth === 'single' ? 1 : Math.min(topResults.length, 5);
    const results = topResults.slice(0, resultCount).map((r, i) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
      source_type: 'snippet' as const,
      success: true,
      relevance_rank: i + 1,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        query,
        number_of_results: numberOfResults,
        unresponsive_engines: unresponsiveEngines,
        research_metadata: {
          depth: 'quick' as const,
          breadth: breadth,
          pages_scraped: 0,
          errors: [],
        },
        results,
        elapsed_ms: Date.now() - startTime,
      }, null, 2) }],
    };
  }

  /**
   * Normal research: search → scrape top URLs → BM25 per page.
   * This replaces the old search_and_scrape workflow.
   */
  private async handleNormalResearch(
    query: string,
    breadth: string,
    topResults: Array<{ url: string; title: string; content: string; score?: number }>,
    contentMode: ContentMode,
    formats: string[] | undefined,
    numberOfResults: number,
    unresponsiveEngines: string[],
    startTime: number,
    cacheKey: string,
  ) {
    // Determine how many URLs to scrape
    const urlsToScrapeCount = breadth === 'multi'
      ? Math.min(topResults.length, 5)
      : Math.min(topResults.length, 3);

    const urlsToScrape = topResults.slice(0, urlsToScrapeCount).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
    }));

    logger.info(`Research (normal): scraping ${urlsToScrape.length} URLs`);

    const poolSize = RESEARCH_NORMAL_POOL_SIZE;
    const scrapedResults: Array<{
      url: string;
      title: string;
      snippet: string;
      source_type: 'scraped' | 'snippet';
      success: boolean;
      data?: any;
      relevant_passages?: any;
      error?: string;
    }> = [];

    const errors: Array<{ url: string; error: string }> = [];

    for (let i = 0; i < urlsToScrape.length; i += poolSize) {
      const batch = urlsToScrape.slice(i, i + poolSize);
      const batchResults = await Promise.allSettled(
        batch.map((entry) => this.scrapeSingleUrl(entry.url, RESEARCH_SCRAPE_TIMEOUT_MS, false, formats))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        const entry = batch[j];

        if (settled.status === 'fulfilled') {
          const scrapeData = settled.value.data;

          // Content-fit filter: skip results with too few words
          const wordCount = scrapeData?.metadata?.word_count || 0;
          if (wordCount < FIT_MIN_WORDS) {
            continue;
          }

          // BM25 extraction
          let relevantPassages: any = undefined;
          if (scrapeData?.markdown) {
            const ctxWindow = contentMode === 'snippet' ? 0 : RELEVANCE_CONTEXT_WINDOW;
            relevantPassages = extractRelevantPassages(
              scrapeData.markdown,
              query,
              {
                topN: RELEVANCE_TOP_N,
                contextWindow: ctxWindow,
                minScore: RELEVANCE_MIN_SCORE,
              }
            );
          }

          // Apply content mode stripping
          const resultData = contentMode !== 'full'
            ? stripMarkdownFromData(scrapeData, contentMode)
            : scrapeData;

          scrapedResults.push({
            url: entry.url,
            title: entry.title,
            snippet: entry.snippet,
            source_type: 'scraped',
            success: settled.value.success,
            data: resultData,
            relevant_passages: relevantPassages,
          });
        } else {
          const errMsg = settled.reason?.message || 'Scrape failed';
          errors.push({ url: entry.url, error: errMsg });
          scrapedResults.push({
            url: entry.url,
            title: entry.title,
            snippet: entry.snippet,
            source_type: 'snippet',
            success: false,
            error: errMsg,
          });
        }
      }
    }

    const response = {
      content: [{ type: 'text', text: JSON.stringify({
        query,
        number_of_results: numberOfResults,
        unresponsive_engines: unresponsiveEngines,
        research_metadata: {
          depth: 'normal' as const,
          breadth,
          pages_scraped: scrapedResults.filter((r) => r.success).length,
          errors,
        },
        results: scrapedResults,
        elapsed_ms: Date.now() - startTime,
      }, null, 2) }],
    };

    await this.cache.set(cacheKey, response, COMPOSITE_CACHE_TTL_MS);
    return response;
  }

  /**
   * Scrape a single URL and return the raw ScrapeClient response.
   * Delegates to cachedScrapeUrl for unified per-URL caching.
   */
  private async scrapeSingleUrl(
    url: string,
    timeout: number,
    isDeep: boolean = false,
    formats?: string[]
  ): Promise<ScrapeClientResponse> {
    return this.cachedScrapeUrl(
      url,
      formats || ['markdown'],
      timeout
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SearXNG + CRW MCP Server started');
  }
}

const server = new SearXNGMCPServer();
server.run().catch(console.error);
