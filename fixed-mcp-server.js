#!/usr/bin/env node

/**
 * Thin shim — loads the searxng-crawl4ai-mcp server.
 *
 * Sets env var defaults so the server uses the HTTP-direct code path
 * to SearXNG and Spider/Crawl4AI services.
 *
 * Users can override any of these via their shell environment.
 */

process.env.SEARXNG_URL ??= 'http://localhost:8081';
process.env.SPIDER_URL ??= 'http://localhost:8002';
process.env.WEB_SEARCH_CRAWL_TIMEOUT_MS ??= '1000';
process.env.WEB_SEARCH_CRAWL_BATCH_TIMEOUT_MS ??= '1500';

// The imported module auto-starts when run directly
await import('./dist/index.js');
