import { describe, expect, it } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';

function words(count: number): string {
  return Array.from({ length: count }, () => 'word').join(' ');
}

function scrapeOk(wordCount: number, markdown = words(Math.max(wordCount, 0))) {
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

function scrapeFail(error: string, wordCount = 0) {
  return {
    success: false,
    url: 'https://example.com',
    error,
    data: wordCount
      ? {
          markdown: words(wordCount),
          metadata: {
            title: '',
            description: '',
            language: '',
            word_count: wordCount,
          },
        }
      : undefined,
  };
}

function hit(url: string, content = 'discovery snippet') {
  return { url, title: url, content };
}

function createServer(scrape: (url: string) => Promise<unknown>) {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  server.cache = {
    get: async () => null,
    set: async () => {},
  };
  server.scrapeSingleUrl = async (url: string) => scrape(url);
  return server;
}

async function normalResearch(
  server: any,
  hits: Array<{ url: string; title: string; content: string }>,
  extras: { query?: string; breadth?: string; contentMode?: string } = {},
) {
  const response = await server.handleNormalResearch(
    extras.query ?? 'answer',
    extras.breadth ?? 'multi',
    hits,
    extras.contentMode ?? 'relevant_only',
    undefined,
    hits.length,
    [],
    Date.now(),
    'research:test',
    'fourget',
  );
  return JSON.parse(response.content[0].text);
}

describe('normal research evidence', () => {
  it('retains nonempty successful short pages without a 250-word minimum', async () => {
    const url = 'https://cynkra.github.io/dd/reference/read_csv_auto.html';
    const server = createServer(async () => scrapeOk(161));
    const result = await normalResearch(server, [hit(url, 'read_csv_auto reference')]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].source_type).toBe('scraped');
    expect(result.results[0].url).toBe(url);
    expect(result.results[0].snippet).toBe('read_csv_auto reference');
    expect(result.research_metadata.errors).toEqual([]);
  });

  it('keeps discovery snippet and aggregate error for resolved success:false', async () => {
    const server = createServer(async () => scrapeFail('blocked', 12));
    const result = await normalResearch(server, [hit('https://failed.test')]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].source_type).toBe('snippet');
    expect(result.results[0].snippet).toBe('discovery snippet');
    expect(result.results[0].error).toBe('blocked');
    expect(result.research_metadata.errors).toEqual([
      { url: 'https://failed.test', error: 'blocked' },
    ]);
  });

  it('surfaces resolved long-body failures instead of claiming scraped evidence', async () => {
    const server = createServer(async () => scrapeFail('blocked', 300));
    const result = await normalResearch(server, [hit('https://failed-long.test')]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].source_type).toBe('snippet');
    expect(result.results[0].snippet).toBe('discovery snippet');
    expect(result.results[0].error).toBe('blocked');
    expect(result.research_metadata.errors).toEqual([
      { url: 'https://failed-long.test', error: 'blocked' },
    ]);
  });

  it('preserves discovery snippet when scrape throws', async () => {
    const server = createServer(async () => {
      throw new Error('timeout');
    });
    const result = await normalResearch(server, [hit('https://thrown.test')]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].source_type).toBe('snippet');
    expect(result.results[0].snippet).toBe('discovery snippet');
    expect(result.results[0].error).toBe('timeout');
    expect(result.research_metadata.errors).toEqual([
      { url: 'https://thrown.test', error: 'timeout' },
    ]);
  });

  it('treats empty success:true output as a visible extraction failure', async () => {
    const server = createServer(async () => scrapeOk(0, ''));
    const result = await normalResearch(server, [hit('https://empty.test')]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].source_type).toBe('snippet');
    expect(result.results[0].snippet).toBe('discovery snippet');
    expect(result.results[0].error).toBe('Empty extraction');
    expect(result.research_metadata.errors).toEqual([
      { url: 'https://empty.test', error: 'Empty extraction' },
    ]);
  });

  it('emits one result per selected source in discovery order', async () => {
    const server = createServer(async (url) => {
      if (url === 'https://second.test') return scrapeFail('blocked', 12);
      return scrapeOk(12);
    });
    const result = await normalResearch(server, [
      hit('https://first.test', 'first snippet'),
      hit('https://second.test', 'second snippet'),
      hit('https://third.test', 'third snippet'),
    ]);

    expect(result.results.map((item: { url: string }) => item.url)).toEqual([
      'https://first.test',
      'https://second.test',
      'https://third.test',
    ]);
    expect(result.results.map((item: { success: boolean }) => item.success)).toEqual([
      true,
      false,
      true,
    ]);
    expect(result.results[1].snippet).toBe('second snippet');
    expect(result.research_metadata.errors).toEqual([
      { url: 'https://second.test', error: 'blocked' },
    ]);
  });

  it('keeps mixed scrape outcomes for duplicate selected URLs in discovery order', async () => {
    let calls = 0;
    const server = createServer(async () => {
      calls += 1;
      if (calls === 1) return scrapeOk(12);
      return scrapeFail('blocked', 12);
    });
    const result = await normalResearch(server, [
      hit('https://dup.test', 'first snippet'),
      hit('https://dup.test', 'second snippet'),
    ]);

    expect(calls).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].source_type).toBe('scraped');
    expect(result.results[0].snippet).toBe('first snippet');
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].source_type).toBe('snippet');
    expect(result.results[1].snippet).toBe('second snippet');
    expect(result.results[1].error).toBe('blocked');
    expect(result.research_metadata.errors).toEqual([
      { url: 'https://dup.test', error: 'blocked' },
    ]);
  });
});
