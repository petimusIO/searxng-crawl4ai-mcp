import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Optional network transports (dynamically imported when enabled)
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import FirecrawlApp from '@mendable/firecrawl-js';
import { config } from 'dotenv';
import { createProxyAgent } from './proxy-agent.js';
import { logger } from './logger.js';
import { SearXNGClient } from './searxng-client.js';
import { Crawl4AIClient } from './crawl4ai-client.js';
import express from 'express';
import http from 'http';
config();

export class FirecrawlMCPServer {
  private server: Server;
  private firecrawl: FirecrawlApp;
  private searxng: SearXNGClient;
  private crawl4ai: Crawl4AIClient;
  private proxyAgent: any;

  // HTTP/SSE support for running MCP as a network service
  private expressApp?: express.Application;
  private httpServer?: http.Server;
  private sseTransports = new Map<string, any>();

  constructor() {
    this.server = new Server(
      {
        name: 'firecrawl-mcp-custom',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize proxy agent
    this.proxyAgent = createProxyAgent(process.env.PROXY_URL);
    
    // Initialize Firecrawl with proxy support (use a stub if API key is missing)
    if (process.env.FIRECRAWL_API_KEY) {
      this.firecrawl = new FirecrawlApp({
        apiKey: process.env.FIRECRAWL_API_KEY || '',
        apiUrl: process.env.FIRECRAWL_API_URL || 'http://localhost:3002',
      });
    } else {
      // Start with a minimal stub so the MCP server can boot without a Firecrawl API key.
      // The stub throws a clear error when any scraping method is invoked.
      logger.warn('FIRECRAWL_API_KEY not set — Firecrawl features will fail until configured');
      this.firecrawl = {
        scrape: async () => { throw new Error('FIRECRAWL_API_KEY not set'); },
        batchScrape: async () => { throw new Error('FIRECRAWL_API_KEY not set'); },
        crawl: async () => { throw new Error('FIRECRAWL_API_KEY not set'); },
        extract: async () => { throw new Error('FIRECRAWL_API_KEY not set'); },
        getCrawlStatus: async () => { throw new Error('FIRECRAWL_API_KEY not set'); },
      } as any;
    }

    // Initialize SearXNG client
    this.searxng = new SearXNGClient(process.env.SEARXNG_URL || 'http://localhost:8081');
    
    // Initialize Crawl4AI client
    this.crawl4ai = new Crawl4AIClient(process.env.CRAWL4AI_URL || 'http://localhost:8001');

    this.setupToolHandlers();

    // Emit non-sensitive startup environment details to help debugging restarts
    logger.info('mcp:startup', {
      pid: process.pid,
      node: process.version,
      searxngUrl: process.env.SEARXNG_URL || null,
      crawl4aiUrl: process.env.CRAWL4AI_URL || null,
      firecrawlConfigured: !!process.env.FIRECRAWL_API_KEY,
      proxyConfigured: !!process.env.PROXY_URL,
      mcpMode: !!process.env.MCP_MODE,
      env: process.env.NODE_ENV || 'development',
    });

    // --- optional HTTP + SSE server so MCP can be reached by other services (Coolify) ---
    try {
      const port = Number(process.env.MCP_HTTP_PORT || process.env.MCP_PORT || 3003);
      const app = express();
      app.use(express.json({ limit: '1mb' }));

      // lightweight token middleware (optional)
      const token = process.env.MCP_INTERNAL_TOKEN;
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

      // health endpoint
      app.get('/health', async (req, res) => {
        const searx = await this.searxng.healthCheck().catch(() => false);
        const crawl4ai = await this.crawl4ai.healthCheck().catch(() => false);
        return res.status(200).json({ ok: true, searxng: searx, crawl4ai });
      });

      // SSE acceptor — creates a transport for every incoming SSE connection
      app.get(['/mcp/sse', '/sse'], async (req, res) => {
        try {
          const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
          const endpoint = process.env.MCP_SSE_PATH || '/mcp/sse';
          const transport = new SSEServerTransport(endpoint, res as any);

          // start() attaches to the response and defines a sessionId
          await transport.start();

          // register transport so POST messages can be routed to it
          this.sseTransports.set(String(transport.sessionId), transport);

          transport.onclose = () => {
            logger.info('mcp:http:sse:closed', { sessionId: transport.sessionId });
            this.sseTransports.delete(String(transport.sessionId));
          };

          await this.server.connect(transport);
          logger.info('mcp:http:sse:connected', { sessionId: transport.sessionId });
        } catch (err) {
          logger.error('mcp:http:sse:error', { message: String(err) });
          res.status(500).end();
        }
      });

      // POST handler used by SSE clients to send messages back to server
      app.post(['/mcp/sse', '/sse', '/mcp/sse/:sessionId'], async (req, res) => {
        const sessionId = (req.params.sessionId || req.query.sessionId || req.headers['x-session-id']);
        const transport = sessionId ? this.sseTransports.get(String(sessionId)) : undefined;
        if (!transport) return res.status(404).json({ ok: false, error: 'session not found' });

        try {
          await transport.handlePostMessage(req as any, res as any);
        } catch (err) {
          logger.error('mcp:http:sse:post:error', { message: String(err) });
          res.status(500).json({ ok: false, error: 'post error' });
        }
      });

      // Optional: simple HTTP proxy to call a subset of tools directly (convenience for non-MCP clients)
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
              return res.json({ ok: true, result: await this.handleCrawl4AIScrape(args) });
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

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'scrape_url',
            description: 'Scrape content from a single URL using proxy rotation',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to scrape',
                },
                options: {
                  type: 'object',
                  properties: {
                    formats: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Output formats (markdown, html, rawHtml, links, screenshot)',
                      default: ['markdown']
                    },
                    waitFor: {
                      type: 'number',
                      description: 'Wait time in milliseconds',
                      default: 0
                    },
                    timeout: {
                      type: 'number',
                      description: 'Timeout in milliseconds',
                      default: 30000
                    }
                  }
                }
              },
              required: ['url'],
            },
          },
          {
            name: 'batch_scrape',
            description: 'Scrape multiple URLs in batch using proxy rotation',
            inputSchema: {
              type: 'object',
              properties: {
                urls: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of URLs to scrape',
                },
                options: {
                  type: 'object',
                  properties: {
                    formats: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Output formats',
                      default: ['markdown']
                    },
                    concurrency: {
                      type: 'number',
                      description: 'Number of concurrent requests',
                      default: 3
                    }
                  }
                }
              },
              required: ['urls'],
            },
          },
          {
            name: 'crawl_website',
            description: 'Crawl a website starting from a base URL',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The base URL to start crawling from',
                },
                options: {
                  type: 'object',
                  properties: {
                    limit: {
                      type: 'number',
                      description: 'Maximum number of pages to crawl',
                      default: 10
                    },
                    maxDepth: {
                      type: 'number',
                      description: 'Maximum crawl depth',
                      default: 2
                    },
                    includePaths: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Paths to include in crawl'
                    },
                    excludePaths: {
                      type: 'array', 
                      items: { type: 'string' },
                      description: 'Paths to exclude from crawl'
                    }
                  }
                }
              },
              required: ['url'],
            },
          },
          {
            name: 'map_website',
            description: 'Get a complete list of URLs from a website (like sitemap discovery)',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The website URL to map',
                },
                options: {
                  type: 'object',
                  properties: {
                    search: {
                      type: 'string',
                      description: 'Search term to filter URLs'
                    },
                    limit: {
                      type: 'number',
                      description: 'Maximum number of URLs to return',
                      default: 5000
                    },
                    ignoreSitemap: {
                      type: 'boolean',
                      description: 'Ignore sitemap and crawl manually',
                      default: false
                    }
                  }
                }
              },
              required: ['url'],
            },
          },
          {
            name: 'extract_structured_data',
            description: 'Extract specific structured data from a webpage using AI prompts',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to extract data from',
                },
                prompt: {
                  type: 'string',
                  description: 'AI prompt describing what data to extract',
                },
                schema: {
                  type: 'object',
                  description: 'JSON schema for the expected output structure',
                }
              },
              required: ['url', 'prompt'],
            },
          },
          {
            name: 'get_crawl_status',
            description: 'Check the status of a crawl job by ID',
            inputSchema: {
              type: 'object',
              properties: {
                jobId: {
                  type: 'string',
                  description: 'The crawl job ID to check',
                }
              },
              required: ['jobId'],
            },
          },
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
                options: {
                  type: 'object',
                  properties: {
                    engines: {
                      type: 'string',
                      description: 'Comma-separated list of engines (e.g., "google,bing")'
                    },
                    categories: {
                      type: 'string',
                      description: 'Search categories (general, images, news, etc.)'
                    },
                    language: {
                      type: 'string',
                      description: 'Search language (en, es, fr, etc.)',
                      default: 'en'
                    },
                    limit: {
                      type: 'number',
                      description: 'Number of results page (pageno)',
                      default: 1
                    }
                  }
                }
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
                options: {
                  type: 'object',
                  properties: {
                    max_results: {
                      type: 'number',
                      description: 'Maximum number of search results to scrape',
                      default: 3
                    },
                    engines: {
                      type: 'string',
                      description: 'Search engines to use'
                    },
                    scrape_formats: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Formats for scraped content',
                      default: ['markdown']
                    }
                  }
                }
              },
              required: ['query'],
            },
          },
          {
            name: 'crawl4ai_scrape',
            description: 'Scrape a URL using Crawl4AI (better than Firecrawl for self-hosted)',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'The URL to scrape',
                },
                options: {
                  type: 'object',
                  properties: {
                    formats: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Output formats',
                      default: ['markdown']
                    },
                    wait_for: {
                      type: 'number',
                      description: 'Wait time in milliseconds',
                      default: 0
                    },
                    timeout: {
                      type: 'number',
                      description: 'Timeout in milliseconds',
                      default: 30000
                    }
                  }
                }
              },
              required: ['url'],
            },
          }
        ] as Tool[],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const start = Date.now();
      const argsSummary = (() => {
        try { return JSON.stringify(args).slice(0, 1024); } catch { return '<unserializable>'; }
      })();

      logger.info('mcp:tool:request', { tool: name, argsSummary, pid: process.pid });

      try {
        let result: any;

        switch (name) {
          case 'scrape_url':
            result = await this.handleScrapeUrl(args);
            break;
          case 'batch_scrape':
            result = await this.handleBatchScrape(args);
            break;
          case 'crawl_website':
            result = await this.handleCrawlWebsite(args);
            break;
          case 'map_website':
            result = await this.handleMapWebsite(args);
            break;
          case 'extract_structured_data':
            result = await this.handleExtractStructuredData(args);
            break;
          case 'get_crawl_status':
            result = await this.handleGetCrawlStatus(args);
            break;
          case 'search_web':
            result = await this.handleSearchWeb(args);
            break;
          case 'search_and_scrape':
            result = await this.handleSearchAndScrape(args);
            break;
          case 'crawl4ai_scrape':
            result = await this.handleCrawl4AIScrape(args);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        const duration = Date.now() - start;
        logger.info('mcp:tool:response', { tool: name, durationMs: duration, resultContentBlocks: Array.isArray(result?.content) ? result.content.length : undefined });
        return result;
      } catch (error: any) {
        const duration = Date.now() - start;
        logger.error(`Error executing tool ${name}:`, {
          message: error?.message || String(error),
          stack: error?.stack,
          durationMs: duration,
          argsSummary,
        });
        throw error;
      }
    });
  }

  private async handleScrapeUrl(args: any) {
    const { url, options = {} } = args;
    
    logger.info(`Scraping URL: ${url}`);
    
    const scrapeOptions = {
      formats: options.formats || ['markdown'],
      waitFor: options.waitFor || 0,
      timeout: options.timeout || 30000,
    };

    const result = await this.firecrawl.scrape(url, scrapeOptions);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleBatchScrape(args: any) {
    const { urls, options = {} } = args;
    
    logger.info(`Batch scraping ${urls.length} URLs`);
    
    const batchOptions = {
      formats: options.formats || ['markdown'],
    };

    const results = await (this.firecrawl as any).batchScrape(urls, batchOptions);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  private async handleCrawlWebsite(args: any) {
    const { url, options = {} } = args;
    
    logger.info(`Crawling website: ${url}`);
    
    const crawlOptions = {
      limit: options.limit || 10,
      maxDepth: options.maxDepth || 2,
      includePaths: options.includePaths || [],
      excludePaths: options.excludePaths || [],
      scrapeOptions: {
        formats: ['markdown']
      }
    };

    const result = await (this.firecrawl as any).crawl(url, crawlOptions);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleMapWebsite(args: any) {
    const { url, options = {} } = args;
    
    logger.info(`Mapping website: ${url}`);
    
    const mapOptions: any = {};
    
    if (options.search) {
      mapOptions.search = options.search;
    }
    
    if (options.limit) {
      mapOptions.limit = options.limit;
    }
    
    if (options.ignoreSitemap) {
      mapOptions.ignoreSitemap = options.ignoreSitemap;
    }

    const result = await (this.firecrawl as any).map(url, mapOptions);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleExtractStructuredData(args: any) {
    const { url, prompt, schema } = args;
    
    logger.info(`Extracting structured data from: ${url}`);
    
    const extractOptions: any = {
      prompt: prompt,
    };
    
    if (schema) {
      extractOptions.schema = schema;
    }

    const result = await (this.firecrawl as any).extract(url, extractOptions);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleGetCrawlStatus(args: any) {
    const { jobId } = args;
    
    logger.info(`Checking crawl status for job: ${jobId}`);

    const result = await (this.firecrawl as any).getCrawlStatus(jobId);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleSearchWeb(args: any) {
    const { query, options = {} } = args;
    const start = Date.now();

    logger.info('mcp:handler:search_web:start', { query, options });

    try {
      const result = await this.searxng.search(query, {
        engines: options.engines,
        categories: options.categories,
        language: options.language || 'en',
        pageno: options.limit || 1,
        format: 'json'
      });

      const duration = Date.now() - start;
      logger.info('mcp:handler:search_web:finish', { query, resultCount: result?.results?.length ?? 0, durationMs: duration });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query: result.query,
              total_results: result.number_of_results,
              results: result.results.map(r => ({
                title: r.title,
                url: r.url,
                content: r.content,
                publishedDate: r.publishedDate
              })),
              suggestions: result.suggestions,
              engine_info: {
                unresponsive: result.unresponsive_engines
              }
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      const duration = Date.now() - start;
      logger.error('SearXNG search failed:', { message: error?.message, stack: error?.stack, durationMs: duration });
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSearchAndScrape(args: any) {
    const { query, options = {} } = args;
    const start = Date.now();

    logger.info('mcp:handler:search_and_scrape:start', { query, options });

    try {
      // First, search with SearXNG
      const searchResults = await this.searxng.search(query, {
        engines: options.engines,
        language: 'en',
        format: 'json'
      });
      
      if (!searchResults.results || searchResults.results.length === 0) {
        const durationEmpty = Date.now() - start;
        logger.info('mcp:handler:search_and_scrape:empty', { query, durationMs: durationEmpty });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query,
                search_results: 0,
                scraped_results: [],
                message: 'No search results found'
              }, null, 2),
            },
          ],
        };
      }
      
      // Get top URLs to scrape
      const maxResults = Math.min(options.max_results || 3, 5);
      const topUrls = searchResults.results.slice(0, maxResults).map(r => r.url);
      
      logger.info('mcp:handler:search_and_scrape:scrape_start', { query, topUrlsCount: topUrls.length });
      
      // Scrape the results
      const scrapeResults = await this.crawl4ai.batchScrape(topUrls, {
        formats: options.scrape_formats || ['markdown'],
        concurrency: 2
      });

      const duration = Date.now() - start;
      logger.info('mcp:handler:search_and_scrape:finish', { query, scrapedCount: scrapeResults.results.filter((r: any) => r.success).length, durationMs: duration });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query,
              search_results: searchResults.number_of_results,
              scraped_count: scrapeResults.results.filter(r => r.success).length,
              results: scrapeResults.results.map((scrapeResult, index) => ({
                search_info: {
                  title: searchResults.results[index]?.title,
                  url: scrapeResult.url,
                  snippet: searchResults.results[index]?.content
                },
                scraped_content: scrapeResult.success ? scrapeResult.data : { error: scrapeResult.error },
                success: scrapeResult.success
              }))
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      const duration = Date.now() - start;
      logger.error('Search and scrape workflow failed:', { message: error?.message, stack: error?.stack, durationMs: duration });
      throw new Error(`Search and scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCrawl4AIScrape(args: any) {
    const { url, options = {} } = args;
    const start = Date.now();

    logger.info('mcp:handler:crawl4ai_scrape:start', { url, options });

    try {
      const result = await this.crawl4ai.scrape(url, {
        formats: options.formats || ['markdown'],
        wait_for: options.wait_for || 0,
        timeout: options.timeout || 30000,
        proxy_url: process.env.PROXY_URL
      });

      const duration = Date.now() - start;
      logger.info('mcp:handler:crawl4ai_scrape:finish', { url, durationMs: duration });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      const duration = Date.now() - start;
      logger.error('Crawl4AI scrape failed:', { message: error?.message, stack: error?.stack, durationMs: duration });
      throw new Error(`Crawl4AI scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SearXNG + Crawl4AI MCP Server started with proxy support');
  }
}

const server = new FirecrawlMCPServer();

// Process lifecycle hooks — emit extra diagnostic logs so Coolify restarts are traceable
process.on('SIGTERM', () => {
  logger.warn('process:SIGTERM received — shutting down gracefully');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.warn('process:SIGINT received — shutting down gracefully');
  process.exit(0);
});
process.on('uncaughtException', (err: Error) => {
  logger.error('process:uncaughtException', { message: err.message, stack: err.stack });
  // exit to surface restart cause in container logs
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('process:unhandledRejection', { reason: String(reason) });
});

// Periodic memory/health diagnostics to help track OOMs / restarts
setInterval(() => {
  const m = process.memoryUsage();
  logger.info('process:mem', { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external });
}, 60_000);

server.run().catch((err) => {
  logger.error('MCP server failed to start', { message: err?.message || String(err), stack: err?.stack });
  process.exit(1);
});