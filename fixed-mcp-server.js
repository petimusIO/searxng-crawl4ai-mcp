#!/usr/bin/env node

/**
 * Thin shim — loads the Seek monorepo's unified MCP server.
 *
 * Sets env var defaults so that web-search.ts uses the HTTP-direct code path
 * (SearXNG API + Crawl4AI HTTP) instead of the MCP path, which would create
 * a circular call back through this same server.
 *
 * Users can override any of these via their shell environment.
 */

process.env.SEARXNG_API_URL ??= 'http://localhost:8081';
process.env.SPIDER_URL ??= 'http://localhost:8002';

const { startServer } = await import('../seek/packages/ai/dist/mcp/server.js');
startServer();
