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
const crawl4aiUrl = 'http://localhost:8001';

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
        description: 'Scrape webpage content using Crawl4AI',
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
      const response = await axios.post(`${crawl4aiUrl}/scrape`, {
        url: args.url,
        formats: args.formats || ['markdown'],
        timeout: 30000
      }, {
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
          const response = await axios.post(`${crawl4aiUrl}/scrape`, {
            url,
            formats: ['markdown'],
            timeout: 15000
          }, { timeout: 20000 });
          
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
    console.error('SearXNG + Crawl4AI MCP Server started');
  }
}

main().catch((error) => {
  if (!process.env.MCP_MODE) {
    console.error('MCP server error:', error);
  }
  process.exit(1);
});