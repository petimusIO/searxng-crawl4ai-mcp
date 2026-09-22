import { describe, expect, it } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';

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
  const server = Object.create(SearXNGMCPServer.prototype) as any;
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
    expect(harness.sets[0].key.startsWith('scrape_url:v2:')).toBe(true);
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

describe('research composite cache policy', () => {
  function createResearchHarness(scrape: (url: string) => Promise<unknown>) {
    const server = Object.create(SearXNGMCPServer.prototype) as any;
    const sets: Array<{ key: string; value: unknown; ttl?: number }> = [];
    server.cache = {
      get: async () => null,
      set: async (key: string, value: unknown, ttl?: number) => {
        sets.push({ key, value, ttl });
      },
    };
    server.scrapeSingleUrl = async (url: string) => scrape(url);
    return { server, sets };
  }

  async function normalResearch(server: any, hits: Array<{ url: string; title: string; content: string }>, cacheKey: string) {
    const response = await server.handleNormalResearch(
      'answer',
      'multi',
      hits,
      'relevant_only',
      undefined,
      hits.length,
      [],
      Date.now(),
      cacheKey,
      'fourget',
    );
    return { decoded: JSON.parse(response.content[0].text), raw: response };
  }

  it('does not composite-cache research responses that contain failures', async () => {
    const { server, sets } = createResearchHarness(async () => ({
      success: false,
      error: 'blocked',
    }));

    await normalResearch(
      server,
      [{ url: 'https://failed.test', title: 'Failed', content: 'snippet' }],
      'research:v3:should-not-store',
    );

    expect(sets).toEqual([]);
  });

  it('composite-caches fully successful research, including short pages', async () => {
    const { server, sets } = createResearchHarness(async () => scrapeOk(12));
    const { raw } = await normalResearch(
      server,
      [{ url: 'https://short.test', title: 'Short', content: 'snippet' }],
      'research:v3:ok',
    );

    expect(sets).toHaveLength(1);
    expect(sets[0].key).toBe('research:v3:ok');
    expect(sets[0].value).toEqual(raw);
    expect(sets[0].ttl).toBe(300_000);
  });
});
