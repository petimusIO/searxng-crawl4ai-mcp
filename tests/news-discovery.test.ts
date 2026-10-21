import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverUrls, type DiscoverUrlsOptions } from '../src/url-discovery.js';

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({
  title: `News ${i}`, url: `https://news.example/${i}`, description: `Snippet ${i}`, date: null, type: 'news',
}));
function setup(extra: Partial<DiscoverUrlsOptions> = {}) {
  const fourget = {
    search: vi.fn().mockRejectedValue(new Error('must not use web')),
    searchNews: vi.fn().mockResolvedValue({ status: 'ok', web: rows(6), answer: [], npt: '' }),
  };
  const searxng = { search: vi.fn().mockResolvedValue({ results: [
    { title: 'Fallback', url: 'https://fallback.example/news', content: 'Fallback snippet' },
  ] }) };
  const options = { query: 'NYC current events', fourget, searxng, maxResults: 5,
    minFourgetResults: 5, fourgetTimeoutMs: 1500, categories: 'news', language: 'en-US', ...extra };
  return { fourget, searxng, options };
}
afterEach(() => { vi.useRealTimers(); });

describe('news-aware discovery', () => {
  it('preserves the existing general-web error fallback for a malformed provider response', async () => {
    const { fourget, options } = setup({ categories: 'general' });
    fourget.search.mockResolvedValueOnce({ status: 'ok', web: [...rows(5), null], answer: [], npt: '' });
    const result = await discoverUrls(options);
    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('error');
    expect(fourget.searchNews).not.toHaveBeenCalled();
  });

  it.each(['news', 'news,general', 'general,news', ' general , news '])('uses dedicated Startpage news for %s', async (categories) => {
    const { fourget, searxng, options } = setup({ categories });
    const result = await discoverUrls(options);
    expect(result.route).toBe('fourget');
    expect(result.results).toHaveLength(5);
    expect(result.sourcesConsulted).toEqual({ fourget: true, searxng: false });
    expect(fourget.searchNews).toHaveBeenCalledWith(options.query, 'ddg', 1500);
    expect(fourget.search).not.toHaveBeenCalled();
    expect(searxng.search).not.toHaveBeenCalled();
  });

  it('respects an explicit news scraper', async () => {
    const { fourget, options } = setup({ scraper: 'ddg' });
    expect((await discoverUrls(options)).route).toBe('fourget');
    expect(fourget.searchNews).toHaveBeenCalledWith(options.query, 'ddg', 1500);
    expect(fourget.search).not.toHaveBeenCalled();
  });

  it.each([
    { categories: 'news,images', reason: 'categories' },
    { categories: 'science', reason: 'categories' },
    { engines: 'bing news', reason: 'engines' },
    { language: 'fr', reason: 'language' },
  ])('keeps constrained routes on SearXNG: %j', async ({ reason, ...extra }) => {
    const { fourget, searxng, options } = setup(extra);
    const result = await discoverUrls(options);
    expect(result.route).toBe('searxng-required');
    expect(result.fallbackReason).toBe(`required-options:${reason}`);
    expect(fourget.searchNews).not.toHaveBeenCalled();
    expect(fourget.search).not.toHaveBeenCalled();
    expect(searxng.search).toHaveBeenCalledWith(options.query, expect.objectContaining({
      categories: options.categories, engines: options.engines, language: options.language,
    }));
  });

  it('falls back for four distinct usable URLs even when malformed rows and fragments inflate the raw count', async () => {
    const { fourget, searxng, options } = setup({ categories: 'news,general', maxResults: 3 });
    fourget.searchNews.mockResolvedValueOnce({ status: 'ok', web: [
      ...rows(4), { ...rows(1)[0], url: 'https://news.example/0#fragment' }, null, {},
      { title: 123, url: 'https://news.example/bad' }, { title: 'Bad URL', url: 123 },
      { title: 'Bad scheme', url: 'javascript:alert(1)' }, { title: ' ', url: 'https://news.example/blank' },
    ], answer: [], npt: '' });
    const result = await discoverUrls(options);
    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('insufficient-results:4');
    expect(result.results).toHaveLength(3);
    expect(result.results[0].source).toBe('searxng');
    expect(searxng.search).toHaveBeenCalledWith(options.query, {
      categories: 'news,general', engines: undefined, language: 'en-US', pageno: 1, format: 'json',
    });
    expect(fourget.search).not.toHaveBeenCalled();
  });

  it('preserves valid partial news when fallback fails', async () => {
    const { fourget, searxng, options } = setup();
    fourget.searchNews.mockResolvedValueOnce({ status: 'ok', web: rows(4), answer: [], npt: '' });
    searxng.search.mockRejectedValueOnce(new Error('internal fallback address'));
    const result = await discoverUrls(options);
    expect(result.route).toBe('fourget-partial');
    expect(result.fallbackReason).toBe('insufficient-results:4;searxng-error');
    expect(result.results).toHaveLength(4);
    expect(result.results.every(row => row.source === 'fourget')).toBe(true);
  });

  it.each([
    { status: 'internal provider error', web: rows(5), expected: 'status-error' },
    { status: 'ok', web: null, expected: 'insufficient-results:0' },
    { status: 'ok', web: {}, expected: 'insufficient-results:0' },
  ])('uses stable fallback reasons for malformed or failed news responses: $expected', async ({ expected, ...response }) => {
    const { fourget, options } = setup();
    fourget.searchNews.mockResolvedValueOnce(response);
    const result = await discoverUrls(options);
    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe(expected);
  });

  it('bounds a hanging news primary by the existing deadline', async () => {
    vi.useFakeTimers();
    const { fourget, options } = setup();
    fourget.searchNews.mockImplementationOnce(() => new Promise(() => {}));
    const pending = discoverUrls(options);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('timeout');
  });

  it('falls back on a news transport error without trying general web', async () => {
    const { fourget, options } = setup();
    fourget.searchNews.mockRejectedValueOnce(new Error('internal provider address'));
    const result = await discoverUrls(options);
    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('error');
    expect(fourget.search).not.toHaveBeenCalled();
  });
});
