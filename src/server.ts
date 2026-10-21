import { withSearchTiming } from './search-timing.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';
import { SearXNGClient } from './searxng-client.js';
import { FourgetClient } from './fourget-client.js';
import { RedisCache } from './redis-cache.js';
import { WebSearchTool } from './tools/websearch.js';
import { WebFetchTool } from './tools/webfetch.js';
import express from 'express';
import http from 'http';

export class SearXNGMCPServer {
  private server: Server;
  private searxng: SearXNGClient;
  private fourget: FourgetClient;
  private cache: RedisCache;
  private websearch: WebSearchTool;
  private webfetch: WebFetchTool;
  // network server state (optional)
  private expressApp?: express.Application;
  private httpServer?: http.Server;
  private sseSessions = new Map<string, { transport: any; server: Server }>();

  constructor() {
    this.server = this.createSdkServer();

    // Initialize clients
    this.searxng = new SearXNGClient(process.env.SEARXNG_URL || 'http://localhost:8081');
    this.fourget = new FourgetClient(process.env.FOURGET_URL || 'http://localhost:8090');
    this.cache = new RedisCache(process.env.REDIS_URL);

    this.websearch = new WebSearchTool(this.searxng, this.fourget, this.cache);
    this.webfetch = new WebFetchTool(this.cache);
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
        const crw = await this.webfetch.healthCheck().catch(() => false);
        return res.status(200).json({ ok: true, searxng: searx, fourget: fourget, crw: crw });
      });

      app.get(['/mcp/sse', '/sse'], async (_req, res) => {
        let sessionId = '';
        try {
          const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
          const endpoint = process.env.MCP_SSE_PATH || '/mcp/sse';
          const transport = new SSEServerTransport(endpoint, res as any);
          sessionId = String(transport.sessionId);

          // Each external SSE client gets its own SDK Server. One shared
          // Server.connect() cannot multiplex independent initialize/tool
          // sessions. Handlers and provider/cache clients stay on `this`.
          const sessionServer = this.createSdkServer();
          this.setupToolHandlers(sessionServer);

          const dropSession = () => {
            if (!this.sseSessions.has(sessionId)) return;
            this.sseSessions.delete(sessionId);
            logger.info('mcp:http:sse:closed', { sessionId });
          };
          sessionServer.onclose = dropSession;
          sessionServer.onerror = (error) => {
            logger.error('mcp:http:sse:session-error', { sessionId, message: String(error) });
            dropSession();
          };

          this.sseSessions.set(sessionId, { transport, server: sessionServer });
          await sessionServer.connect(transport);
          logger.info('mcp:http:sse:connected', { sessionId });
        } catch (err) {
          if (sessionId) this.sseSessions.delete(sessionId);
          logger.error('mcp:http:sse:error', { message: String(err) });
          if (!res.headersSent) res.status(500).end();
        }
      });

      app.post(['/mcp/sse', '/sse', '/mcp/sse/:sessionId'], async (req, res) => {
        const sessionId = req.params.sessionId || req.query.sessionId || req.headers['x-session-id'];
        const session = sessionId ? this.sseSessions.get(String(sessionId)) : undefined;
        const transport = session?.transport;
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

        const timedCall = <T>(work: () => Promise<T>) => withSearchTiming(req.body?._meta, toolName, work);
        try {
          switch (toolName) {
            case 'websearch':
              return res.json({ ok: true, result: await timedCall(() => this.websearch.handle(args)) });
            case 'webfetch':
              return res.json({ ok: true, result: await timedCall(() => this.webfetch.handle(args)) });
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

  private createSdkServer() {
    return new Server(
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
  }

  // ── Tool registration ───────────────────────────────────────────────
  private setupToolHandlers(target: Server = this.server) {
    target.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'websearch',
            description: 'Search snippets using 4get with SearXNG fallback; never fetches source pages. Use categories=images only for explicit image discovery. Choose webfetch on a result URL for fetched evidence.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query',
                },
                max_tokens: { type: 'integer', default: 6000, minimum: 512, maximum: 32000 },
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
                  description: '4get scraper engine (e.g., "ddg", "google_cse", "startpage", "brave"). Defaults: "ddg" for web and news',
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
            name: 'webfetch',
            description: 'Fetch one model-chosen URL as Markdown evidence, or read saved sections by document_id without fetching again. Does not search or discover URLs.',
            inputSchema: {
              type: 'object',
              oneOf: [{ required: ['url'], not: { required: ['document_id'] } }, { required: ['document_id'], not: { required: ['url'] } }],
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to scrape. Exactly one of url or document_id is required.',
                },
                document_id: {
                  type: 'string',
                  description: 'Opaque saved-document id from a prior webfetch response',
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
                  default: 'full',
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

    target.setRequestHandler(CallToolRequestSchema, async (request) => withSearchTiming(request.params._meta, request.params.name, async () => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'websearch':
            return await this.websearch.handle(args);
          case 'webfetch':
            return await this.webfetch.handle(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        logger.error(`Error executing tool ${name}:`, error);
        throw error;
      }
    }));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SearXNG + CRW MCP Server started');
  }
}
