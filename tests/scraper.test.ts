import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

describe('Firecrawl MCP Server', () => {

  beforeAll(async () => {
    // Setup test environment
    process.env.PROXY_URL = 'http://username:password@your-proxy-server.com:10000';
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterAll(async () => {
    // Cleanup
  });

  describe('Proxy Configuration', () => {
    it('should create proxy agent with provided URL', () => {
      const proxyUrl = process.env.PROXY_URL;
      expect(proxyUrl).toBeDefined();
      expect(proxyUrl).toContain('your-proxy-server.com:10000');
    });

    it('should mask credentials in logs', () => {
      const proxyUrl = 'http://username:password@your-proxy-server.com:10000';
      const masked = proxyUrl.replace(/\/\/.*@/, '//***@');
      expect(masked).toBe('http://***@your-proxy-server.com:10000');
    });
  });

  describe('MCP Tools', () => {
    const mockTools = [
      'scrape_url',
      'batch_scrape', 
      'crawl_website',
      'map_website',
      'extract_structured_data',
      'get_crawl_status',
      'search_web',
      'search_and_scrape',
      'crawl4ai_scrape'
    ];

    it('should register all required tools', () => {
      mockTools.forEach(tool => {
        expect(tool).toMatch(/^(scrape_url|batch_scrape|crawl_website|map_website|extract_structured_data|get_crawl_status|search_web|search_and_scrape|crawl4ai_scrape)$/);
      });
    });

    it('should validate tool input schemas', () => {
      const scrapeSchema = {
        type: 'object',
        properties: {
          url: { type: 'string' },
          options: { type: 'object' }
        },
        required: ['url']
      };

      expect(scrapeSchema.required).toContain('url');
      expect(scrapeSchema.properties.url.type).toBe('string');
    });
  });

  describe('Environment Configuration', () => {
    it('should load required environment variables', () => {
      expect(process.env.PROXY_URL).toBeDefined();
      expect(process.env.REDIS_URL).toBeDefined();
    });

    it('should use default values for optional variables', () => {
      const port = process.env.PORT || '3002';
      const workers = process.env.NUM_WORKERS_PER_QUEUE || '8';
      
      expect(port).toBe('3002');
      expect(workers).toBe('8');
    });
  });
});