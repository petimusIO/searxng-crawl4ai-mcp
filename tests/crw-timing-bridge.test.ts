import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrapeClient } from '../src/scrape-client.js';
import { WebFetchTool } from '../src/tools/webfetch.js';
import { withSearchTiming, withSourceTiming } from '../src/search-timing.js';

function capture() {
  const records: any[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    try { const record = JSON.parse(String(chunk)); if (record.event === 'search.timing') records.push(record); } catch {}
    return true;
  }) as any);
  return records;
}
afterEach(() => vi.restoreAllMocks());

describe('CRW internal timing bridge', () => {
  it('marks HTTP fallback extraction and returned evidence partial after failed JS escalation', async () => {
    const records = capture();
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, warning: 'js_escalation_failed: Timeout after 2916ms', data: { markdown: 'Useful fallback evidence.', metadata: { statusCode: 200, renderedWith: 'http' } } } });
    const server = Object.create(WebFetchTool.prototype) as any;
    server.cache = { get: async () => null, set: vi.fn() };
    const response: any = await withSearchTiming(undefined, 'scrape_url', () => server.handle({ url: 'https://example.com/page', max_tokens: 1200 }));
    expect(JSON.parse(response.content[0].text).success).toBe(true);
    for (const stage of ['mcp.crw.request', 'mcp.crawl.page', 'mcp.request.total']) {
      expect(records.find(record => record.stage === stage)?.status).toBe('partial');
    }
  });
  it('links each uncached HTTP request to its search and selected source without changing the request body or evidence', async () => {
    const records = capture();
    const raw = { success: true, data: { markdown: '# Evidence\n\nKeep all content.', metadata: { title: 'Evidence', statusCode: 200, renderedWith: 'http', elapsedMs: 3 } } };
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: raw });
    const client = new ScrapeClient('http://crw:3000');
    const response = await withSearchTiming({ 'seek/timing': { searchId: 'bridge-search' } }, 'research', () =>
      withSourceTiming(2, () => client.scrape('https://example.com/SECRET_URL', { timeout: 3000, wait_for: 0, proxy_url: 'SECRET_PROXY' })));
    const [url, body, options] = post.mock.calls[0] as any;
    const id = options.headers['x-seek-crawl-id'];
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(url).toBe('http://crw:3000/v1/scrape');
    expect(body).toEqual({ url: 'https://example.com/SECRET_URL', formats: ['markdown'], deadlineMs: 3000, waitFor: 0 });
    expect(options.timeout).toBe(4000);
    const spans = records.filter(r => r.stage === 'mcp.crw.request');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ crwRequestId: id, searchId: 'bridge-search', sourceIndex: 2, status: 'success', inclusive: true });
    expect(spans[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(response.data?.markdown).toBe(raw.data.markdown);
    expect(JSON.stringify(response)).not.toMatch(/crwRequestId|bridge-search|crawl.timing/);
    expect(JSON.stringify(records)).not.toMatch(/SECRET|example\.com/);
    expect(records.find(r => r.stage === 'mcp.request.total')).not.toHaveProperty('crwRequestId');
  });

  it('keeps concurrent searches and source indices isolated when responses finish out of order', async () => {
    const records = capture();
    const pending: Array<{ id: string; resolve: (value: any) => void }> = [];
    vi.spyOn(axios, 'post').mockImplementation(((_url: string, _body: unknown, options: any) =>
      new Promise(resolve => pending.push({ id: options.headers['x-seek-crawl-id'], resolve }))) as any);
    const client = new ScrapeClient('http://crw:3000');
    const work = [0, 1].map(index => withSearchTiming({ 'seek/timing': { searchId: `search-${index}` } }, 'research', () =>
      withSourceTiming(index, () => client.scrape('https://example.com/SECRET_URL'))));
    expect(pending).toHaveLength(2);
    expect(pending[0].id).not.toBe(pending[1].id);
    for (const item of [...pending].reverse()) item.resolve({ data: { success: true, data: { markdown: 'Evidence.' } } });
    await Promise.all(work);
    const spans = records.filter(r => r.stage === 'mcp.crw.request');
    expect(spans.map(r => r.sourceIndex)).toEqual([1, 0]);
    for (const index of [0, 1]) expect(spans.find(r => r.sourceIndex === index)).toMatchObject({ crwRequestId: pending[index].id, searchId: `search-${index}`, status: 'success' });
    expect(records.filter(r => r.stage === 'mcp.request.total').every(r => r.crwRequestId === undefined)).toBe(true);
  });

  it('logs resolved failures and thrown timeouts without changing their results', async () => {
    const records = capture();
    const timeout = Object.assign(new Error('SECRET_TIMEOUT'), { code: 'ECONNABORTED' });
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { success: false, error: 'blocked' } }).mockRejectedValueOnce(timeout);
    const client = new ScrapeClient('http://crw:3000');
    await withSearchTiming(undefined, 'research', async () => {
      expect(await client.scrape('https://example.com/one')).toMatchObject({ success: false, error: 'blocked' });
      await expect(client.scrape('https://example.com/two')).rejects.toBe(timeout);
    });
    expect(records.filter(r => r.stage === 'mcp.crw.request').map(r => r.status)).toEqual(['error', 'timeout']);
    expect(JSON.stringify(records)).not.toMatch(/SECRET|example\.com/);
  });

  it('does not invoke CRW or create a bridge span for a page cache hit', async () => {
    const records = capture();
    const post = vi.spyOn(axios, 'post');
    const cached = { success: true, url: 'https://example.com/page', data: { markdown: 'Cached evidence.', metadata: { word_count: 2 } } };
    const server = Object.create(WebFetchTool.prototype) as any;
    server.cache = { get: vi.fn(async () => cached), set: vi.fn() };
    const result = await withSearchTiming(undefined, 'research', () => withSourceTiming(0, () => server.cachedScrapeUrl('https://example.com/page', ['markdown'], 3000)));
    expect(result).toBe(cached);
    expect(post).not.toHaveBeenCalled();
    expect(records.filter(r => r.stage === 'mcp.crw.request')).toHaveLength(0);
    expect(records).toContainEqual(expect.objectContaining({ stage: 'mcp.crawl.page', sourceIndex: 0, status: 'cached' }));
  });

  it('keeps retrieval successful if the timing log destination throws', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, data: { markdown: 'Evidence.' } } });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('closed log'); });
    await expect(withSearchTiming(undefined, 'research', () => new ScrapeClient().scrape('https://example.com/page'))).resolves.toMatchObject({ success: true, data: { markdown: 'Evidence.' } });
  });

  it('adds only the opaque header for a direct client without search context', async () => {
    const records = capture();
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { success: true, data: { markdown: 'Evidence.' } } });
    await new ScrapeClient().scrape('https://example.com/page');
    expect((post.mock.calls[0][2] as any).headers['x-seek-crawl-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(records).toHaveLength(0);
  });
});
