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
import { Crawl4AIClient } from './crawl4ai-client.js';
import express from 'express';
import http from 'http';

config();

export class SearXNGMCPServer {
  private server: Server;
  private searxng: SearXNGClient;
  private crawl4ai: Crawl4AIClient;
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
    
    // Initialize Crawl4AI client
    this.crawl4ai = new Crawl4AIClient(process.env.CRAWL4AI_URL || 'http://localhost:8001');

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
        const crawl = await this.crawl4ai.healthCheck().catch(() => false);
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

      try {
        switch (name) {
          case 'search_web':
            return await this.handleSearchWeb(args);
          case 'search_and_scrape':
            return await this.handleSearchAndScrape(args);
          case 'crawl4ai_scrape':
            return await this.handleCrawl4AIScrape(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        logger.error(`Error executing tool ${name}:`, error);
        throw error;
      }
    });
  }

  private async handleSearchWeb(args: any) {
    const { query, options = {} } = args;
    
    logger.info(`Searching web with SearXNG: ${query}`);
    
    try {
      const result = await this.searxng.search(query, {
        engines: options.engines,
        categories: options.categories,
        language: options.language || 'en',
        pageno: options.limit || 1,
        format: 'json'
      });
      
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
    } catch (error) {
      logger.error('SearXNG search failed:', error);
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSearchAndScrape(args: any) {
    const { query, options = {} } = args;
    
    logger.info(`Search and scrape workflow: ${query}`);
    
    try {
      // First, search with SearXNG
      const searchResults = await this.searxng.search(query, {
        engines: options.engines,
        language: 'en',
        format: 'json'
      });
      
      if (!searchResults.results || searchResults.results.length === 0) {
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
      
      logger.info(`Scraping top ${topUrls.length} results with Crawl4AI`);
      
      // Scrape the results
      const scrapeResults = await this.crawl4ai.batchScrape(topUrls, {
        formats: options.scrape_formats || ['markdown'],
        concurrency: 2
      });
      
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
    } catch (error) {
      logger.error('Search and scrape workflow failed:', error);
      throw new Error(`Search and scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleCrawl4AIScrape(args: any) {
    const { url, options = {} } = args;
    
    logger.info(`Scraping with Crawl4AI: ${url}`);
    
    try {
      const result = await this.crawl4ai.scrape(url, {
        formats: options.formats || ['markdown'],
        wait_for: options.wait_for || 0,
        timeout: options.timeout || 30000,
        proxy_url: process.env.PROXY_URL
      });
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Crawl4AI scrape failed:', error);
      throw new Error(`Crawl4AI scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('SearXNG + Crawl4AI MCP Server started');
  }
}

const server = new SearXNGMCPServer();
server.run().catch(console.error);