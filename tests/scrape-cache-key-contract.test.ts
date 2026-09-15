import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

function cachedScrapeUrlBody(): string {
  const start = indexSource.indexOf('private async cachedScrapeUrl');
  const end = indexSource.indexOf('private setupToolHandlers');
  return indexSource.slice(start, end);
}

describe('per-URL scrape cache key', () => {
  it('isolates different timeout/deadline values while reusing identical URL, formats, and timeout', () => {
    const body = cachedScrapeUrlBody();

    expect(body).toContain(
      "const cacheKey = `scrape_url:${normalized}:${(formats || ['markdown']).join(',')}:${timeout}`;"
    );
    expect(body).toContain('this.cache.get<ScrapeClientResponse>(cacheKey)');
    expect(body).toContain('this.cache.set(cacheKey, result, URL_SCRAPE_CACHE_TTL_MS)');
  });
});
