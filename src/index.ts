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
import { Crawl4AIClient, Crawl4AIResponse } from './crawl4ai-client.js';
import express from 'express';
import http from 'http';

config();

// ── Module-level constants ────────────────────────────────────────────
const DEFAULT_LIMIT       = Number(process.env.WEB_SEARCH_LIMIT)          || 25;
const FIT_MIN_WORDS       = Number(process.env.FIT_MIN_WORDS)             || 250;
const CACHE_TTL_MS        = (Number(process.env.WEB_SEARCH_CACHE_TTL)     || 300) * 1000;
const MAX_RETRIES         = Number(process.env.WEB_SEARCH_MAX_RETRIES)    || 1;
const CRAWL_PER_URL_TIMEOUT_MS  = Number(process.env.WEB_SEARCH_CRAWL_TIMEOUT_MS)  || 1000;
const CRAWL_BATCH_TIMEOUT_MS    = Number(process.env.WEB_SEARCH_CRAWL_BATCH_TIMEOUT_MS) || 1500;
const CRAWL_POOL_SIZE           = Number(process.env.WEB_SEARCH_CRAWL_POOL_SIZE)      || 15;
const DEEP_PER_URL_TIMEOUT_MS   = 20_000;
const DEEP_BATCH_TIMEOUT_MS     = 60_000;
const DEEP_POOL_SIZE            = 8;

// ── Caching ───────────────────────────────────────────────────────────
const searchCache  = new Map<string, { data: any; expires: number }>();
const scrapeCache  = new Map<string, { data: any; expires: number }>();

