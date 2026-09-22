import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { extractRelevantPassages, parseDocumentSections, rankDocumentSections } from './passage-extractor.js';
import { stripMarkdownFromData, ContentMode } from './content-utils.js';
import { DEFAULT_FOURGET_SCRAPER, FourgetClient } from './fourget-client.js';
import { discoverUrls } from './url-discovery.js';
import { buildCacheKey } from './cache-key.js';
import { resolveErrorBudget, validateResearchArgs, validateScrapeArgs } from './budget-args.js';
import { DocumentStore } from './document-store.js';
import { flattenPackedSource, packBudgetedResponse, packQuickResearch, packSectionIndex } from './response-packer.js';
import { attachResponseBudget, boundUpstreamError, compactUntrustedText, countResponseTokens, DEFAULT_MAX_TOKENS, isStableErrorCode, prepareSafeErrorPayload } from './token-budget.js';
import express from 'express';
import http from 'http';

config();

// ── Module-level constants ────────────────────────────────────────────
const DEFAULT_LIMIT       = Number(process.env.WEB_SEARCH_LIMIT)          || 25;
const FIT_MIN_WORDS       = Number(process.env.FIT_MIN_WORDS)             || 250;

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
const RESEARCH_SCRAPE_TIMEOUT_MS   = Number(process.env.MCP_RESEARCH_SCRAPE_TIMEOUT_MS) || 3000;
const RESEARCH_NORMAL_POOL_SIZE    = 15;
const RESEARCH_CACHE_PREFIX        = 'research:v5';
const FOURGET_PRIMARY_TIMEOUT_MS   = Number(process.env.MCP_FOURGET_PRIMARY_TIMEOUT_MS) || 1500;
const FOURGET_MIN_RESULTS          = Number(process.env.MCP_FOURGET_MIN_RESULTS) || 5;

