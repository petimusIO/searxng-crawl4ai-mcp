import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';
import * as merger from '../src/search-merger.js';

const rows = Array.from({ length: 28 }, (_, i) => ({
  title: `Candidate ${i}`, url: `https://source.example/${i}`,
  description: `Evidence for candidate ${i}.`, date: null, type: 'web',
}));
function fixture() {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  server.cache = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
  server.fourget = {
    search: vi.fn(async () => ({ status: 'ok', web: rows, answer: [], npt: 'next-page-token' })),
    searchNews: vi.fn(async () => ({ status: 'ok', web: rows, answer: [], npt: 'next-page-token' })),
  };
  server.searxng = { search: vi.fn(async () => ({ results: [] })) };
  server._scrapeClient = { scrape: vi.fn(async (url: string) => ({ success: true, url,
    data: { markdown: '# Evidence\n\nCandidate retention evidence for this source.', metadata: { title: 'Evidence', word_count: 9 } },
  })) };
  return server;
}
afterEach(() => vi.restoreAllMocks());

describe('research first-page candidate retention', () => {
  it('retains every first-page candidate at discovery without increasing the multi crawl or evidence budget', async () => {
    const merged = vi.spyOn(merger, 'mergeSearchResults');
    const server = fixture();
    const response = await server.handleResearch({ query: 'candidate retention', depth: 'normal', breadth: 'multi', max_results: 5, max_tokens: 6000 });
    const body = JSON.parse(response.content[0].text);
    expect(merged.mock.results[0].value).toHaveLength(28);
    expect(merged.mock.results[0].value.map((r: any) => r.url)).toEqual(rows.map(r => r.url));
    expect(server.fourget.search).toHaveBeenCalledTimes(1);
    expect(server.fourget.search).toHaveBeenCalledWith('candidate retention', 'ddg', 1500);
    expect(server.searxng.search).not.toHaveBeenCalled();
    expect(server._scrapeClient.scrape.mock.calls.map(([url]: [string]) => url)).toEqual(rows.slice(0, 5).map(r => r.url));
    for (const [, options] of server._scrapeClient.scrape.mock.calls) expect(options.timeout).toBe(3000);
    expect(body.research_metadata.pages_scraped).toBe(5);
    expect(body.results).toHaveLength(5);
    expect(body.budget.used).toBeLessThanOrEqual(body.budget.limit);
    expect(body.budget.limit).toBe(6000);
  });

  it.each(['news', 'fallback', 'required', 'partial'])('preserves the complete candidate pool on the %s route', async (route) => {
    const merged = vi.spyOn(merger, 'mergeSearchResults');
    const server = fixture();
    const args: any = { query: 'candidate routing', depth: 'normal', breadth: 'multi', max_results: 5 };
    if (route === 'news') args.categories = 'news';
    if (route === 'fallback' || route === 'required') {
      server.fourget.search.mockResolvedValue({ status: 'ok', web: [], answer: [], npt: '' });
      server.searxng.search.mockResolvedValue({ results: rows.map(r => ({ title: r.title, url: r.url, content: r.description })) });
      if (route === 'required') args.categories = 'science';
    }
    if (route === 'partial') {
      server.fourget.search.mockResolvedValue({ status: 'error', web: rows, answer: [], npt: '' });
      server.searxng.search.mockRejectedValue(new Error('upstream unavailable'));
    }
    const response = await server.handleResearch(args);
    const body = JSON.parse(response.content[0].text);
    expect(merged.mock.results[0].value).toHaveLength(28);
    expect(merged.mock.results[0].value.map((r: any) => r.url)).toEqual(rows.map(r => r.url));
    expect(body.research_metadata.discovery_route).toBe({ news: 'fourget', fallback: 'searxng-fallback', required: 'searxng-required', partial: 'fourget-partial' }[route]);
    expect(server._scrapeClient.scrape).toHaveBeenCalledTimes(5);
    expect(server.fourget.search).toHaveBeenCalledTimes(route === 'required' || route === 'news' ? 0 : 1);
    expect(server.fourget.searchNews).toHaveBeenCalledTimes(route === 'news' ? 1 : 0);
    expect(server.searxng.search).toHaveBeenCalledTimes(route === 'news' ? 0 : 1);
    if (route !== 'news') expect(server.searxng.search).toHaveBeenCalledWith(args.query, expect.objectContaining({ pageno: 1 }));
  });

  it.each([
    { breadth: 'single', max_results: undefined, selected: 3 },
    { breadth: 'single', max_results: 1, selected: 1 },
    { breadth: 'multi', max_results: 10, selected: 5 },
  ])('keeps the existing crawl limit for $breadth/$max_results even when a selected source fails', async ({ breadth, max_results, selected }) => {
    const server = fixture();
    server._scrapeClient.scrape.mockResolvedValueOnce({ success: false, url: rows[0].url, error: 'blocked' });
    const response = await server.handleResearch({ query: 'bounded selection', breadth, max_results });
    const body = JSON.parse(response.content[0].text);
    expect(server._scrapeClient.scrape.mock.calls.map(([url]: [string]) => url)).toEqual(rows.slice(0, selected).map(r => r.url));
    expect(body.research_metadata.errors).toHaveLength(1);
    expect(body.results[0].source_type).toBe('snippet');
    expect(server.fourget.search).toHaveBeenCalledTimes(1);
  });

  it('keeps the public search_web result limit separate from the research candidate pool', async () => {
    const server = fixture();
    const response = await server.handleSearchWeb({ query: 'presentation limit', maxResults: 2 });
    const body = JSON.parse(response.content[0].text);
    expect(body.results).toHaveLength(2);
    expect(server._scrapeClient.scrape).not.toHaveBeenCalled();
    expect(server.fourget.search).toHaveBeenCalledTimes(1);
  });
});