function getCache(map: Map<string, { data: any; expires: number }>, key: string): any | null {
  if (process.env.CACHE_ENABLED === 'false') return null;
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    map.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(map: Map<string, { data: any; expires: number }>, key: string, data: any, ttl?: number) {
  if (process.env.CACHE_ENABLED === 'false') return;
  map.set(key, { data, expires: Date.now() + (ttl ?? CACHE_TTL_MS) });
}

// ── Server class ──────────────────────────────────────────────────────
export class SearXNGMCPServer {
  private server: Server;
  private searxng: SearXNGClient;
  private _crawl4ai?: Crawl4AIClient;
  // network server state (optional)
  private expressApp?: express.Application;
  private httpServer?: http.Server;
  private sseSessions = new Map<string, any>();

  constructor() {
    this.server = new Server(
      {
        name: 'searxng-crawl4ai-mcp',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize SearXNG client
    this.searxng = new SearXNGClient(process.env.SEARXNG_URL || 'http://localhost:8081');

    // Crawl4AI client is lazily initialized via getCrawl4AIClient()

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
        const crawl = await this.getCrawl4AIClient().healthCheck().catch(() => false);
        return res.status(200).json({ ok: true, searxng: searx, crawl4ai: crawl });
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
            case 'crawl4ai_scrape':
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
    } catch (err) {
      logger.warn('mcp:http:disabled', { reason: String(err) });
    }
  }

  /** Lazily initialise the Crawl4AI client so env-var fallback order works. */
  private getCrawl4AIClient(): Crawl4AIClient {
    if (!this._crawl4ai) {
      const crawlBase = (process.env.SPIDER_URL || process.env.CRAWL4AI_URL || 'http://localhost:8001').replace(/\/$/, '');
      this._crawl4ai = new Crawl4AIClient(crawlBase);
    }
    return this._crawl4ai;
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
            name: 'search_and_scrape',
            description: 'Search the web and automatically scrape top results (combines SearXNG + Crawl4AI)',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query',
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of search results to scrape',
                  default: 3,
                },
                mode: {
                  type: 'string',
                  enum: ['quick', 'deep'],
                  description: 'Scraping mode: quick (fast, first pass) or deep (thorough, all results)',
                  default: 'quick',
                },
                scrapeAll: {
                  type: 'boolean',
                  description: 'Scrape all results regardless of snippet length',
                  default: false,
                },
                categories: {
                  type: 'string',
                  description: 'Search categories to filter by',
                },
                formats: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Formats for scraped content',
                  default: ['markdown'],
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'scrape_url',
            description: 'Scrape a URL using Crawl4AI (better than Firecrawl for self-hosted)',
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
          case 'search_and_scrape':
            return await this.handleSearchAndScrape(args);
          case 'crawl4ai_scrape':
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
   * Web search via SearXNG with caching and optional retry.
   */
  private async handleSearchWeb(args: any) {
    const { query, maxResults, categories, engines, language } = args;

    logger.info(`Searching web with SearXNG: ${query}`);

    // Check cache
    const cacheKey = `search:${query}:${categories || ''}:${engines || ''}:${language || 'en'}`;
    const cached = getCache(searchCache, cacheKey);
    if (cached) return cached;

    const limit = Math.min(maxResults || DEFAULT_LIMIT, 50);
    let lastError: any;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.searxng.search(query, {
          engines,
          categories,
          language: language || 'en',
          pageno: 1,
          format: 'json',
        });

        if (result.results && result.results.length > 0) {
          const response = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    query: result.query,
                    total_results: result.number_of_results,
                    results: result.results.slice(0, limit).map((r) => ({
                      title: r.title,
                      url: r.url,
                      content: r.content,
                      publishedDate: r.publishedDate,
                    })),
                    suggestions: result.suggestions,
                    engine_info: {
                      unresponsive: result.unresponsive_engines,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };

          setCache(searchCache, cacheKey, response);
          return response;
        }

        // No results – retry
        lastError = new Error('No results found');
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    logger.error('SearXNG search failed:', lastError);
    throw new Error(`Search failed: ${lastError instanceof Error ? lastError.message : 'Unknown error'}`);
  }

  /**
   * Scrape a single URL via Crawl4AI with caching.
   */
  private async handleScrapeUrl(args: any) {
    const { url, formats, wait_for, timeout } = args;

    logger.info(`Scraping with Crawl4AI: ${url}`);

    // Check cache
    const cacheKey = `scrape:${url}:${(formats || ['markdown']).join(',')}`;
    const cached = getCache(scrapeCache, cacheKey);
    if (cached) return cached;

    try {
      const result = await this.getCrawl4AIClient().scrape(url, {
        formats: formats || ['markdown'],
        wait_for: wait_for || 0,
        timeout: timeout || 30000,
        proxy_url: process.env.PROXY_URL,
      });

      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };

      setCache(scrapeCache, cacheKey, response);
      return response;
    } catch (error) {
      logger.error('Crawl4AI scrape failed:', error);
      throw new Error(`Crawl4AI scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Search + scrape workflow: searches SearXNG then scrapes promising URLs
   * with a concurrency-limited worker pool.
   */
  private async handleSearchAndScrape(args: any) {
    const { query, maxResults, mode, scrapeAll, categories, formats } = args;
    const isDeep = mode === 'deep';
    const perUrlTimeout = isDeep ? DEEP_PER_URL_TIMEOUT_MS : CRAWL_PER_URL_TIMEOUT_MS;
    const batchTimeout = isDeep ? DEEP_BATCH_TIMEOUT_MS : CRAWL_BATCH_TIMEOUT_MS;
    const poolSize = isDeep ? DEEP_POOL_SIZE : CRAWL_POOL_SIZE;

    logger.info(`Search and scrape workflow: ${query}${isDeep ? ' (deep mode)' : ''}`);

    const startTime = Date.now();

    try {
      // 1. Check cache for search results
      const cacheKey = `search_and_scrape:${query}:${maxResults || ''}:${mode || ''}:${scrapeAll || ''}:${categories || ''}`;
      const cached = getCache(searchCache, cacheKey);
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

      logger.info(`Scraping ${urlsToScrape.length} of ${topResults.length} URLs with Crawl4AI (pool: ${poolSize})`);

      // 5. Worker pool – scrape each URL individually for per-result error handling
      const scrapedResults: Array<{
        url: string;
        success: boolean;
        data?: any;
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
            scrapedResults.push({
              url: entry.url,
              success: settled.value.success,
              data: settled.value.data,
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
                results: scrapedResults.map((r) => ({
                  search_info: {
                    title: r.title,
                    url: r.url,
                    snippet: r.snippet,
                  },
                  scraped_content: r.success ? r.data : { error: r.error },
                  success: r.success,
                })),
              },
              null,
              2
            ),
          },
        ],
      };

      setCache(searchCache, cacheKey, response);
      return response;
    } catch (error) {
      logger.error('Search and scrape workflow failed:', error);
      throw new Error(`Search and scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Scrape a single URL and return the raw Crawl4AI response.
   * Results are cached per URL to avoid repeat work across calls.
   */
  private async scrapeSingleUrl(
    url: string,
    timeout: number,
    isDeep: boolean = false,
    formats?: string[]
  ): Promise<Crawl4AIResponse> {
    const outputFormats = formats || ['markdown'];

    const cacheKey = `scrape_single:${url}:${outputFormats.join(',')}`;
    const cached = getCache(scrapeCache, cacheKey);
    if (cached) return cached;

    const result = await this.getCrawl4AIClient().scrape(url, {
      formats: outputFormats,
      timeout,
      wait_for: 0,
      proxy_url: process.env.PROXY_URL,
    });

    setCache(scrapeCache, cacheKey, result);
    return result;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SearXNG + Crawl4AI MCP Server started');
  }
}

const server = new SearXNGMCPServer();
server.run().catch(console.error);