// ── Server class ──────────────────────────────────────────────────────
export class SearXNGMCPServer {
  private server: Server;
  private searxng: SearXNGClient;
  private fourget: FourgetClient;
  private cache: RedisCache;
  private _scrapeClient?: ScrapeClient;
  private documentStore?: DocumentStore;
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
        const fourget = await this.fourget.healthCheck().catch(() => false);
        const crw = await this.getScrapeClient().healthCheck().catch(() => false);
        return res.status(200).json({ ok: true, searxng: searx, fourget: fourget, crw: crw });
      });

      app.get(['/mcp/sse', '/sse'], async (req, res) => {
        try {
          const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
          const endpoint = process.env.MCP_SSE_PATH || '/mcp/sse';
          const transport = new SSEServerTransport(endpoint, res as any);

          // NOTE: do NOT call transport.start() here — Server.connect()
          // calls start() automatically. Explicit start() + connect()
          // throws "SSEServerTransport already started!" and kills the
          // SSE handshake (observed on every GET /sse before this fix).

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
          await transport.handleMessage(req.body);
          res.status(202).end('Accepted');
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

  private getDocumentStore(): DocumentStore {
    if (!this.documentStore) this.documentStore = new DocumentStore();
    return this.documentStore;
  }

  private mcpJson(payload: Record<string, unknown>, maxTokens: number = DEFAULT_MAX_TOKENS) {
    const isError = typeof payload.error === 'string';
    const safe = isError ? prepareSafeErrorPayload(payload) : { ...payload };
    if (typeof safe.query === 'string') {
      safe.query = compactUntrustedText(safe.query);
    }
    let packed = attachResponseBudget(safe, maxTokens);
    let text = JSON.stringify(packed, null, 2);
    if (countResponseTokens(text) > maxTokens) {
      packed = attachResponseBudget(prepareSafeErrorPayload(safe), maxTokens);
      text = JSON.stringify(packed, null, 2);
    }
    if (countResponseTokens(text) > maxTokens) {
      const code = typeof safe.error === 'string' && isStableErrorCode(safe.error)
        ? safe.error
        : (isError ? 'upstream_error' : 'budget_too_small');
      packed = attachResponseBudget({
        error: code,
        ...(typeof safe.required_tokens === 'number' ? { required_tokens: safe.required_tokens } : {}),
      }, maxTokens);
      text = JSON.stringify(packed, null, 2);
    }
    return {
      content: [{ type: 'text', text }],
    };
  }

  private canonicalSourceData(retained: { markdown: string; title: string }) {
    const trimmed = retained.markdown.trim();
    return {
      markdown: retained.markdown,
      metadata: {
        title: retained.title,
        word_count: trimmed ? trimmed.split(/\s+/).length : 0,
      },
    };
  }

  private cachedDocumentIdsLive(cached: { content?: Array<{ text?: string }> }): boolean {
    try {
      const body = JSON.parse(cached.content?.[0]?.text || '{}') as {
        results?: Array<{ document_id?: string }>;
        document_id?: string;
      };
      const ids = [
        ...(body.document_id ? [body.document_id] : []),
        ...(body.results ?? []).map((result) => result.document_id).filter((id): id is string => Boolean(id)),
      ];
      if (ids.length === 0) return true;
      const store = this.getDocumentStore();
      return ids.every((id) => store.has(id));
    } catch {
      return false;
    }
  }

  private retainDocument(url: string, title: string, markdown: string) {
    const sections = parseDocumentSections(markdown);
    const saved = this.getDocumentStore().save({ url, title, markdown, sections });
    if (!saved.ok) {
      return {
        url,
        title,
        markdown,
        sections,
        document_id: undefined,
        read_more_unavailable: true as const,
      };
    }
    return {
      url: saved.document.url,
      title: saved.document.title,
      markdown: saved.document.markdown,
      sections: saved.document.sections,
      document_id: saved.document.document_id,
      saved_at: saved.document.saved_at,
      expires_at: saved.document.expires_at,
      read_more_unavailable: false as const,
    };
  }

  private packSavedDocument(
    document: {
      document_id: string;
      url: string;
      title: string;
      markdown: string;
      sections: ReturnType<typeof parseDocumentSections>;
      saved_at?: number;
      expires_at?: number;
    },
    request: { query?: string; section_ids?: string[]; list_sections: boolean; section_offset?: number; max_tokens: number; content_mode: ContentMode },
  ) {
    if (request.list_sections) {
      const offset = request.section_offset ?? 0;
      if (offset >= document.sections.length) {
        return this.mcpJson({
          error: 'invalid_arguments',
          message: 'section_offset is beyond the section list',
        }, request.max_tokens);
      }
      const packed = packSectionIndex({
        url: document.url,
        title: document.title,
        document_id: document.document_id,
        sections: document.sections,
        sectionOffset: offset,
        maxTokens: request.max_tokens,
      });
      return { content: [{ type: 'text', text: packed.text }] };
    }

    if (request.section_ids) {
      const unknown = request.section_ids.filter((id) => !document.sections.some((section) => section.id === id));
      if (unknown.length > 0) {
        return this.mcpJson({
          error: 'invalid_arguments',
          message: 'unknown section_ids',
          unknown,
        }, request.max_tokens);
      }
    }

    const query = request.query ?? '';
    const packed = flattenPackedSource(packBudgetedResponse({
      query,
      contentMode: request.content_mode,
      maxTokens: request.max_tokens,
      sources: [{
        url: document.url,
        title: document.title,
        success: true,
        document_id: document.document_id,
        saved_at: document.saved_at,
        expires_at: document.expires_at,
        data: this.canonicalSourceData(document),
        markdown: document.markdown,
        sections: document.sections,
        ranked: rankDocumentSections(document.sections, query),
      }],
      envelope: { url: document.url, success: true },
      requestedSectionIds: request.section_ids,
      deferFinalize: true,
    }), request.max_tokens, request.section_ids);
    return { content: [{ type: 'text', text: packed.text }] };
  }

  private packScrapedDocument(
    result: ScrapeClientResponse,
    retained: ReturnType<SearXNGMCPServer['retainDocument']>,
    request: { query?: string; max_tokens: number; content_mode: ContentMode },
  ) {
    const query = request.query ?? '';
    const packed = flattenPackedSource(packBudgetedResponse({
      query,
      contentMode: request.content_mode,
      maxTokens: request.max_tokens,
      sources: [{
        url: retained.url,
        title: retained.title,
        success: Boolean(result.success && retained.markdown.trim()),
        error: result.success ? undefined : result.error,
        document_id: retained.document_id,
        read_more_unavailable: retained.read_more_unavailable,
        saved_at: retained.saved_at,
        expires_at: retained.expires_at,
        data: this.canonicalSourceData(retained),
        markdown: retained.markdown,
        sections: retained.sections,
        ranked: rankDocumentSections(retained.sections, query),
      }],
      envelope: {
        success: result.success,
        url: result.url,
        ...(result.error ? { error: result.error } : {}),
      },
    }), request.max_tokens);
    return { content: [{ type: 'text', text: packed.text }] };
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
    const cacheKey = `scrape_url:v2:${normalized}:${(formats || ['markdown']).join(',')}:${timeout}`;
    const cached = await this.cache.get<ScrapeClientResponse>(cacheKey);
    if (cached) return cached;

    const result = await this.getScrapeClient().scrape(url, {
      formats: formats || ['markdown'],
      timeout,
      wait_for: 0,
      proxy_url: process.env.PROXY_URL,
    });

    const wordCount = result.data?.metadata?.word_count || 0;
    const markdown = typeof result.data?.markdown === 'string' ? result.data.markdown.trim() : '';
    if (result.success && (wordCount > 0 || markdown.length > 0)) {
      await this.cache.set(cacheKey, result, URL_SCRAPE_CACHE_TTL_MS);
    }
    return result;
  }

  // ── Tool registration ───────────────────────────────────────────────
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'search_web',
            description: 'Search the web using 4get with SearXNG fallback',
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
                scraper: {
                  type: 'string',
                  description: '4get scraper engine (e.g., "ddg", "google_cse", "startpage", "brave"). Default: "ddg"',
                  default: DEFAULT_FOURGET_SCRAPER,
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
              + 'Depth: "quick" (search snippets only, fastest), "normal" (search + scrape each selected source regardless of snippet length, default), '
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
                  description: 'Research depth: "quick" (search snippets only), "normal" (search + scrape each selected source, default), "deep" (site crawling, future)',
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
                  default: 'relevant_only',
                },
                max_tokens: {
                  type: 'integer',
                  description: 'Maximum o200k_base tokens for the serialized MCP response, including quick, deep, empty, and error replies (default 6000, min 512, max 32000)',
                  default: 6000,
                  minimum: 512,
                  maximum: 32000,
                },
                scraper: {
                  type: 'string',
                  description: '4get scraper engine (e.g., "ddg", "google_cse", "startpage", "brave"). Default: "ddg"',
                  default: DEFAULT_FOURGET_SCRAPER,
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'scrape_url',
            description: 'Scrape a URL using CRW (fast content extraction), or read a saved document by document_id',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to scrape. Exactly one of url or document_id is required.',
                },
                document_id: {
                  type: 'string',
                  description: 'Opaque saved-document id from a prior research or scrape_url response',
                },
                query: {
                  type: 'string',
                  description: 'Select relevant whole sections from the saved or freshly scraped document',
                },
                section_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Return these saved whole sections. Requires document_id. Exclusive with query and list_sections.',
                },
                list_sections: {
                  type: 'boolean',
                  description: 'Return a paginated section index without bodies',
                },
                section_offset: {
                  type: 'integer',
                  description: 'Nonnegative index into the section list when list_sections is true',
                  minimum: 0,
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
                  description: 'Response mode: "full" returns everything if it fits, "relevant_only" strips full markdown, "snippet" returns only key passages with no context',
                  default: 'relevant_only',
                },
                max_tokens: {
                  type: 'integer',
                  description: 'Maximum o200k_base tokens for the serialized MCP response (default 6000, min 512, max 32000)',
                  default: 6000,
                  minimum: 512,
                  maximum: 32000,
                },
              },
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
   * Web search via 4get primary with SearXNG fallback and cached deduplicated results.
   */
  private async handleSearchWeb(args: any) {
    const { query, maxResults, categories, engines, language } = args;
    const scraper = args.scraper || DEFAULT_FOURGET_SCRAPER;

    logger.info(`Searching web (4get primary): ${query}`);

    const limit = Math.min(maxResults || DEFAULT_LIMIT, 50);

    // Check cache — include scraper and result limit in key
    const cacheKey = buildCacheKey('search:primary-fallback:v2', [
      query,
      categories || '',
      engines || '',
      language || 'en',
      scraper,
      limit,
    ]);
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const discovery = await discoverUrls({
      query,
      fourget: this.fourget,
      searxng: this.searxng,
      scraper,
      maxResults: limit,
      minFourgetResults: FOURGET_MIN_RESULTS,
      fourgetTimeoutMs: FOURGET_PRIMARY_TIMEOUT_MS,
      categories,
      engines,
      language: language || 'en',
    });

    logger.info('URL discovery completed', {
      query,
      route: discovery.route,
      fallbackReason: discovery.fallbackReason,
      resultCount: discovery.results.length,
    });

    const response = {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              query,
              total_results: discovery.results.length,
              results: discovery.results.map((result) => ({
                title: result.title,
                url: result.url,
                content: result.content,
                publishedDate: result.publishedDate,
                source: result.source,
              })),
              suggestion: undefined,
              engine_info: {
                route: discovery.route,
                fallback_reason: discovery.fallbackReason,
                sources_consulted: discovery.sourcesConsulted,
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
  }

  /**
   * Scrape a URL or read a saved document. Validation happens before any crawl.
   */
  private async handleScrapeUrl(args: any) {
    const parsed = validateScrapeArgs(args);
    if (!parsed.ok) {
      return this.mcpJson({ error: parsed.error, message: parsed.message }, resolveErrorBudget(args));
    }
    const request = parsed.value;

    if (request.document_id) {
      const lookedUp = this.getDocumentStore().get(request.document_id);
      if (!lookedUp.ok) {
        return this.mcpJson({
          error: 'document_unavailable',
          document_id: request.document_id,
          reason: lookedUp.reason,
          guidance: 'Saved document is missing or expired. Call scrape_url with the original url.',
        }, request.max_tokens);
      }
      return this.packSavedDocument(lookedUp.document, request);
    }

    const url = request.url as string;
    const existing = this.getDocumentStore().getByUrl(url);
    if (existing.ok) {
      return this.packSavedDocument(existing.document, request);
    }

    logger.info(`Scraping with CRW: ${url}`);

    try {
      const result = await this.cachedScrapeUrl(
        url,
        args.formats || ['markdown'],
        args.timeout || 30000
      );
      const markdown = typeof result.data?.markdown === 'string' ? result.data.markdown : '';
      const title = (result.data?.metadata as { title?: string } | undefined)?.title || url;
      if (!result.success || !markdown.trim()) {
        const bounded = boundUpstreamError(
          result.success ? 'Empty extraction' : (result.error || 'scrape_failed'),
        );
        return this.mcpJson({
          success: false,
          url,
          error: bounded.error,
          ...(bounded.diagnostic ? { diagnostic: bounded.diagnostic } : {}),
        }, request.max_tokens);
      }
      const retained = this.retainDocument(url, title, markdown);
      if (request.list_sections) {
        if (!retained.document_id) {
          return this.mcpJson({
            success: true,
            url,
            read_more_unavailable: true,
          }, request.max_tokens);
        }
        return this.packSavedDocument({
          document_id: retained.document_id,
          url: retained.url,
          title: retained.title,
          markdown: retained.markdown,
          sections: retained.sections,
          saved_at: retained.saved_at,
          expires_at: retained.expires_at,
        }, request);
      }
      return this.packScrapedDocument(result, retained, request);
    } catch (error) {
      logger.error('CRW scrape failed:', error);
      return this.mcpJson({
        success: false,
        url,
        error: 'scrape_failed',
      }, request.max_tokens);
    }
  }

  /**
   * Search + scrape workflow: discovers through 4get/SearXNG routing, then
   * scrapes promising URLs with a concurrency-limited worker pool.
   */
  private async handleSearchAndScrape(args: any) {
    const { query, maxResults, mode, scrapeAll, categories, formats, content_mode } = args;
    const contentMode = content_mode || 'full';
    const scraper = args.scraper || DEFAULT_FOURGET_SCRAPER;
    const isDeep = mode === 'deep';
    const perUrlTimeout = isDeep ? DEEP_PER_URL_TIMEOUT_MS : CRAWL_PER_URL_TIMEOUT_MS;
    const batchTimeout = isDeep ? DEEP_BATCH_TIMEOUT_MS : CRAWL_BATCH_TIMEOUT_MS;
    const poolSize = isDeep ? DEEP_POOL_SIZE : CRAWL_POOL_SIZE;

    logger.info(`Search and scrape workflow: ${query}${isDeep ? ' (deep mode)' : ''}`);

    const startTime = Date.now();

    try {
      // 1. Check cache for search results
      const formatKey = (formats || ['markdown']).join(',');
      const cacheKey = buildCacheKey('search_and_scrape:v4', [
        query,
        maxResults || '',
        mode || '',
        scrapeAll || '',
        categories || '',
        formatKey,
        contentMode,
        scraper,
      ]);
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;

      // 2. Discover URLs through 4get first, with SearXNG fallback
      const discovery = await discoverUrls({
        query,
        fourget: this.fourget,
        searxng: this.searxng,
        scraper,
        maxResults: 10,
        minFourgetResults: FOURGET_MIN_RESULTS,
        fourgetTimeoutMs: FOURGET_PRIMARY_TIMEOUT_MS,
        categories,
        language: 'en',
      });

      if (discovery.results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query,
                  search_results: 0,
                  discovery_route: discovery.route,
                  fallback_reason: discovery.fallbackReason,
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
      const topResults = discovery.results.slice(0, limit);

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
                search_results: discovery.numberOfResults,
                discovery_route: discovery.route,
                fallback_reason: discovery.fallbackReason,
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
    const parsed = validateResearchArgs(args);
    if (!parsed.ok) {
      return this.mcpJson({ error: parsed.error, message: parsed.message }, resolveErrorBudget(args));
    }

    const { query, depth, breadth, max_results, categories, formats } = args;
    const contentMode = parsed.value.content_mode;
    const maxTokens = parsed.value.max_tokens;
    const scraper = args.scraper || DEFAULT_FOURGET_SCRAPER;
    const researchDepth = depth || 'normal';
    const researchBreadth = breadth || 'single';

    // Validate depth — deep is not yet implemented
    if (researchDepth === 'deep') {
      return this.mcpJson({
        error: 'Deep research mode (site crawling) is not yet implemented. Use depth: "quick" or depth: "normal".',
        research_metadata: { depth: 'deep', breadth: researchBreadth, pages_scraped: 0, errors: [] },
        results: [],
      }, maxTokens);
    }

    const startTime = Date.now();
    const formatKey = (formats || ['markdown']).join(',');

    // Composite cache key
    const cacheKey = buildCacheKey(RESEARCH_CACHE_PREFIX, [
      query,
      researchDepth,
      researchBreadth,
      max_results || '',
      categories || '',
      formatKey,
      contentMode,
      scraper,
      maxTokens,
    ]);
    const cached = await this.cache.get(cacheKey);
    if (cached && this.cachedDocumentIdsLive(cached)) return cached;

    try {
      // 1. Discover URLs through 4get first, with SearXNG fallback
      const discovery = await discoverUrls({
        query,
        fourget: this.fourget,
        searxng: this.searxng,
        scraper,
        maxResults: 10,
        minFourgetResults: FOURGET_MIN_RESULTS,
        fourgetTimeoutMs: FOURGET_PRIMARY_TIMEOUT_MS,
        categories,
        language: 'en',
      });

      if (discovery.results.length === 0) {
        return this.mcpJson({
          query,
          number_of_results: 0,
          unresponsive_engines: discovery.unresponsiveEngines,
          research_metadata: {
            depth: researchDepth,
            breadth: researchBreadth,
            discovery_route: discovery.route,
            fallback_reason: discovery.fallbackReason,
            pages_scraped: 0,
            errors: [],
          },
          results: [],
        }, maxTokens);
      }

      // 2. Determine result count
      const defaultMaxResults = researchBreadth === 'single' ? RESEARCH_MAX_RESULTS_SINGLE : RESEARCH_MAX_RESULTS_MULTI;
      const resultLimit = Math.min(max_results || defaultMaxResults, 10);
      const topResults = discovery.results.slice(0, resultLimit);

      // 3. Dispatch by depth
      if (researchDepth === 'quick') {
        return this.handleQuickResearch(query, researchBreadth, topResults, contentMode,
          discovery.numberOfResults, discovery.unresponsiveEngines, startTime,
          discovery.route, discovery.fallbackReason, maxTokens);
      }

      // depth === 'normal' — scrape + whole-section budget packing
      return this.handleNormalResearch(query, researchBreadth, topResults, contentMode, formats,
        discovery.numberOfResults, discovery.unresponsiveEngines, startTime, cacheKey,
        discovery.route, discovery.fallbackReason, maxTokens);
    } catch (error) {
      logger.error('Research workflow failed:', error);
      return this.mcpJson({ error: 'research_failed' }, maxTokens);
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
    discoveryRoute: string,
    fallbackReason?: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
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

    const packed = packQuickResearch({
      envelope: {
        query,
        number_of_results: numberOfResults,
        unresponsive_engines: unresponsiveEngines,
        research_metadata: {
          depth: 'quick' as const,
          breadth: breadth,
          discovery_route: discoveryRoute,
          fallback_reason: fallbackReason,
          pages_scraped: 0,
          errors: [],
        },
        elapsed_ms: Date.now() - startTime,
      },
      results,
      maxTokens,
    });
    return { content: [{ type: 'text', text: packed.text }] };
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
    discoveryRoute: string,
    fallbackReason?: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ) {
    // Determine how many URLs to scrape
    const urlsToScrapeCount = breadth === 'multi'
      ? Math.min(topResults.length, 5)
      : Math.min(topResults.length, 3);

    type SelectedSource = {
      url: string;
      title: string;
      snippet: string;
    };

    const selected: SelectedSource[] = topResults.slice(0, urlsToScrapeCount).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
    }));
    const urlsToScrape = selected;

    logger.info(`Research (normal): scraping ${urlsToScrape.length} URLs`);

    const poolSize = RESEARCH_NORMAL_POOL_SIZE;
    const settledByIndex: PromiseSettledResult<ScrapeClientResponse>[] = [];

    for (let i = 0; i < urlsToScrape.length; i += poolSize) {
      const batch = urlsToScrape.slice(i, i + poolSize);
      const batchResults = await Promise.allSettled(
        batch.map((entry) => this.scrapeSingleUrl(entry.url, RESEARCH_SCRAPE_TIMEOUT_MS, false, formats))
      );
      settledByIndex.push(...batchResults);
    }

    type PackSource = Parameters<typeof packBudgetedResponse>[0]['sources'][number];
    const packSources: PackSource[] = [];
    const errors: Array<{ url: string; error: string }> = [];

    const pushFailure = (entry: SelectedSource, errMsg: string) => {
      errors.push({ url: entry.url, error: errMsg });
      packSources.push({
        url: entry.url,
        title: entry.title,
        snippet: entry.snippet,
        source_type: 'snippet',
        success: false,
        error: errMsg,
        sections: [],
        ranked: [],
      });
    };

    for (let index = 0; index < selected.length; index++) {
      const entry = selected[index];
      const settled = settledByIndex[index];
      if (!settled) {
        pushFailure(entry, 'Scrape failed');
        continue;
      }

      if (settled.status === 'rejected') {
        pushFailure(entry, settled.reason?.message || 'Scrape failed');
        continue;
      }

      const scrapeData = settled.value.data;
      const wordCount = scrapeData?.metadata?.word_count || 0;
      const markdown = typeof scrapeData?.markdown === 'string' ? scrapeData.markdown.trim() : '';
      const extracted = wordCount > 0 || markdown.length > 0;

      if (!settled.value.success || !extracted) {
        pushFailure(
          entry,
          settled.value.success ? 'Empty extraction' : (settled.value.error || 'Scrape failed'),
        );
        continue;
      }

      const originalMarkdown = typeof scrapeData?.markdown === 'string' ? scrapeData.markdown : markdown;
      const retained = this.retainDocument(entry.url, entry.title, originalMarkdown);
      packSources.push({
        url: retained.url,
        title: retained.title,
        snippet: entry.snippet,
        source_type: 'scraped',
        success: true,
        document_id: retained.document_id,
        read_more_unavailable: retained.read_more_unavailable,
        saved_at: retained.saved_at,
        expires_at: retained.expires_at,
        data: this.canonicalSourceData(retained),
        markdown: retained.markdown,
        sections: retained.sections,
        ranked: rankDocumentSections(retained.sections, query),
      });
    }

    const store = this.getDocumentStore();
    for (const source of packSources) {
      if (source.document_id && !store.has(source.document_id)) {
        source.document_id = undefined;
        source.read_more_unavailable = true;
      }
    }

    const packed = packBudgetedResponse({
      query,
      contentMode,
      maxTokens,
      sources: packSources,
      envelope: {
        query,
        number_of_results: numberOfResults,
        unresponsive_engines: unresponsiveEngines,
        research_metadata: {
          depth: 'normal' as const,
          breadth,
          discovery_route: discoveryRoute,
          fallback_reason: fallbackReason,
          pages_scraped: packSources.filter((source) => source.success && source.source_type === 'scraped').length,
          errors,
        },
        elapsed_ms: Date.now() - startTime,
      },
    });
    const response = { content: [{ type: 'text', text: packed.text }] };

    if (errors.length === 0 && !('error' in packed.payload)) {
      await this.cache.set(cacheKey, response, COMPOSITE_CACHE_TTL_MS);
    }
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

function isDirectCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectCli()) {
  const server = new SearXNGMCPServer();
  server.run().catch(console.error);
}
