import { describe, expect, it, vi } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';
import { WebFetchTool } from '../src/tools/webfetch.js';
import { WebSearchTool } from '../src/tools/websearch.js';
import { countResponseTokens } from '../src/token-budget.js';

function harness() {
  const host = Object.create(SearXNGMCPServer.prototype) as any;
  const handlers = new Map<string, any>();
  host.cache = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
  host.fourget = { search: vi.fn(async () => ({ status: 'ok', web: Array.from({ length: 5 }, (_, i) => ({ title: `Hit ${i}`, url: `https://example.com/${i}`, description: 'Search snippet', date: null, type: 'web' })), answer: [], npt: '' })) };
  host.searxng = { search: vi.fn() };
  const scrape = vi.fn();
  host.websearch = new WebSearchTool(host.searxng, host.fourget, host.cache);
  host.webfetch = new WebFetchTool(host.cache);
  host.webfetch.getScrapeClient = () => ({ scrape });
  host.setupToolHandlers({ setRequestHandler: (schema: any, fn: any) => handlers.set(schema.shape.method.value, fn) });
  const call = (name: string, args = {}) => handlers.get('tools/call')({ params: { name, arguments: args } });
  return { host, scrape, handlers, call };
}

describe('model-controlled two-tool contract', () => {
  it('publishes exactly websearch and webfetch and rejects every legacy name', async () => {
    const h = harness();
    const list = await h.handlers.get('tools/list')({});
    expect(list.tools.map((t: any) => t.name)).toEqual(['websearch', 'webfetch']);
    for (const name of ['research', 'search_and_scrape', 'search_web', 'scrape_url', 'search_images']) {
      await expect(h.call(name)).rejects.toThrow(/Unknown tool/);
    }
  });

  it('fetches only the chosen URL, defaults to full Markdown and reads its saved snapshot without discovery', async () => {
    const h = harness();
    const markdown = '# Chosen page\n\nComplete fetched evidence.';
    h.scrape.mockImplementation(async (url: string) => ({ success: true, url, data: { markdown, metadata: { title: 'Chosen page' } } }));
    const first = await h.call('webfetch', { url: 'https://chosen.test/page' });
    const body = JSON.parse(first.content[0].text);
    expect(body.data.markdown).toBe(markdown);
    expect(body.document_id).toEqual(expect.any(String));
    const again = await h.call('webfetch', { document_id: body.document_id });
    expect(JSON.parse(again.content[0].text).data.markdown).toBe(markdown);
    expect(h.scrape).toHaveBeenCalledTimes(1);
    expect(h.scrape.mock.calls[0][0]).toBe('https://chosen.test/page');
    expect(h.host.fourget.search).not.toHaveBeenCalled();
    expect(h.host.searxng.search).not.toHaveBeenCalled();
  });

  it('points omitted-section read-more calls at webfetch, not a retired tool', async () => {
    const h = harness();
    const markdown = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${'Whole source evidence. '.repeat(15)}`).join('\n\n');
    h.scrape.mockImplementation(async (url: string) => ({ success: true, url, data: { markdown, metadata: { title: 'Large chosen page' } } }));
    const result = await h.call('webfetch', { url: 'https://chosen.test/large', max_tokens: 512 });
    const body = JSON.parse(result.content[0].text);
    expect(body.sections.omitted).toBeGreaterThan(0);
    expect(body.sections.list_more).toMatchObject({
      tool: 'webfetch',
      arguments: { document_id: body.document_id, list_sections: true },
    });
    expect(body.budget.used).toBe(countResponseTokens(result.content[0].text));
  });

  it('budgets search snippets and explicit image search to the exact serialized response', async () => {
    const h = harness();
    h.host.fourget.searchImages = vi.fn(async () => ({ status: 'ok', image: [{ title: 'Image', url: 'https://image.test/page', source: [{ url: 'https://image.test/a.jpg', width: 100, height: 100 }] }] }));
    h.host.searxng.search.mockResolvedValue({ results: [] });
    for (const categories of ['general', 'images']) {
      const result = await h.call('websearch', { query: 'snippets', categories, max_tokens: 512 });
      const body = JSON.parse(result.content[0].text);
      expect(body.budget.used).toBe(countResponseTokens(result.content[0].text));
      expect(body.budget.limit).toBe(512);
      expect(body.budget.used).toBeLessThanOrEqual(512);
      expect(body[categories === 'images' ? 'images' : 'results'].length).toBeGreaterThan(0);
    }
    expect(h.host.fourget.searchImages).toHaveBeenCalledTimes(1);
    expect(h.scrape).not.toHaveBeenCalled();
  });

  it('reports returned and omitted discovery rows honestly when the token budget drops results', async () => {
    const h = harness();
    h.host.fourget.search.mockResolvedValue({ status: 'ok', web: Array.from({ length: 5 }, (_, i) => ({
      title: `Hit ${i}`, url: `https://example.com/${i}`, description: 'Discovery snippet. '.repeat(80), date: null, type: 'web',
    })), answer: [], npt: '' });
    const response = await h.call('websearch', { query: 'budgeted snippets', max_tokens: 512 });
    const body = JSON.parse(response.content[0].text);
    expect(body.results.length).toBeLessThan(5);
    expect(body.total_results).toBe(body.results.length);
    expect(body.omitted_results).toBe(5 - body.results.length);
    expect(body.budget.used).toBe(countResponseTokens(response.content[0].text));
  });

  it('rejects fetch-only waits on document reads and invalid wait durations before any provider call', async () => {
    const h = harness();
    for (const args of [{ document_id: 'saved-id', wait_for: 0 }, { url: 'https://chosen.test', wait_for: -1 }, { url: 'https://chosen.test', wait_for: 'quick' }]) {
      const body = JSON.parse((await h.call('webfetch', args)).content[0].text);
      expect(body.error).toBe('invalid_arguments');
    }
    expect(h.scrape).not.toHaveBeenCalled();
  });

  it('returns search snippets without fetching any discovered URL', async () => {
    const h = harness();
    const result = await h.call('websearch', { query: 'model selected query' });
    const body = JSON.parse(result.content[0].text);
    expect(body.results).toHaveLength(5);
    expect(body.results[0]).toMatchObject({ url: 'https://example.com/0', content: 'Search snippet' });
    expect(h.scrape).not.toHaveBeenCalled();
  });
});
