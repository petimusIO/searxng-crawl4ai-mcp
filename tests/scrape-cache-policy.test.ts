import { describe, expect, it } from 'vitest';
import { WebFetchTool } from '../src/tools/webfetch.js';

function scrapeOk(wordCount: number, markdown = 'short successful page') {
  return {
    success: true,
    url: 'https://example.com',
    data: {
      markdown,
      metadata: {
        title: 'Page',
        description: '',
        language: 'en',
        word_count: wordCount,
      },
    },
  };
}

function createScrapeHarness(scrape: (url: string) => Promise<unknown> | unknown) {
  const server = Object.create(WebFetchTool.prototype) as any;
  const store = new Map<string, unknown>();
  const sets: Array<{ key: string; value: unknown; ttl?: number }> = [];
  let scrapeCalls = 0;
  let scrapeImpl = scrape;

  server.cache = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: unknown, ttl?: number) => {
      sets.push({ key, value, ttl });
      store.set(key, value);
    },
  };
  server.getScrapeClient = () => ({
    scrape: async (url: string) => {
      scrapeCalls += 1;
      return scrapeImpl(url);
    },
  });

  return {
    server,
    sets,
    get scrapeCalls() {
      return scrapeCalls;
    },
    setScrape(next: (url: string) => Promise<unknown> | unknown) {
      scrapeImpl = next;
    },
  };
}

describe('cached scrape policy', () => {
  it('caches successful short pages under a versioned scrape namespace', async () => {
    const short = scrapeOk(12, 'short page body');
    const harness = createScrapeHarness(async () => short);

    const first = await harness.server.cachedScrapeUrl('https://short.test/page', ['markdown'], 3000);
    const second = await harness.server.cachedScrapeUrl('https://short.test/page', ['markdown'], 3000);

    expect(first).toEqual(short);
    expect(second).toEqual(short);
    expect(harness.scrapeCalls).toBe(1);
    expect(harness.sets).toHaveLength(1);
    expect(harness.sets[0].key.startsWith('scrape_url:v3:')).toBe(true);
    expect(harness.sets[0].key).not.toContain('scrape_url:https://');
    expect(harness.sets[0].ttl).toBe(86_400_000);
  });

  it('does not cache resolved scrape failures', async () => {
    const harness = createScrapeHarness(async () => ({
      success: false,
      url: 'https://failed.test',
      error: 'blocked',
    }));

    const result = await harness.server.cachedScrapeUrl('https://failed.test', ['markdown'], 3000);

    expect(result.success).toBe(false);
    expect(harness.sets).toEqual([]);
  });

  it('does not cache empty successful extractions', async () => {
    const harness = createScrapeHarness(async () => scrapeOk(0, ''));

    const result = await harness.server.cachedScrapeUrl('https://empty.test', ['markdown'], 3000);

    expect(result.success).toBe(true);
    expect(harness.sets).toEqual([]);
  });
});
