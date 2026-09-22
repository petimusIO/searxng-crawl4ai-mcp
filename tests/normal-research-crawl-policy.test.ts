import { describe, expect, it } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';

function scrapeOk(wordCount = 12) {
  return {
    success: true,
    url: 'https://example.com',
    data: {
      markdown: 'short successful page',
      metadata: {
        title: 'Page',
        description: '',
        language: 'en',
        word_count: wordCount,
      },
    },
  };
}

function hit(url: string, content = 'discovery snippet') {
  return { url, title: url, content };
}

function createServer(scrape: (url: string, timeout?: number) => Promise<unknown>) {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  server.cache = {
    get: async () => null,
    set: async () => {},
  };
  server.scrapeSingleUrl = scrape;
  return server;
}

async function normalResearch(
  server: any,
  hits: Array<{ url: string; title: string; content: string }>,
  extras: { breadth?: string } = {},
) {
  const response = await server.handleNormalResearch(
    'answer',
    extras.breadth ?? 'multi',
    hits,
    'relevant_only',
    undefined,
    hits.length,
    [],
    Date.now(),
    'research:test',
    'fourget',
  );
  return JSON.parse(response.content[0].text);
}

describe('normal research crawl policy', () => {
  it('reads each selected source even when the discovery snippet is already long', async () => {
    const longSnippet = 'x'.repeat(200);
    const scraped: string[] = [];
    const server = createServer(async (url) => {
      scraped.push(url);
      return scrapeOk();
    });

    const result = await normalResearch(server, [hit('https://rich.test', longSnippet)]);

    expect(scraped).toEqual(['https://rich.test']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].source_type).toBe('scraped');
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].snippet).toBe(longSnippet);
  });

  it('keeps quick research snippets-only', async () => {
    let scrapeCalls = 0;
    const server = createServer(async () => {
      scrapeCalls += 1;
      return scrapeOk();
    });
    const longSnippet = 'x'.repeat(200);

    const response = server.handleQuickResearch(
      'answer',
      'multi',
      [hit('https://quick.test', longSnippet)],
      'relevant_only',
      1,
      [],
      Date.now(),
      'fourget',
    );
    const result = JSON.parse(response.content[0].text);

    expect(scrapeCalls).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].source_type).toBe('snippet');
    expect(result.results[0].snippet).toBe(longSnippet);
    expect(result.research_metadata.pages_scraped).toBe(0);
  });

  it('honors the existing 3/5 source cap', async () => {
    const hits = Array.from({ length: 8 }, (_, index) => hit(`https://cap.test/${index}`));

    const singleScraped: string[] = [];
    const single = await normalResearch(
      createServer(async (url) => {
        singleScraped.push(url);
        return scrapeOk();
      }),
      hits,
      { breadth: 'single' },
    );
    expect(singleScraped).toHaveLength(3);
    expect(single.results).toHaveLength(3);

    const multiScraped: string[] = [];
    const multi = await normalResearch(
      createServer(async (url) => {
        multiScraped.push(url);
        return scrapeOk();
      }),
      hits,
      { breadth: 'multi' },
    );
    expect(multiScraped).toHaveLength(5);
    expect(multi.results).toHaveLength(5);
  });

  it('uses the existing 3000ms per-page research deadline', async () => {
    const timeouts: number[] = [];
    const server = createServer(async (_url, timeout) => {
      timeouts.push(timeout as number);
      return scrapeOk();
    });

    await normalResearch(server, [hit('https://deadline.test')]);

    expect(timeouts).toEqual([3000]);
  });
});
