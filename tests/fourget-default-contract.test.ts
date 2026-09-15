import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('4get default scraper contract', () => {
  it('does not default any server path to blocked Brave', () => {
    expect(indexSource).not.toContain("args.scraper || 'brave'");
    expect(indexSource).not.toContain('Default: "brave"');
  });

  it('does not advertise unsupported Bing as a 4get scraper', () => {
    expect(indexSource).not.toContain('"brave", "google", "bing"');
  });

  it('uses the shared DDG default in every server path', () => {
    expect(indexSource.match(/DEFAULT_FOURGET_SCRAPER/g)).toHaveLength(6);
  });

  it('routes all server discovery through the primary-fallback helper', () => {
    expect(indexSource.match(/await discoverUrls\(/g)).toHaveLength(3);
    expect(indexSource).not.toContain('const [searxngSettled, fourgetSettled]');
  });

  it('describes and caches the primary-fallback strategy accurately', () => {
    expect(indexSource).toContain('Search the web using 4get with SearXNG fallback');
    expect(indexSource).not.toContain('search:merged:');
    expect(indexSource).toContain("const RESEARCH_CACHE_PREFIX        = 'research:v2'");
    expect(indexSource).toContain("buildCacheKey('search_and_scrape:v2'");
  });

  it('uses structured keys and isolates every discovery cache by scraper', () => {
    const markers = [
      "buildCacheKey('search:primary-fallback', [",
      "buildCacheKey('search_and_scrape:v2', [",
      'buildCacheKey(RESEARCH_CACHE_PREFIX, [',
    ];

    expect(indexSource.match(/const cacheKey = buildCacheKey\(/g)).toHaveLength(3);
    for (const marker of markers) {
      const start = indexSource.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const end = indexSource.indexOf(']);', start);
      expect(indexSource.slice(start, end)).toContain('scraper');
    }
  });

  it('reports discovery metadata when legacy search returns no results', () => {
    expect(indexSource).toMatch(
      /search_results:\s*0,\s*discovery_route:\s*discovery\.route,\s*fallback_reason:\s*discovery\.fallbackReason,/,
    );
  });

  it('isolates search_web cache entries by result limit', () => {
    const start = indexSource.indexOf("buildCacheKey('search:primary-fallback', [");
    const end = indexSource.indexOf(']);', start);
    expect(indexSource.slice(start, end)).toContain('limit');
  });
});
