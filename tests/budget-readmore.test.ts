import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/document-store.js';
import { SearXNGMCPServer } from '../src/index.js';
import { parseDocumentSections } from '../src/passage-extractor.js';
import { countResponseTokens } from '../src/token-budget.js';

const PAGE = [
  '## Other Topic',
  '',
  'This section talks about chairs and furniture.',
  '',
  '## Install Fastify',
  '',
  'Create the project first.',
  '',
  '```js',
  'const app = fastify()',
  '',
  'app.listen()',
  '```',
  '',
  'Then start the server.',
].join('\n');

function scrapeOk(url: string, markdown = PAGE) {
  return {
    success: true,
    url,
    data: {
      markdown,
      metadata: {
        title: 'Docs',
        description: '',
        language: 'en',
        word_count: markdown.split(/\s+/).length,
      },
    },
  };
}

function createHarness() {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  const store = new Map<string, unknown>();
  const sets: Array<{ key: string; value: unknown; ttl?: number }> = [];
  let scrapeCalls = 0;
  server.cache = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: unknown, ttl?: number) => {
      sets.push({ key, value, ttl });
      store.set(key, value);
    },
  };
  server.documentStore = new DocumentStore();
  server.getScrapeClient = () => ({
    scrape: async (url: string) => {
      scrapeCalls += 1;
      return scrapeOk(url);
    },
  });
  server.fourget = {
    search: async () => {
      throw new Error('fourget should not run');
    },
  };
  server.searxng = {
    search: async () => {
      throw new Error('searxng should not run');
    },
  };
  return {
    server,
    sets,
    store,
    get scrapeCalls() {
      return scrapeCalls;
    },
  };
}

function decode(response: { content: Array<{ text: string }> }) {
  const text = response.content[0].text;
  return { text, body: JSON.parse(text) as any };
}

describe('scrape_url budget and saved-document reads', () => {
  it('rejects contradictory selectors before any crawl', async () => {
    const harness = createHarness();
    const both = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/docs',
      document_id: '11111111-1111-1111-1111-111111111111',
    }));
    const sectionWithQuery = decode(await harness.server.handleScrapeUrl({
      document_id: '11111111-1111-1111-1111-111111111111',
      query: 'fastify',
      section_ids: ['s0'],
    }));
    const badOffset = decode(await harness.server.handleScrapeUrl({
      document_id: '11111111-1111-1111-1111-111111111111',
      list_sections: true,
      section_offset: -1,
    }));
    const badTokens = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/docs',
      max_tokens: 3.5,
    }));

    expect(both.body.error).toBe('invalid_arguments');
    expect(sectionWithQuery.body.error).toBe('invalid_arguments');
    expect(badOffset.body.error).toBe('invalid_arguments');
    expect(badTokens.body.error).toBe('invalid_arguments');
    expect(harness.scrapeCalls).toBe(0);
  });

  it('reuses a saved URL snapshot for a different query and never fetches on document_id', async () => {
    const harness = createHarness();
    const first = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/docs',
      query: 'fastify listen',
    }));
    expect(first.body.document_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.body.relevant_passages.passages[0].section_id).toMatch(/^s\d+$/);
    expect(first.body.data?.markdown).toBeUndefined();
    expect(first.body.budget.used).toBe(countResponseTokens(first.text));
    expect(harness.scrapeCalls).toBe(1);

    const second = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/docs',
      query: 'chairs furniture',
    }));
    expect(second.body.document_id).toBe(first.body.document_id);
    expect(second.body.relevant_passages.passages.some((p: { text: string }) => p.text.includes('chairs'))).toBe(true);
    expect(harness.scrapeCalls).toBe(1);

    const byId = decode(await harness.server.handleScrapeUrl({
      document_id: first.body.document_id,
      query: 'fastify listen',
    }));
    expect(byId.body.document_id).toBe(first.body.document_id);
    expect(harness.scrapeCalls).toBe(1);
  });

  it('returns document_unavailable for unknown/expired ids without fetching', async () => {
    const harness = createHarness();
    const missing = decode(await harness.server.handleScrapeUrl({
      document_id: '00000000-0000-4000-8000-000000000000',
    }));
    expect(missing.body.error).toBe('document_unavailable');
    expect(missing.body.guidance).toMatch(/url/i);
    expect(harness.scrapeCalls).toBe(0);

    const clock = { value: 1_000 };
    harness.server.documentStore = new DocumentStore({ now: () => clock.value, ttlMs: 10 });
    const saved = harness.server.documentStore.save({
      url: 'https://example.com/docs',
      title: 'Docs',
      markdown: PAGE,
      sections: parseDocumentSections(PAGE),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    clock.value += 11;
    const expired = decode(await harness.server.handleScrapeUrl({
      document_id: saved.document.document_id,
      query: 'fastify',
    }));
    expect(expired.body.error).toBe('document_unavailable');
    expect(harness.scrapeCalls).toBe(0);
  });

  it('retrieves an initially omitted section and pages the outline until every id is found', async () => {
    const harness = createHarness();
    const many = Array.from({ length: 12 }, (_, i) => (
      `## Section ${i}\n\nBody ${i} about fastify listen. ${'detail '.repeat(40)}${i}`
    )).join('\n\n');
    harness.server.getScrapeClient = () => ({
      scrape: async (url: string) => scrapeOk(url, many),
    });

    const first = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/many',
      query: 'fastify listen',
      max_tokens: 700,
    }));
    const omittedId = first.body.sections.omitted_preview[0].id;
    expect(omittedId).toBeDefined();

    const retrieved = decode(await harness.server.handleScrapeUrl({
      document_id: first.body.document_id,
      section_ids: [omittedId],
      max_tokens: 6000,
    }));
    expect(retrieved.body.relevant_passages.passages).toHaveLength(1);
    expect(retrieved.body.relevant_passages.passages[0].section_id).toBe(omittedId);
    expect(retrieved.body.relevant_passages.passages[0].text).toContain('Body');

    const unknown = decode(await harness.server.handleScrapeUrl({
      document_id: first.body.document_id,
      section_ids: ['s999'],
    }));
    expect(unknown.body.error).toBe('invalid_arguments');

    const seen = new Set<string>();
    let offset = 0;
    for (let i = 0; i < 20; i++) {
      const page = decode(await harness.server.handleScrapeUrl({
        document_id: first.body.document_id,
        list_sections: true,
        section_offset: offset,
        max_tokens: 512,
      }));
      expect(page.body.list_sections).toBe(true);
      expect(page.body.sections.every((s: { text?: string }) => s.text === undefined)).toBe(true);
      for (const section of page.body.sections) seen.add(section.id);
      if (page.body.next_offset == null) break;
      offset = page.body.next_offset;
    }
    expect(seen).toEqual(new Set(parseDocumentSections(many).map((s) => s.id)));
  });
});

