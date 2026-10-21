import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { FourgetClient } from '../src/fourget-client.js';
import { discoverUrls } from '../src/url-discovery.js';

vi.mock('axios');
const http = vi.mocked(axios, true);
const client = new FourgetClient('http://fourget:80/');

beforeEach(() => { vi.clearAllMocks(); });

describe('4get dedicated news endpoint', () => {
  it('retains normalized partial news through real discovery when SearXNG fails', async () => {
    http.get.mockResolvedValueOnce({ data: { status: 'ok', news: Array.from({ length: 4 }, (_, i) => ({
      title: `News ${i}`, url: `https://example.org/${i}`, description: 'News snippet', date: 2026,
    })) } });
    const searxng = { search: vi.fn().mockRejectedValue(new Error('fallback unavailable')) };
    const result = await discoverUrls({ query: 'current events', categories: 'news,general', fourget: client,
      searxng, maxResults: 5, minFourgetResults: 5, fourgetTimeoutMs: 1500 });
    expect(result.route).toBe('fourget-partial');
    expect(result.fallbackReason).toBe('insufficient-results:4;searxng-error');
    expect(result.results).toHaveLength(4);
    expect(result.results.every(row => row.publishedDate === null && row.content === 'News snippet')).toBe(true);
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith('http://fourget:80/api/v1/news', expect.objectContaining({ timeout: 1500 }));
  });

  it('normalizes raw news rows without inventing dates from Startpage year values', async () => {
    const row = { title: '  News title  ', url: ' https://example.org/Article?x=1#part ',
      description: [{ type: 'text', value: 'First ' }, null, { type: 'code', value: 'second' }, { value: 23 }], date: 2026 };
    http.get.mockResolvedValueOnce({ data: { status: 'ok', news: [
      null, 1, {}, { ...row, title: 42 }, { ...row, title: ' ' }, { ...row, url: false },
      { ...row, url: 'javascript:alert(1)' }, { ...row, url: 'not a url' }, row,
      ...[1747526400, null, undefined, NaN, Infinity, '2026', '1747526400', 1747526400000].map((date, i) => ({
        ...row, url: `https://example.org/${i}`, date, description: i === 0 ? 'String snippet' : null,
      })),
    ] } });

    const result = await client.searchNews('events', 'ddg', 42);

    expect(http.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      params: { s: 'events', scraper: 'ddg', nsfw: 'no' }, timeout: 42,
    }));
    expect(result.web).toHaveLength(9);
    expect(result.web[0]).toEqual({ title: 'News title', url: 'https://example.org/Article?x=1#part',
      description: 'First second', date: null, type: 'news' });
    expect(result.web[1]).toMatchObject({ description: 'String snippet', date: '2025-05-18T00:00:00.000Z' });
    expect(result.web.slice(2).every(row => row.date === null && row.description === '')).toBe(true);
  });

  it.each([undefined, null, {}, 'bad'])('treats malformed news collection %s as empty, never uses the web collection', async (news) => {
    http.get.mockResolvedValueOnce({ data: { status: 'ok', news,
      web: [{ title: 'Wrong endpoint', url: 'https://example.org', description: 'Not news' }] } });
    expect((await client.searchNews('events')).web).toEqual([]);
  });

  it('propagates transport failure so discovery can perform fallback', async () => {
    http.get.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await expect(client.searchNews('events')).rejects.toMatchObject({ code: 'ECONNABORTED' });
  });

  it('uses DuckDuckGo news rather than web with safe search and the bounded primary timeout', async () => {
    http.get.mockResolvedValueOnce({ data: { status: 'ok', news: [
      { title: 'News', url: 'https://example.org/news', description: 'News snippet', date: null },
    ], npt: 'news-next' } });

    const result = await client.searchNews('current events');

    expect(http.get).toHaveBeenCalledWith('http://fourget:80/api/v1/news', expect.objectContaining({
      params: { s: 'current events', scraper: 'ddg', nsfw: 'no' },
      timeout: 1500,
    }));
    expect(result).toEqual({ status: 'ok', web: [
      { title: 'News', url: 'https://example.org/news', description: 'News snippet', date: null, type: 'news' },
    ], answer: [], npt: 'news-next' });
  });
});
