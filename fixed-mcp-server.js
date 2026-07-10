#!/usr/bin/env node

/**
 * Thin shim — loads the searxng-crw-mcp server.
 *
 * Sets env vars for the local dev stack (SearXNG on :8081, Spider on :8002).
 * These override any globally-set values since this is the authoritative
 * entry point for local development.
 *
 * Users can override any of these via their shell environment.
 */

process.env.MCP_MODE = '1';
process.env.SEARXNG_URL = 'http://localhost:8081';
process.env.SPIDER_URL = 'http://localhost:8002';
process.env.CRW_URL = 'http://localhost:8001';
process.env.REDIS_URL = 'redis://localhost:6380';
process.env.WEB_SEARCH_CRAWL_TIMEOUT_MS = '1000';
process.env.WEB_SEARCH_CRAWL_BATCH_TIMEOUT_MS = '1500';

// The imported module auto-starts when run directly
await import('./dist/index.js');
