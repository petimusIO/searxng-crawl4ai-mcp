import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const server = new Server(
  {
    name: 'searxng-crawl4ai',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Simple HTTP clients - no complex initialization
const searxngUrl = 'http://localhost:8081';
const scrapeUrl = process.env.SPIDER_URL || 'http://localhost:8002';

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_web',
        description: 'Search the web using SearXNG - fast self-hosted search',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query'
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of results to return',
              default: 10
            }
          },
          required: ['query']
        }
      },
      {
        name: 'crawl4ai_scrape',
        description: 'Scrape webpage content using Spider',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to scrape'
            },
            formats: {
              type: 'array',
              items: { type: 'string' },
              description: 'Output formats (markdown, html, links)',
              default: ['markdown']
            },
            content_filter: {
              type: 'string',
              enum: ['pruning', 'bm25', 'chain', 'none'],
              description: 'Content filter type. "pruning" uses dynamic threshold to keep important content; "bm25" uses BM25 scoring against filter_query; "none" disables filtering.',
              default: 'none'
            },
            filter_query: {
              type: 'string',
              description: 'Query string for content filtering (used with pruning or bm25 filter). For pruning, ranks content by relevance to this query. For BM25, scores content by keyword match.'
            },
            http_mode: {
              type: 'string',
              enum: ['auto', 'http', 'browser'],
              description: 'HTTP mode: auto = HTTP first, fallback to browser; http = only HTTP; browser = always browser',
              default: 'auto'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'search_and_scrape',
        description: 'Search and scrape top results in one operation',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query'
            },
            maxResults: {
              type: 'number',
              description: 'Number of top results to scrape',
              default: 3
            },
            content_filter: {
              type: 'string',
              enum: ['pruning', 'bm25', 'chain', 'none'],
              description: 'Content filter type for scraped pages. "chain" runs pruning then BM25 for smallest, most relevant output.',
              default: 'chain'
            },
            filter_query: {
              type: 'string',
              description: 'Query string for content filtering. Defaults to the search query if not provided.'
            },
            http_mode: {
              type: 'string',
              enum: ['auto', 'http', 'browser'],
              description: 'HTTP mode: auto = HTTP first, fallback to browser; http = only HTTP; browser = always browser',
              default: 'auto'
            }
          },
          required: ['query']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'search_web') {
      const response = await axios.get(`${searxngUrl}/search`, {
        params: {
          q: args.query,
          format: 'json',
          safesearch: 0
        },
        timeout: 10000
      });

      const results = response.data.results || [];
      const limitedResults = results.slice(0, args.maxResults || 10);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: args.query,
              resultCount: limitedResults.length,
              results: limitedResults
            }, null, 2)
          }
        ]
      };

    } else if (name === 'crawl4ai_scrape') {
      const crawlBody = {
        url: args.url,
        formats: args.formats || ['markdown'],
      };
      if (args.content_filter && args.content_filter !== 'none') {
        crawlBody.content_filter = args.content_filter;
        crawlBody.filter_query = args.filter_query || args.query || '';
      }

      const response = await axios.post(`${scrapeUrl}/scrape`, crawlBody, {
        timeout: 35000
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: args.url,
              data: response.data.data
            }, null, 2)
          }
        ]
      };

    } else if (name === 'search_and_scrape') {
      // Search first
      const searchResponse = await axios.get(`${searxngUrl}/search`, {
        params: {
          q: args.query,
          format: 'json'
        },
        timeout: 10000
      });

      const results = searchResponse.data.results || [];
      const topUrls = results.slice(0, args.maxResults || 3).map(r => r.url);

      // Scrape top results
      const scrapePromises = topUrls.map(async (url) => {
        try {
          const scrapeBody = {
            url,
            formats: ['markdown'],
          };
          const cf = args.content_filter || 'chain';
          if (cf !== 'none') {
            scrapeBody.content_filter = cf;
            scrapeBody.filter_query = args.filter_query || args.query;
          }

          const response = await axios.post(`${scrapeUrl}/scrape`, scrapeBody, { timeout: 20000 });
          
          return {
            url,
            success: true,
            data: response.data.data
          };
        } catch (error) {
          return {
            url,
            success: false,
            error: error.message
          };
        }
      });

      const scrapeResults = await Promise.all(scrapePromises);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: args.query,
              searchResults: results.length,
              scrapeResults
            }, null, 2)
          }
        ]
      };

    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            tool: name
          }, null, 2)
        }
      ],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Only log to stderr in non-MCP mode
  if (!process.env.MCP_MODE) {
    console.error('SearXNG + Spider MCP Server started');
  }
}

main().catch((error) => {
  if (!process.env.MCP_MODE) {
    console.error('MCP server error:', error);
  }
  process.exit(1);
});