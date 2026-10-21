import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../src/tools/webfetch.ts', import.meta.url), 'utf8');

function cachedScrapeUrlBody(): string {
  const start = indexSource.indexOf('private async cachedScrapeUrl');
  const end = indexSource.indexOf('async handle(');
  return indexSource.slice(start, end);
}

describe('per-URL scrape cache key', () => {
  it('isolates different timeout/deadline values while reusing identical URL, formats, and timeout', () => {
    const body = cachedScrapeUrlBody();

    expect(body).toContain(
      "const cacheKey = `scrape_url:v3:${normalized}:${(formats || ['markdown']).join(',')}:${timeout}:${JSON.stringify(controls)}`;"
    );
    expect(body).toContain('this.cache.get<ScrapeClientResponse>(cacheKey)');
    expect(body).toContain('this.cache.set(cacheKey, result, URL_SCRAPE_CACHE_TTL_MS)');
  });
});
