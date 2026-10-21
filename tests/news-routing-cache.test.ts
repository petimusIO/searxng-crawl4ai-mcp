import { describe, expect, it, vi } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';
import { buildCacheKey } from '../src/cache-key.js';

const query = 'news cache routing';
const rows = Array.from({ length: 6 }, (_, i) => ({ title: `News ${i}`, url: `https://news.example/${i}`,
  description: 'News evidence snippet', date: null, type: 'news' }));
function fixture() {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  const entries = new Map<string, unknown>();
  server.cache = {
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { entries.set(key, value); }),
  };
  server.fourget = {
    search: vi.fn(async () => ({ status: 'ok', web: rows, answer: [], npt: '' })),
    searchNews: vi.fn(async () => ({ status: 'ok', web: rows, answer: [], npt: '' })),
  };
  server.searxng = { search: vi.fn(async () => ({ results: [] })) };
  server._scrapeClient = { scrape: vi.fn(async (url: string) => ({ success: true, url,
    data: { markdown: '# News\n\nNews cache routing evidence.', metadata: { title: 'News', word_count: 6 } },
  })) };
  return { server, entries };
}
const cases = [
  { label: 'search_web', method: 'handleSearchWeb', args: { maxResults: 5 },
    namespace: 'search:primary-fallback:v2', fields: (categories: string, scraper: string) => [query, categories, '', 'en', scraper, 5],
    route: (body: any) => body.engine_info?.route },
  { label: 'research', method: 'handleResearch', args: { max_results: 2 },
    namespace: 'research:v6', fields: (categories: string, scraper: string) => [query, 'normal', 'single', 2, categories, 'markdown', 'relevant_only', scraper, 6000],
    route: (body: any) => body.research_metadata?.discovery_route },
  { label: 'legacy', method: 'handleSearchAndScrape', args: { maxResults: 2, scrapeAll: true },
    namespace: 'search_and_scrape:v4', fields: (categories: string, scraper: string) => [query, 2, '', true, categories, 'markdown', 'full', scraper],
    route: (body: any) => body.discovery_route },
];

describe.each(cases)('$label news cache identity', ({ method, args, namespace, fields, route }) => {
  it.each(['news', 'news,general', 'general,news'])('isolates %s from old entries and distinct scrapers while reusing equivalent defaults', async (categories) => {
    const { server, entries } = fixture();
    const stale = { content: [{ type: 'text', text: JSON.stringify({ stale: true }) }] };
    for (const scraper of ['ddg', 'startpage']) entries.set(buildCacheKey(namespace, fields(categories, scraper)), stale);
    const call = (scraper?: string) => server[method]({ query, categories, ...args, ...(scraper ? { scraper } : {}) });

    const first = await call();
    expect(route(JSON.parse(first.content[0].text))).toBe('fourget');
    expect(server.fourget.searchNews).toHaveBeenLastCalledWith(query, 'ddg', 1500);
    expect(server.fourget.search).not.toHaveBeenCalled();
    const firstKey = server.cache.get.mock.calls[0][0];
    expect(firstKey).toBe(buildCacheKey(namespace, [...fields(categories, 'ddg'), 'fourget-news:v1', 'ddg']));

    expect(await call('ddg')).toEqual(first);
    expect(server.fourget.searchNews).toHaveBeenCalledTimes(1);
    const startpage = await call('startpage');
    expect(route(JSON.parse(startpage.content[0].text))).toBe('fourget');
    expect(server.fourget.searchNews).toHaveBeenLastCalledWith(query, 'startpage', 1500);
    expect(server.fourget.searchNews).toHaveBeenCalledTimes(2);
    expect(server.cache.get.mock.calls.some(([key]: [string]) => key === buildCacheKey(namespace,
      [...fields(categories, 'startpage'), 'fourget-news:v1', 'startpage']))).toBe(true);
    expect(await call('startpage')).toEqual(startpage);
    expect(server.fourget.searchNews).toHaveBeenCalledTimes(2);
  });

  it.each(['', 'general', 'science', 'news,images'])('preserves exact pre-news cache keys for category %s', async (categories) => {
    const { server, entries } = fixture();
    const key = buildCacheKey(namespace, fields(categories, 'ddg'));
    const cached = { content: [{ type: 'text', text: JSON.stringify({ preserved: true }) }] };
    entries.set(key, cached);
    const result = await server[method]({ query, categories, ...args });
    expect(result).toEqual(cached);
    expect(server.cache.get).toHaveBeenCalledWith(key);
    expect(server.fourget.search).not.toHaveBeenCalled();
    expect(server.fourget.searchNews).not.toHaveBeenCalled();
  });
});

it('advertises DuckDuckGo defaults for both endpoints without injecting scraper arguments', async () => {
  const { server } = fixture();
  const handlers = new Map<string, Function>();
  server.setupToolHandlers({ setRequestHandler: (schema: any, fn: Function) => handlers.set(schema.shape.method.value, fn) });
  const { tools } = await handlers.get('tools/list')!();
  for (const name of ['search_web', 'research']) {
    const scraper = tools.find((tool: any) => tool.name === name).inputSchema.properties.scraper;
    expect(scraper.default).toBeUndefined();
    expect(scraper.description).toContain('Defaults: "ddg" for web and news');
  }
});