describe('research budget and saved-document handles', () => {
  it('validates max_tokens before discovery or scrape', async () => {
    const harness = createHarness();
    const result = decode(await harness.server.handleResearch({
      query: 'fastify listen',
      max_tokens: 100,
    }));
    expect(result.body.error).toBe('invalid_arguments');
    expect(harness.scrapeCalls).toBe(0);
  });

  it('defaults normal research to relevant_only, exposes handles, and invalidates stale cached ids', async () => {
    const harness = createHarness();
    harness.server.fourget = {
      search: async () => ({
        status: 'ok',
        web: Array.from({ length: 5 }, (_, i) => ({
          title: `Docs ${i}`,
          url: `https://example.com/docs-${i}`,
          description: 'fastify listen',
          date: null,
          type: 'web',
        })),
        answer: [],
        npt: '',
      }),
    };

    const first = decode(await harness.server.handleResearch({ query: 'fastify listen' }));
    expect(first.body.results[0].data?.markdown).toBeUndefined();
    expect(first.body.results[0].document_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.body.results[0].sections.total).toBe(
      first.body.results[0].sections.included + first.body.results[0].sections.omitted,
    );
    expect(first.body.budget.used).toBe(countResponseTokens(first.text));
    expect(first.body.budget.used).toBeLessThanOrEqual(6000);
    expect(harness.sets.some((entry) => String(entry.key).startsWith('research:v5'))).toBe(true);

    const cached = decode(await harness.server.handleResearch({ query: 'fastify listen' }));
    expect(cached.body.results[0].document_id).toBe(first.body.results[0].document_id);
    const beforeEvict = harness.scrapeCalls;

    harness.server.documentStore = new DocumentStore();
    const afterEvict = decode(await harness.server.handleResearch({ query: 'fastify listen' }));
    expect(afterEvict.body.results[0].document_id).not.toBe(first.body.results[0].document_id);
    expect(harness.server.documentStore.has(first.body.results[0].document_id)).toBe(false);
    expect(harness.scrapeCalls).toBeGreaterThanOrEqual(beforeEvict);
  });
});
