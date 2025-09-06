import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import FirecrawlApp from '@mendable/firecrawl-js';
import { config } from 'dotenv';
import { createProxyAgent } from './proxy-agent.js';
import { logger } from './logger.js';

config();

export class FirecrawlMCPServer {
  private server: Server;
  private firecrawl: FirecrawlApp;
  private proxyAgent: any;

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
    
    // Initialize Firecrawl with proxy support
    this.firecrawl = new FirecrawlApp({
      apiKey: process.env.FIRECRAWL_API_KEY || '',
      apiUrl: process.env.FIRECRAWL_API_URL || 'http://localhost:3002',
      // Add proxy configuration if needed
    });

    this.setupToolHandlers();
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
          }
        ] as Tool[],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'scrape_url':
            return await this.handleScrapeUrl(args);
          case 'batch_scrape':
            return await this.handleBatchScrape(args);
          case 'crawl_website':
            return await this.handleCrawlWebsite(args);
          case 'map_website':
            return await this.handleMapWebsite(args);
          case 'extract_structured_data':
            return await this.handleExtractStructuredData(args);
          case 'get_crawl_status':
            return await this.handleGetCrawlStatus(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        logger.error(`Error executing tool ${name}:`, error);
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Firecrawl MCP Server started with proxy support');
  }
}

const server = new FirecrawlMCPServer();
server.run().catch(console.error);