import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ScrapeClient, scrapeProvenance } from '../src/scrape-client.js';
import { SearXNGMCPServer } from '../src/index.js';
import { countResponseTokens } from '../src/token-budget.js';
vi.mock('axios');
const post = vi.mocked(axios.post);
const raw = (markdown = 'The answer is 42.', extras: Record<string, unknown> = {}) => ({
  success: true, data: { markdown, metadata: { title: 'Answer', statusCode: 200, renderedWith: 'http' } }, ...extras,
});
beforeEach(() => vi.clearAllMocks());
function serverWithCache() {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  const cache = new Map();
  server.cache = { get: vi.fn(async (key: string) => cache.get(key)), set: vi.fn(async (key: string, value: unknown) => { cache.set(key, value); }) };
  server._scrapeClient = new ScrapeClient('http://crawler');
  return server;
}
describe('handler evidence cache policy', () => {
  it.each([false, true])('whole research handler caches only clean bundles (degraded=%s)', async (degraded) => {
    const server = serverWithCache();
    const rows = Array.from({ length: 6 }, (_, i) => ({ title: `Answer ${i}`, url: `https://a.test/${i}`, description: 'discovery snippet' }));
    server.fourget = { search: vi.fn(async () => ({ status: 'ok', web: rows, answer: [], npt: '' })) };
    server.searxng = { search: vi.fn() };
    post.mockResolvedValue({ data: raw('The answer is 42.', degraded ? { warning: 'js_escalation_failed: Timeout after 2916ms' } : {}) });
    const run = () => server.handleResearch({ query: 'answer', depth: 'normal', breadth: 'multi' });
    await run();
    await run();
    expect(server.fourget.search).toHaveBeenCalledTimes(degraded ? 2 : 1);
    expect(post).toHaveBeenCalledTimes(degraded ? 10 : 5);
    expect(server.cache.get.mock.calls[0][0]).toMatch(/^research:v6:/);
  });
  it.each([
    ['loading', 'Loading...', {}],
    ['loading heading', '# Loading...', {}],
    ['login', '# [Quotes to Scrape](/)\n\n[Login](/login)', {}],
    ['declared shell', 'Navigation only', { data: { ...raw().data, block: { vendor: 'structural_failure', reason: 'empty shell' } } }],
    ['fallback', 'The answer is 42.', { warning: 'JS render failed; using HTTP fallback' }],
  ])('does not cache %s pages or research bundles', async (_name, markdown, extras) => {
    post.mockResolvedValue({ data: raw(markdown, extras) });
    const server = serverWithCache();
    const hits = [{ url: 'https://a.test', title: 'Answer', content: 'discovery snippet' }];
    const run = () => server.handleNormalResearch('answer', 'multi', hits, 'full', undefined, 1, [], Date.now(), 'research:test', 'fourget');
    const first = JSON.parse((await run()).content[0].text);
    await run();
    expect(post).toHaveBeenCalledTimes(2);
    expect(server.cache.set).not.toHaveBeenCalled();
    expect(first.research_metadata.errors).toHaveLength(1);
    expect(first.results[0].fetch.outcome).toBe(_name === 'fallback' ? 'degraded' : 'unusable');
    if (_name === 'fallback') expect(first.results[0].data.markdown).toContain('42');
    else expect(first.results[0].success).toBe(false);
  });
  it('caches valid short pages, versions keys, and preserves the auto policy', async () => {
    post.mockResolvedValue({ data: raw() });
    const server = serverWithCache();
    await server.cachedScrapeUrl('https://a.test', ['markdown'], 3000);
    await server.cachedScrapeUrl('https://a.test', ['markdown'], 3000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({ url: 'https://a.test', formats: ['markdown'], deadlineMs: 3000 });
    expect(server.cache.set.mock.calls[0][0]).toMatch(/^scrape_url:v3:/);
  });
  it('preserves degraded provenance and exact budgets through handlers and saved read-more', async () => {
    post.mockResolvedValue({ data: raw('## Answer\n\nThe answer is 42.', { warning: 'JS render failed; using HTTP fallback' }) });
    const server = serverWithCache();
    const response = await server.handleScrapeUrl({ url: 'https://a.test', content_mode: 'full', max_tokens: 1200 });
    const first = JSON.parse(response.content[0].text);
    expect(first.fetch.outcome).toBe('degraded');
    expect(first.data.markdown).toContain('42');
    expect(countResponseTokens(response.content[0].text)).toBe(first.budget.used);
    expect(first.budget.used).toBeLessThanOrEqual(1200);
    const again = JSON.parse((await server.handleScrapeUrl({ document_id: first.document_id, content_mode: 'full', max_tokens: 1200 })).content[0].text);
    expect(again.fetch.outcome).toBe('degraded');
    // A URL fetch must not silently reuse a degraded saved snapshot as clean evidence.
    await server.handleScrapeUrl({ url: 'https://a.test', content_mode: 'full', max_tokens: 1200 });
    expect(post).toHaveBeenCalledTimes(2);
  });
});
describe('crawler diagnostics', () => {
  it.each(['errorCode', 'error_code'])('preserves bounded aliases and failed-render fallback (%s)', async (alias) => {
    post.mockResolvedValue({ data: raw('Useful HTTP fallback remains readable.', {
      [alias]: 'render_failed', warning: 'JS render failed; using HTTP fallback',
      data: { ...raw().data, markdown: 'Useful HTTP fallback remains readable.', warnings: ['lightpandaTimeout', 'x'.repeat(2000)], renderDecision: { kind: 'failover', chain: ['http', 'lightpanda'], reason: 'lightpandaTimeout', secret: 'never' } },
    }) });
    const result = await new ScrapeClient().scrape('https://a.test');
    expect(result.success).toBe(true);
    expect(result.data?.markdown).toContain('Useful HTTP');
    const fetch = scrapeProvenance(result) as any;
    expect(fetch).toMatchObject({ outcome: 'degraded', error_code: 'render_failed', render_decision: { kind: 'failover', reason: 'lightpandaTimeout' } });
    expect(fetch.warnings).toContain('lightpandaTimeout');
    expect(JSON.stringify(fetch)).not.toContain('never');
    expect(JSON.stringify(fetch).length).toBeLessThan(2000);
  });
});
describe('crawler wire policy', () => {
  it('keeps wait controls absent in the public schema and isolates explicit URL controls from saved defaults', async () => {
    const server = serverWithCache();
    let listTools: any;
    server.setupToolHandlers({ setRequestHandler: (_schema: unknown, handler: any) => { listTools ??= handler; } });
    const tools = await listTools();
    const schema = tools.tools.find((tool: any) => tool.name === 'scrape_url').inputSchema;
    expect(schema.properties.wait_for).not.toHaveProperty('default');
    post.mockResolvedValue({ data: raw() });
    await server.handleScrapeUrl({ url: 'https://a.test' });
    await server.handleScrapeUrl({ url: 'https://a.test', wait_for: 0 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toMatchObject({ waitFor: 0 });
  });
  it('does not serve one render policy as another from the saved document shortcut', async () => {
    const server = serverWithCache();
    post.mockResolvedValueOnce({ data: raw('Default auto evidence.') }).mockResolvedValueOnce({ data: raw('Explicit wait evidence.') });
    const first = JSON.parse((await server.handleScrapeUrl({ url: 'https://a.test', content_mode: 'full' })).content[0].text);
    const explicit = JSON.parse((await server.handleScrapeUrl({ url: 'https://a.test', content_mode: 'full', wait_for: 1200 })).content[0].text);
    expect(first.data.markdown).toBe('Default auto evidence.');
    expect(explicit.data.markdown).toBe('Explicit wait evidence.');
    const again = JSON.parse((await server.handleScrapeUrl({ url: 'https://a.test', content_mode: 'full' })).content[0].text);
    expect(again.data.markdown).toBe('Default auto evidence.');
  });
  it('forwards explicit supported controls, including zero/false, without injecting defaults', async () => {
    post.mockResolvedValue({ data: raw() });
    const client = new ScrapeClient('http://crawler');
    await client.scrape('https://a.test', { timeout: 3000, wait_for: 0, renderJs: false, onlyMainContent: false, renderer: 'lightpanda' } as any);
    expect(post.mock.calls[0][1]).toEqual({ url: 'https://a.test', formats: ['markdown'], deadlineMs: 3000, waitFor: 0, renderJs: false, onlyMainContent: false, renderer: 'lightpanda' });
    expect(post.mock.calls[0][2]).toMatchObject({ timeout: 4000 });
    await client.scrape('https://a.test', { timeout: 3000, wait_for: 120 });
    expect(post.mock.calls[1][1]).toMatchObject({ waitFor: 120 });
    await client.scrape('https://a.test');
    expect(post.mock.calls[2][1]).toEqual({ url: 'https://a.test', formats: ['markdown'], deadlineMs: 30000 });
  });
});
