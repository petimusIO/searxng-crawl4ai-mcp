import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';
import { RedisCache } from '../src/redis-cache.js';
import { withSearchTiming } from '../src/search-timing.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function fixture() {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  const handlers = new Map<string, Function>();
  server.setupToolHandlers({ setRequestHandler: (schema: any, fn: Function) => handlers.set(schema.shape.method.value, fn) });
  server.cache = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
  server.fourget = { search: vi.fn(async () => ({ status: 'ok', web: Array.from({ length: 5 }, (_, i) => ({ title: 'Page', url: `https://example.com/${i}`, description: 'SECRET_SNIPPET' })) })) };
  server.searxng = { search: vi.fn() };
  server._scrapeClient = { scrape: vi.fn(async (url: string) => ({ success: true, url, data: { markdown: '# Page\n\nSECRET_DOCUMENT timing evidence.', metadata: { title: 'Page', word_count: 5 } } })) };
  return { server, call: (name: string, args: any, meta?: any) => handlers.get('tools/call')!(CallToolRequestSchema.parse({ method: 'tools/call', params: { name, arguments: args, _meta: meta } })) };
}
function capture() {
  const records: any[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    try { const r = JSON.parse(String(chunk)); if (r.event === 'search.timing') records.push(r); } catch {}
    return true;
  }) as any);
  return records;
}
afterEach(() => vi.restoreAllMocks());

