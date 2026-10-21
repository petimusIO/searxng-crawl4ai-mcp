import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSearchTool } from '../src/tools/websearch.js';
import * as merger from '../src/search-merger.js';

const rows = Array.from({ length: 28 }, (_, i) => ({
  title: `Candidate ${i}`, url: `https://source.example/${i}`,
  description: `Evidence for candidate ${i}.`, date: null, type: 'web',
}));
function fixture() {
  const server = Object.create(WebSearchTool.prototype) as any;
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

describe('websearch first-page candidate retention', () => {
  it.each(['news', 'fallback', 'required', 'partial'])('preserves the complete candidate pool on the %s route', async (route) => {
    const merged = vi.spyOn(merger, 'mergeSearchResults');
    const server = fixture();
    const args: any = { query: 'candidate routing', maxResults: 50 };
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
    const response = await server.handle(args);
    const body = JSON.parse(response.content[0].text);
    expect(merged.mock.results[0].value).toHaveLength(28);
    expect(merged.mock.results[0].value.map((r: any) => r.url)).toEqual(rows.map(r => r.url));
    expect(body.engine_info.route).toBe({ news: 'fourget', fallback: 'searxng-fallback', required: 'searxng-required', partial: 'fourget-partial' }[route]);
    expect(server._scrapeClient.scrape).not.toHaveBeenCalled();
    expect(server.fourget.search).toHaveBeenCalledTimes(route === 'required' || route === 'news' ? 0 : 1);
    expect(server.fourget.searchNews).toHaveBeenCalledTimes(route === 'news' ? 1 : 0);
    expect(server.searxng.search).toHaveBeenCalledTimes(route === 'news' ? 0 : 1);
    if (route !== 'news') expect(server.searxng.search).toHaveBeenCalledWith(args.query, expect.objectContaining({ pageno: 1 }));
  });

  it('keeps the websearch result limit separate from the provider candidate pool', async () => {
    const server = fixture();
    const response = await server.handle({ query: 'presentation limit', maxResults: 2 });
    const body = JSON.parse(response.content[0].text);
    expect(body.results).toHaveLength(2);
    expect(server._scrapeClient.scrape).not.toHaveBeenCalled();
    expect(server.fourget.search).toHaveBeenCalledTimes(1);
  });
});
