import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const handler = readFileSync(new URL('../src/tools/websearch.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

describe('4get websearch defaults and cache identity', () => {
  it('retains distinct DDG web/image and news defaults without blocked Brave or unsupported Bing defaults', () => {
    expect(handler).toContain('const scraper = args.scraper || DEFAULT_FOURGET_SCRAPER;');
    expect(handler).toContain('news ? DEFAULT_FOURGET_NEWS_SCRAPER : DEFAULT_FOURGET_SCRAPER');
    expect(handler).not.toContain("args.scraper || 'brave'");
    expect(server).not.toContain('Default: "brave"');
    expect(server).not.toContain('"brave", "google", "bing"');
  });

  it('has one text-discovery path and isolates search by scraper, limit and budget', () => {
    expect(handler.match(/await discoverUrls\(/g)).toHaveLength(1);
    const start = handler.indexOf("buildCacheKey('websearch:v1', [");
    const key = handler.slice(start, handler.indexOf(']);', start));
    for (const field of ['scraper', 'limit', 'args.max_tokens', 'categories', 'engines', 'language']) expect(key).toContain(field);
    expect(server).toContain('Search snippets using 4get with SearXNG fallback');
  });
});