describe('MCP search timing dispatch', () => {
  it('correlates real research stages from params metadata without changing evidence', async () => {
    const records = capture();
    const { call } = fixture();
    const response = await call('research', { query: 'SECRET_QUERY', breadth: 'multi', max_results: 2 }, {
      'seek/timing': { searchId: 'search-1', traceId: 'trace-1', requestId: 'req-1', mcpCallId: 'call-1', query: 'SECRET_META' },
    });
    const body = JSON.parse(response.content[0].text);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: any) => r.source_type === 'scraped')).toBe(true);
    expect(records.map(r => r.stage)).toEqual(expect.arrayContaining([
      'mcp.request.total', 'mcp.discovery', 'mcp.provider.fourget', 'mcp.crawl.batch',
      'mcp.crawl.page', 'mcp.cache.get', 'mcp.cache.set', 'mcp.parse', 'mcp.rank', 'mcp.pack', 'mcp.serialization',
    ]));
    expect(records.filter(r => r.stage === 'mcp.crawl.page')).toHaveLength(2);
    for (const r of records) {
      expect(r).toMatchObject({ event: 'search.timing', searchId: 'search-1', traceId: 'trace-1', requestId: 'req-1', mcpCallId: 'call-1' });
      expect(r.operationId).toEqual(expect.any(String));
      expect(Number.isFinite(r.durationMs) && r.durationMs >= 0).toBe(true);
      expect(Number.isFinite(r.startOffsetMs) && r.startOffsetMs >= 0).toBe(true);
      expect(new Date(r.startedAt).toISOString()).toBe(r.startedAt);
    }
    expect(new Set(records.map(r => r.operationId)).size).toBe(1);
    expect(JSON.stringify(records)).not.toMatch(/SECRET_|example\.com/);
    expect(response.content[0].text).not.toMatch(/operationId|searchId|startOffsetMs/);
    expect(records.filter(r => r.stage === 'mcp.request.total')).toHaveLength(1);
    const batch = records.find(r => r.stage === 'mcp.crawl.batch');
    const pages = records.filter(r => r.stage === 'mcp.crawl.page');
    expect(batch.inclusive).toBe(true);
    expect(Math.max(...pages.map(r => r.startOffsetMs))).toBeLessThan(Math.min(...pages.map(r => r.startOffsetMs + r.durationMs)));
    for (const page of pages) {
      expect(page.startOffsetMs).toBeGreaterThanOrEqual(batch.startOffsetMs);
      expect(page.startOffsetMs + page.durationMs).toBeLessThanOrEqual(batch.startOffsetMs + batch.durationMs);
    }
    const pack = records.find(r => r.stage === 'mcp.pack');
    expect(pack.inclusive).toBe(true);
    expect(records.some(r => r.stage === 'mcp.serialization' && r.startOffsetMs >= pack.startOffsetMs && r.startOffsetMs + r.durationMs <= pack.startOffsetMs + pack.durationMs)).toBe(true);
  });

  it('keeps selected source indices through reversed cache completions and mixed crawl outcomes', async () => {
    const records = capture();
    const { server, call } = fixture();
    const pending: Array<{ index: number; resolve: (value: any) => void }> = [];
    const page = (index: number) => ({ success: true, url: `https://example.com/${index}`, data: { markdown: '# Page\n\nTiming evidence.', metadata: { word_count: 3 } } });
    server.cache.get.mockImplementation((key: string) => key.startsWith('scrape_url:')
      ? new Promise(resolve => pending.push({ index: Number(key.match(/example\.com\/(\d)/)![1]), resolve }))
      : Promise.resolve(null));
    server._scrapeClient.scrape.mockImplementation(async (url: string) => {
      const index = Number(url.split('/').pop());
      if (index === 3) throw Object.assign(new Error('SECRET_TIMEOUT'), { code: 'ETIMEDOUT' });
      if (index === 2) return { success: false, error: 'SECRET_FAILURE' };
      if (index === 4) return { success: true, data: { markdown: '', metadata: { word_count: 0 } } };
      return page(index);
    });
    const response = call('research', { query: 'timing', breadth: 'multi', max_results: 5 }, { 'seek/timing': { searchId: 'source-order' } });
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    for (const item of [...pending].reverse()) item.resolve(item.index === 0 ? page(0) : null);
    const body = JSON.parse((await response).content[0].text);
    expect(body.results.map((r: any) => r.url)).toEqual(Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`));
    expect(records.filter(r => r.stage === 'mcp.cache.get' && r.status !== 'miss').map(r => r.sourceIndex)).toEqual([0]);
    expect(records.filter(r => r.stage === 'mcp.cache.get' && r.sourceIndex !== undefined).map(r => r.sourceIndex)).toEqual([4, 3, 2, 1, 0]);
    for (const [sourceIndex, status] of ['cached', 'success', 'error', 'timeout', 'error'].entries()) {
      const pageRecords = records.filter(r => r.sourceIndex === sourceIndex);
      expect(pageRecords).toContainEqual(expect.objectContaining({ stage: 'mcp.crawl.page', status }));
      for (const stage of ['mcp.parse', 'mcp.rank']) {
        expect(pageRecords.filter(r => r.stage === stage)).toEqual([
          expect.objectContaining({ status: sourceIndex < 2 ? 'success' : 'skipped' }),
        ]);
      }
      expect(pageRecords.some(r => r.stage === 'mcp.cache.get')).toBe(true);
    }
    expect(new Set(records.map(r => r.operationId)).size).toBe(1);
    expect(records.every(r => r.searchId === 'source-order')).toBe(true);
    expect(records.find(r => r.stage === 'mcp.crawl.batch')).not.toHaveProperty('sourceIndex');
    expect(records.find(r => r.stage === 'mcp.request.total')).not.toHaveProperty('sourceIndex');
    expect(JSON.stringify(records)).not.toMatch(/SECRET|example\.com/);
    expect(JSON.stringify(body)).not.toMatch(/sourceIndex|operationId|searchId/);
  });

  it('indexes direct scrape and read-more page stages as source zero', async () => {
    const records = capture();
    const { server, call } = fixture();
    const first = JSON.parse((await call('scrape_url', { url: 'https://example.com/read' })).content[0].text);
    await call('scrape_url', { document_id: first.document_id, query: 'evidence' });
    server._scrapeClient.scrape.mockRejectedValueOnce(new Error('SECRET_FAILURE'));
    await call('scrape_url', { url: 'https://example.com/failure' });
    for (const stage of ['mcp.crawl.page', 'mcp.parse', 'mcp.rank']) {
      const stages = records.filter(r => r.stage === stage);
      expect(stages).toHaveLength(3);
      expect(stages.every(r => r.sourceIndex === 0)).toBe(true);
      expect(stages[2].status).toBe(stage === 'mcp.crawl.page' ? 'error' : 'skipped');
    }
    expect(records.filter(r => r.stage === 'mcp.cache.get' || r.stage === 'mcp.cache.set').every(r => r.sourceIndex === 0)).toBe(true);
    expect(records.filter(r => r.stage === 'mcp.request.total').every(r => r.sourceIndex === undefined)).toBe(true);
  });

  it('indexes per-page crawl and cache records on the legacy HTTP workflow too', async () => {
    const records = capture();
    const { server } = fixture();
    const response = await withSearchTiming(undefined, 'search_and_scrape', () => server.handleSearchAndScrape({ query: 'timing', maxResults: 2, scrapeAll: true }));
    expect(JSON.parse((response as any).content[0].text).results).toHaveLength(2);
    expect(records.filter(r => r.stage === 'mcp.crawl.page').map(r => r.sourceIndex)).toEqual([0, 1]);
    expect(records.filter(r => r.stage === 'mcp.cache.set').map(r => r.sourceIndex)).toEqual([0, 1]);
  });

  it('times image fallback and reports cached no-work without re-running providers', async () => {
    const records = capture();
    const { server, call } = fixture();
    const image = { title: 'Image', url: 'https://example.com/page', source: [{ url: 'https://example.com/img.jpg', width: 100, height: 100 }] };
    server.fourget.searchImages = vi.fn(async () => ({ status: 'ok', image: [image] }));
    server.searxng.search = vi.fn(async () => ({ results: [] }));
    const first = await call('search_images', { query: 'SECRET_QUERY' });
    expect(JSON.parse(first.content[0].text).images).toHaveLength(1);
    expect(records.map(r => r.stage)).toEqual(expect.arrayContaining([
      'mcp.images.total', 'mcp.images.primary', 'mcp.images.fallback', 'mcp.images.normalize', 'mcp.cache.get', 'mcp.cache.set',
    ]));
    records.length = 0;
    server.cache.get.mockResolvedValue(first);
    const cached = await call('search_images', { query: 'SECRET_QUERY' });
    expect(cached).toBe(first);
    expect(server.fourget.searchImages).toHaveBeenCalledTimes(1);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.images.primary', status: 'cached' }),
      expect.objectContaining({ stage: 'mcp.images.fallback', status: 'cached' }),
      expect.objectContaining({ stage: 'mcp.request.total', status: 'cached' }),
    ]));
  });

  it('reports cached research and quick-mode crawl as explicit no-work', async () => {
    const records = capture();
    const { server, call } = fixture();
    const first = await call('research', { query: 'timing' });
    records.length = 0;
    server.cache.get.mockResolvedValue(first);
    expect(await call('research', { query: 'timing' })).toBe(first);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.discovery', status: 'cached' }),
      expect.objectContaining({ stage: 'mcp.crawl.batch', status: 'cached' }),
      expect.objectContaining({ stage: 'mcp.pack', status: 'cached' }),
      expect.objectContaining({ stage: 'mcp.request.total', status: 'cached' }),
    ]));
    records.length = 0;
    server.cache.get.mockResolvedValue(null);
    await call('research', { query: 'timing', depth: 'quick' });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.crawl.batch', status: 'skipped' }),
      expect.objectContaining({ stage: 'mcp.parse', status: 'skipped' }),
      expect.objectContaining({ stage: 'mcp.rank', status: 'skipped' }),
    ]));
  });

  it('covers direct scrape and read-more without inventing a second crawl', async () => {
    const records = capture();
    const { server, call } = fixture();
    const first = JSON.parse((await call('scrape_url', { url: 'https://example.com/read' })).content[0].text);
    expect(first.document_id).toEqual(expect.any(String));
    records.length = 0;
    await call('scrape_url', { document_id: first.document_id, query: 'evidence' });
    expect(server._scrapeClient.scrape).toHaveBeenCalledTimes(1);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.document.get', status: 'success' }),
      expect.objectContaining({ stage: 'mcp.crawl.page', status: 'cached' }),
      expect.objectContaining({ stage: 'mcp.parse', status: 'cached' }),
      expect.objectContaining({ stage: 'mcp.rank', status: 'success' }),
      expect.objectContaining({ stage: 'mcp.pack', status: 'success', inclusive: true }),
    ]));
    expect(records.filter(r => r.stage === 'mcp.request.total')).toHaveLength(1);
  });

  it('labels validation failure without running discovery', async () => {
    const records = capture();
    const { server, call } = fixture();
    await call('research', { query: '', max_tokens: 1 });
    expect(server.fourget.search).not.toHaveBeenCalled();
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.validation', status: 'validation_error' }),
      expect.objectContaining({ stage: 'mcp.discovery', status: 'skipped' }),
      expect.objectContaining({ stage: 'mcp.request.total', status: 'validation_error' }),
    ]));
  });

  it('preserves success and output bytes when timing logging throws', async () => {
    const { server, call } = fixture();
    const expected = await server.handleSearchWeb({ query: 'timing' });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('log sink unavailable'); });
    expect(await call('search_web', { query: 'timing' })).toEqual(expected);
  });

  it('isolates concurrent calls and accepts only bounded IDs from params metadata', async () => {
    const records = capture();
    const { call } = fixture();
    await Promise.all([
      call('search_web', { query: 'a', _meta: { 'seek/timing': { searchId: 'arguments-spoof' } } }, {
        'seek/timing': { searchId: 'A', traceId: '\nSECRET', requestId: 'x'.repeat(129), mcpCallId: { secret: true } },
      }),
      call('research', { query: 'b', depth: 'quick' }, { 'seek/timing': { searchId: 'B' } }),
    ]);
    const totals = records.filter(r => r.stage === 'mcp.request.total');
    expect(totals).toHaveLength(2);
    expect(new Set(totals.map(r => r.operationId)).size).toBe(2);
    for (const total of totals) {
      expect(['A', 'B']).toContain(total.searchId);
      for (const r of records.filter(r => r.operationId === total.operationId)) {
        expect(r.searchId).toBe(total.searchId);
        expect(r.traceId).toBeUndefined();
        expect(r.requestId).toBeUndefined();
        expect(r.mcpCallId).toBeUndefined();
      }
    }
    expect(JSON.stringify(records)).not.toMatch(/SECRET|arguments-spoof/);
  });

  it('times thrown timeouts and resolved crawl failures without exposing messages', async () => {
    const records = capture();
    const { server, call } = fixture();
    server.fourget.search.mockRejectedValueOnce(Object.assign(new Error('SECRET_TIMEOUT'), { code: 'ETIMEDOUT' }));
    server.searxng.search.mockResolvedValueOnce({ results: [{ title: 'Page', url: 'https://example.com/error', content: 'snippet' }] });
    server._scrapeClient.scrape.mockResolvedValueOnce({ success: false, url: 'https://example.com/error', error: 'SECRET_FAILURE' });
    await call('research', { query: 'timing' });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.provider.fourget', status: 'timeout' }),
      expect.objectContaining({ stage: 'mcp.provider.searxng', status: 'success' }),
      expect.objectContaining({ stage: 'mcp.crawl.page', status: 'error' }),
      expect.objectContaining({ stage: 'mcp.crawl.batch', status: 'partial' }),
      expect.objectContaining({ stage: 'mcp.request.total', status: 'partial' }),
    ]));
    expect(JSON.stringify(records)).not.toContain('SECRET');
  });

  it('reports optional cache backend failures without changing best-effort behavior', async () => {
    const records = capture();
    const cache = Object.create(RedisCache.prototype) as any;
    cache.enabled = true;
    cache.client = {
      get: vi.fn().mockRejectedValue(Object.assign(new Error('SECRET_REDIS'), { code: 'ETIMEDOUT' })),
      setex: vi.fn().mockRejectedValue(new Error('SECRET_REDIS')),
    };
    await withSearchTiming(undefined, 'research', async () => {
      expect(await cache.get('SECRET_KEY')).toBeNull();
      await expect(cache.set('SECRET_KEY', { secret: 'SECRET_DOC' }, 300000)).resolves.toBeUndefined();
    });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.cache.backend.get', status: 'timeout' }),
      expect.objectContaining({ stage: 'mcp.cache.serialization', status: 'success' }),
      expect.objectContaining({ stage: 'mcp.cache.backend.set', status: 'error' }),
    ]));
    expect(JSON.stringify(records)).not.toContain('SECRET');
  });

  it('does not write timing records to stdout, even with MCP_MODE enabled', async () => {
    const records = capture();
    const stdout = vi.spyOn(process.stdout, 'write');
    vi.stubEnv('MCP_MODE', '1');
    try {
      await withSearchTiming(undefined, 'research', async () => ({ content: [{ text: '{}' }] }));
      expect(stdout).not.toHaveBeenCalled();
      expect(records).toEqual([expect.objectContaining({ stage: 'mcp.request.total' })]);
    } finally { vi.unstubAllEnvs(); }
  });

  it('marks unused discovery providers and partial discovery truthfully', async () => {
    const records = capture();
    const { server, call } = fixture();
    await call('search_web', { query: 'timing' });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.provider.searxng', status: 'skipped' }),
    ]));
    records.length = 0;
    server.searxng.search.mockResolvedValueOnce({ results: [] });
    await call('search_web', { query: 'timing', categories: 'science' });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.provider.fourget', status: 'skipped' }),
    ]));
    records.length = 0;
    server.fourget.search.mockResolvedValueOnce({ status: 'ok', web: [{ title: 'Page', url: 'https://example.com/partial' }] });
    server.searxng.search.mockRejectedValueOnce(new Error('SECRET_UPSTREAM'));
    await call('search_web', { query: 'timing' });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.provider.searxng', status: 'error' }),
      expect.objectContaining({ stage: 'mcp.discovery', status: 'partial' }),
      expect.objectContaining({ stage: 'mcp.request.total', status: 'partial' }),
    ]));
  });

  it('reports retained partial discovery even when all normal research crawls succeed', async () => {
    const records = capture();
    const { server, call } = fixture();
    server.fourget.search.mockResolvedValueOnce({ status: 'ok', web: [{ title: 'Page', url: 'https://example.com/partial', description: 'SECRET_SNIPPET' }] });
    server.searxng.search.mockRejectedValueOnce(new Error('SECRET_UPSTREAM'));
    const body = JSON.parse((await call('research', { query: 'timing', depth: 'normal' })).content[0].text);
    expect(body.research_metadata).toMatchObject({ discovery_route: 'fourget-partial', pages_scraped: 1, errors: [] });
    expect(body.results).toEqual([expect.objectContaining({ url: 'https://example.com/partial', source_type: 'scraped', success: true })]);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.provider.searxng', status: 'error' }),
      expect.objectContaining({ stage: 'mcp.discovery', status: 'partial' }),
      expect.objectContaining({ stage: 'mcp.crawl.page', status: 'success', sourceIndex: 0 }),
      expect.objectContaining({ stage: 'mcp.crawl.batch', status: 'success' }),
      expect.objectContaining({ stage: 'mcp.request.total', status: 'partial' }),
    ]));
    expect(JSON.stringify(records)).not.toMatch(/SECRET|example\.com/);
  });

  it('instruments the real HTTP convenience dispatch as well as the SDK path', async () => {
    const records = capture();
    vi.stubEnv('MCP_HTTP_PORT', '0');
    vi.stubEnv('CACHE_ENABLED', 'false');
    vi.stubEnv('MCP_INTERNAL_TOKEN', '');
    const host = new SearXNGMCPServer() as any;
    const originalCache = host.cache;
    try {
      const { server } = fixture();
      host.cache = server.cache;
      host.fourget = server.fourget;
      host.searxng = server.searxng;
      if (!host.httpServer.listening) await new Promise(resolve => host.httpServer.once('listening', resolve));
      const port = host.httpServer.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/mcp/tool/search_web`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: { query: 'timing' }, _meta: { 'seek/timing': { searchId: 'http-1' } } }),
      });
      expect(response.ok).toBe(true);
      expect((await response.json()).ok).toBe(true);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'mcp.discovery', searchId: 'http-1' }),
        expect.objectContaining({ stage: 'mcp.request.total', searchId: 'http-1', status: 'success' }),
      ]));
    } finally {
      host.httpServer.closeAllConnections();
      await new Promise<void>(resolve => host.httpServer.close(() => resolve()));
      await originalCache.disconnect();
      vi.unstubAllEnvs();
    }
  });

  it('labels empty successful crawls as failed work and skipped cache writes', async () => {
    const records = capture();
    const { server, call } = fixture();
    server._scrapeClient.scrape.mockResolvedValue({ success: true, data: { markdown: '', metadata: { word_count: 0 } } });
    await call('research', { query: 'timing', max_results: 1 });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.crawl.page', status: 'error' }),
      expect.objectContaining({ stage: 'mcp.cache.set', status: 'skipped' }),
      expect.objectContaining({ stage: 'mcp.parse', status: 'skipped' }),
      expect.objectContaining({ stage: 'mcp.rank', status: 'skipped' }),
    ]));
    expect(server.cache.set).not.toHaveBeenCalled();
  });

  it('retains partial images on fallback timeout and never logs error messages', async () => {
    const records = capture();
    const { server, call } = fixture();
    server.fourget.searchImages = vi.fn(async () => ({ status: 'ok', image: [{ title: 'Page', url: 'https://example.com/page', source: [{ url: 'https://example.com/image.jpg' }] }] }));
    server.searxng.search.mockRejectedValue(Object.assign(new Error('SECRET_NETWORK'), { code: 'ETIMEDOUT' }));
    const response = await call('search_images', { query: 'timing' });
    expect(JSON.parse(response.content[0].text).images).toHaveLength(1);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'mcp.images.fallback', status: 'timeout' }),
      expect.objectContaining({ stage: 'mcp.images.total', status: 'partial' }),
      expect.objectContaining({ stage: 'mcp.request.total', status: 'partial' }),
    ]));
    expect(JSON.stringify(records)).not.toContain('SECRET');
  });
});
