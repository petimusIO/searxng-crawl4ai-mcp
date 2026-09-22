import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/document-store.js';
import { SearXNGMCPServer } from '../src/index.js';
import {
  parseDocumentSections,
  rankDocumentSections,
} from '../src/passage-extractor.js';
import { packBudgetedResponse, packSectionIndex } from '../src/response-packer.js';
import { countResponseTokens } from '../src/token-budget.js';

function words(count: number): string {
  return Array.from({ length: count }, () => 'word').join(' ');
}

function fixturePage(i: number): string {
  return Array.from({ length: 7 }, (_, s) => (
    `## Policy section ${s}\n\nFixture evidence about policy requirements and exceptions.\n\nSource number ${i}, section number ${s}. End of complete section.`
  )).join('\n\n');
}

function packSource(url: string, markdown: string, query: string, extras: Record<string, unknown> = {}) {
  const sections = parseDocumentSections(markdown);
  return {
    url,
    title: url,
    snippet: 'discovery snippet',
    success: true,
    source_type: 'scraped' as const,
    document_id: `doc-${url}`,
    data: { markdown, metadata: { title: url } },
    markdown,
    sections,
    ranked: rankDocumentSections(sections, query),
    ...extras,
  };
}

function scrapeOk(url: string, markdown: string) {
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

function createHarness(scrape?: (url: string) => Promise<unknown> | unknown) {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  const cache = new Map<string, unknown>();
  let scrapeCalls = 0;
  let scrapeImpl = scrape ?? (async (url: string) => scrapeOk(url, fixturePage(0)));
  server.cache = {
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
  };
  server.documentStore = new DocumentStore();
  server.getScrapeClient = () => ({
    scrape: async (url: string) => {
      scrapeCalls += 1;
      return scrapeImpl(url);
    },
  });
  server.fourget = {
    search: async () => ({ status: 'ok', web: [], answer: [], npt: '' }),
  };
  server.searxng = {
    search: async () => ({ results: [] }),
  };
  return {
    server,
    get scrapeCalls() {
      return scrapeCalls;
    },
    setScrape(next: (url: string) => Promise<unknown> | unknown) {
      scrapeImpl = next;
    },
  };
}

function decode(response: { content: Array<{ text: string }> }) {
  const text = response.content[0].text;
  return { text, body: JSON.parse(text) as any };
}

describe('1 hard cap and compact errors', () => {
  it('reserves match_status before selection so a tight multi-source pack stays at the cap', () => {
    const query = 'policy requirements exceptions';
    const sources = Array.from({ length: 5 }, (_, i) => (
      packSource(`https://budget-fixture.invalid/page${i}`, fixturePage(i), query)
    ));
    const result = packBudgetedResponse({
      query,
      contentMode: 'relevant_only',
      maxTokens: 2000,
      sources,
      envelope: {
        query,
        research_metadata: { depth: 'normal', breadth: 'multi', pages_scraped: 5, errors: [] },
      },
    });
    const body = JSON.parse(result.text);

    expect(body.budget.used).toBe(countResponseTokens(result.text));
    expect(body.budget.used).toBeLessThanOrEqual(2000);
    expect(body.error).not.toBe('budget_too_small');
    expect(body.results?.some((r: { relevant_passages?: { passages: unknown[] } }) => (
      (r.relevant_passages?.passages.length ?? 0) > 0
    ))).toBe(true);
    for (const source of body.results ?? []) {
      expect(source.match_status === 'hits' || source.match_status === 'zero_match').toBe(true);
      for (const passage of source.relevant_passages?.passages ?? []) {
        expect(passage.text.trim().endsWith('End of complete section.')).toBe(true);
      }
    }
  });

  it('computes index overflow from entry metadata and does not repeat the same cursor', () => {
    const body = `BODY ${'evidence '.repeat(400)} End of complete section.`;
    const sections = [{
      id: 's0',
      heading: `Very long heading ${'H'.repeat(240)}`,
      text: body,
      source_offset: { start: 0, end: body.length },
    }];
    const packed = packSectionIndex({
      url: 'https://a.test',
      title: 'A',
      document_id: 'doc-a',
      sections,
      sectionOffset: 0,
      maxTokens: 512,
      envelope: { padding: 'meta '.repeat(170) },
    });
    const decoded = JSON.parse(packed.text);
    const bodyTokens = countResponseTokens(body);

    expect(decoded.budget.used).toBe(countResponseTokens(packed.text));
    expect(decoded.budget.used).toBeLessThanOrEqual(512);
    if (decoded.error) {
      expect(decoded.required_tokens).toBeLessThan(bodyTokens);
      expect(decoded.next_offset).not.toBe(0);
    } else {
      expect(decoded.sections.length).toBeGreaterThan(0);
      expect(decoded.next_offset).not.toBe(0);
    }
  });

  it('compacts attacker-sized ids and uses a valid supplied budget for invalid arguments', async () => {
    const harness = createHarness();
    const huge = `id-${'x'.repeat(4000)}`;
    const unavailable = decode(await harness.server.handleScrapeUrl({
      document_id: huge,
      max_tokens: 800,
    }));
    const invalid = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/docs',
      document_id: huge,
      max_tokens: 800,
    }));

    expect(unavailable.body.error).toBe('document_unavailable');
    expect(unavailable.body.budget.limit).toBe(800);
    expect(unavailable.body.budget.used).toBe(countResponseTokens(unavailable.text));
    expect(unavailable.body.budget.used).toBeLessThanOrEqual(512);
    expect(unavailable.text).not.toContain('x'.repeat(1000));

    expect(invalid.body.error).toBe('invalid_arguments');
    expect(invalid.body.budget.limit).toBe(800);
    expect(invalid.body.budget.used).toBeLessThanOrEqual(512);
    expect(harness.scrapeCalls).toBe(0);
  });
});

describe('2 failed direct scrape is not retained', () => {
  it('does not keep failed or empty markdown and retries the next URL scrape', async () => {
    const harness = createHarness(async () => ({
      success: false,
      url: 'https://blocked.test/page',
      error: 'blocked',
      data: {
        markdown: 'Partial blocked page evidence',
        metadata: { title: 'Blocked', word_count: 4 },
      },
    }));

    const first = decode(await harness.server.handleScrapeUrl({
      url: 'https://blocked.test/page',
    }));
    expect(first.body.success).toBe(false);
    expect(first.body.error).toBe('blocked');
    expect(first.body.document_id).toBeUndefined();
    expect(harness.scrapeCalls).toBe(1);

    harness.setScrape(async (url: string) => scrapeOk(url, '## Recovered\n\nNow the page works.'));
    const second = decode(await harness.server.handleScrapeUrl({
      url: 'https://blocked.test/page',
    }));
    expect(second.body.success).toBe(true);
    expect(second.body.document_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(harness.scrapeCalls).toBe(2);
  });

  it('turns thrown scrape errors into bounded JSON instead of an RPC exception', async () => {
    const harness = createHarness(async () => {
      throw new Error(`upstream exploded ${'E'.repeat(400)}`);
    });
    const result = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/docs',
      max_tokens: 6000,
    }));
    expect(result.body.success).toBe(false);
    expect(result.body.error).toBeTruthy();
    expect(result.body.budget.used).toBeLessThanOrEqual(512);
    expect(result.text).not.toContain('upstream exploded');
    expect(harness.scrapeCalls).toBe(1);
  });
});

describe('3 canonical snapshot', () => {
  it('returns the stored snapshot instead of mixing a new body with an old id', () => {
    const server = Object.create(SearXNGMCPServer.prototype) as any;
    server.documentStore = new DocumentStore();
    const first = server.retainDocument(
      'https://same.test/page',
      'Old',
      '## Old heading\n\nOriginal stored evidence.',
    );
    const second = server.retainDocument(
      'https://same.test/page',
      'New',
      '## New heading\n\nReplacement body that must not mix with the old id.',
    );

    expect(second.document_id).toBe(first.document_id);
    expect(second.markdown).toBe(first.markdown);
    expect(second.sections).toEqual(first.sections);
    expect(second.title).toBe(first.title);
    expect(second.markdown).toContain('Original stored evidence');
    expect(second.markdown).not.toContain('Replacement body');
  });
});

describe('4 store immutability, capacity, and handle eviction', () => {
  it('clones and freezes stored evidence including section copies', () => {
    const now = { value: 10 };
    const store = new DocumentStore({ now: () => now.value });
    const sections = [{
      id: 's0',
      heading: 'Install',
      text: 'Create the project first.',
      source_offset: { start: 0, end: 25 },
      definitions: [{
        identifier: 'ref',
        text: '[ref]: https://example.com',
        source_offset: { start: 26, end: 52 },
      }],
    }];
    const saved = store.save({
      url: 'https://example.com/docs',
      title: 'Docs',
      markdown: '# Install\n\nCreate the project first.',
      sections,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    sections[0].text = 'mutated input';
    sections[0].definitions![0].text = 'mutated def';
    const got = store.get(saved.document.document_id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.document.sections[0].text).toBe('Create the project first.');
    try {
      got.document.sections[0].text = 'hacked read';
    } catch {
      // frozen snapshots may throw
    }
    expect(store.get(saved.document.document_id).ok && (store.get(saved.document.document_id) as any).document.sections[0].text)
      .toBe('Create the project first.');
    expect(got.document.saved_at).toBe(10);
    expect(got.document.expires_at).toBe(10 + 60 * 60 * 1000);
  });

  it('counts serialized section copies toward capacity and honors a zero cap', () => {
    const now = { value: 1 };
    const tight = new DocumentStore({ now: () => now.value, maxBytes: 80 });
    const oversizedSections = [{
      id: 's0',
      heading: 'Huge',
      text: 'x'.repeat(200),
      source_offset: { start: 0, end: 200 },
    }];
    expect(tight.save({
      url: 'https://example.com/huge-sections',
      title: 'Huge',
      markdown: 'tiny',
      sections: oversizedSections,
    })).toEqual({ ok: false, reason: 'too_large' });

    const zeroDocs = new DocumentStore({ now: () => now.value, maxDocuments: 0 });
    expect(zeroDocs.save({
      url: 'https://example.com/a',
      title: 'A',
      markdown: 'alpha',
      sections: [{ id: 's0', text: 'alpha', source_offset: { start: 0, end: 5 } }],
    }).ok).toBe(false);

    const zeroBytes = new DocumentStore({ now: () => now.value, maxBytes: 0 });
    expect(zeroBytes.save({
      url: 'https://example.com/b',
      title: 'B',
      markdown: 'beta',
      sections: [{ id: 's0', text: 'beta', source_offset: { start: 0, end: 4 } }],
    }).ok).toBe(false);
  });

  it('does not advertise evicted handles after multi-source retention', async () => {
    const harness = createHarness();
    harness.server.documentStore = new DocumentStore({ maxDocuments: 1, maxBytes: 32 * 1024 * 1024 });
    harness.server.fourget = {
      search: async () => ({
        status: 'ok',
        web: [
          { title: 'A', url: 'https://example.com/a', description: 'policy requirements', date: null, type: 'web' },
          { title: 'B', url: 'https://example.com/b', description: 'policy exceptions', date: null, type: 'web' },
        ],
        answer: [],
        npt: '',
      }),
    };
    harness.setScrape(async (url: string) => scrapeOk(url, fixturePage(url.endsWith('/b') ? 1 : 0)));

    const result = decode(await harness.server.handleResearch({
      query: 'policy requirements exceptions',
      depth: 'normal',
      breadth: 'multi',
    }));
    const ids = (result.body.results ?? [])
      .map((row: { document_id?: string }) => row.document_id)
      .filter((id: unknown): id is string => typeof id === 'string');
    for (const id of ids) {
      expect(harness.server.documentStore.has(id)).toBe(true);
    }
    const advertisedMissing = (result.body.results ?? []).filter((row: { document_id?: string; read_more_unavailable?: boolean }) => (
      row.document_id && !harness.server.documentStore.has(row.document_id)
    ));
    expect(advertisedMissing).toEqual([]);
    expect(result.body.results.some((row: { read_more_unavailable?: boolean; document_id?: string }) => (
      row.read_more_unavailable && !row.document_id
    ))).toBe(true);
  });
});

describe('5 selectors on first URL and argument rejection', () => {
  it('honors list_sections on the first URL scrape', async () => {
    const harness = createHarness(async (url: string) => scrapeOk(url, fixturePage(0)));
    const page = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/first',
      list_sections: true,
      max_tokens: 2000,
    }));
    expect(page.body.list_sections).toBe(true);
    expect(Array.isArray(page.body.sections)).toBe(true);
    expect(page.body.sections[0].id).toMatch(/^s\d+$/);
    expect(page.body.sections[0].text).toBeUndefined();
    expect(page.body.relevant_passages).toBeUndefined();
    expect(harness.scrapeCalls).toBe(1);
  });

  it('rejects duplicate section_ids, malformed urls, fetch-only params on doc ids, and past-end offsets', async () => {
    const harness = createHarness(async (url: string) => scrapeOk(url, fixturePage(0)));
    const first = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/docs',
    }));
    const id = first.body.document_id;

    const dup = decode(await harness.server.handleScrapeUrl({
      document_id: id,
      section_ids: ['s0', 's0'],
    }));
    const badUrl = decode(await harness.server.handleScrapeUrl({
      url: 'javascript:alert(1)',
    }));
    const ftp = decode(await harness.server.handleScrapeUrl({
      url: 'ftp://example.com/file',
    }));
    const fetchOnId = decode(await harness.server.handleScrapeUrl({
      document_id: id,
      timeout: 5000,
    }));
    const badTimeout = decode(await harness.server.handleScrapeUrl({
      url: 'https://example.com/other',
      timeout: 'fast',
    }));
    const pastEnd = decode(await harness.server.handleScrapeUrl({
      document_id: id,
      list_sections: true,
      section_offset: 99,
    }));

    expect(dup.body.error).toBe('invalid_arguments');
    expect(badUrl.body.error).toBe('invalid_arguments');
    expect(ftp.body.error).toBe('invalid_arguments');
    expect(fetchOnId.body.error).toBe('invalid_arguments');
    expect(badTimeout.body.error).toBe('invalid_arguments');
    expect(pastEnd.body.error).toBe('invalid_arguments');
    expect(harness.scrapeCalls).toBe(1);
  });
});

describe('6 depth budget', () => {
  it('caps quick snippets, deep unimplemented, and zero-result envelopes', async () => {
    const harness = createHarness();
    harness.server.fourget = {
      search: async () => ({
        status: 'ok',
        web: [{
          title: 'Quick',
          url: 'https://example.com/quick',
          description: words(1000),
          date: null,
          type: 'web',
        }],
        answer: [],
        npt: '',
      }),
    };

    const quick = decode(await harness.server.handleResearch({
      query: 'policy',
      depth: 'quick',
      max_tokens: 512,
    }));
    expect(quick.body.research_metadata?.depth).toBe('quick');
    expect(quick.body.budget.used).toBe(countResponseTokens(quick.text));
    expect(quick.body.budget.used).toBeLessThanOrEqual(512);
    expect(quick.body.budget.limit).toBe(512);
    expect(harness.scrapeCalls).toBe(0);
    if (quick.body.results?.[0]?.snippet) {
      expect(quick.body.results[0].snippet).toBe(words(1000));
    } else {
      expect(quick.body.error === 'budget_too_small' || quick.body.omitted_snippets > 0).toBe(true);
    }

    const deep = decode(await harness.server.handleResearch({
      query: words(1000),
      depth: 'deep',
      max_tokens: 512,
    }));
    expect(deep.body.error).toMatch(/not yet implemented/i);
    expect(deep.body.budget.used).toBeLessThanOrEqual(512);
    expect(deep.body.budget.limit).toBe(512);

    harness.server.fourget = {
      search: async () => ({ status: 'ok', web: [], answer: [], npt: '' }),
    };
    const empty = decode(await harness.server.handleResearch({
      query: words(1000),
      depth: 'normal',
      max_tokens: 512,
    }));
    expect(empty.body.number_of_results).toBe(0);
    expect(empty.body.budget.used).toBeLessThanOrEqual(512);
    expect(harness.scrapeCalls).toBe(0);
  });
});

describe('7 explicit oversized section statuses survive outline previews', () => {
  it('keeps the requested oversized section status when earlier headings exist', () => {
    const others = Array.from({ length: 30 }, (_, i) => (
      `## Heading ${i}\n\nShort unrelated body ${i}.`
    )).join('\n\n');
    const huge = `## Oversized Target\n\n${'listen code '.repeat(800)}`;
    const markdown = `${others}\n\n${huge}`;
    const sections = parseDocumentSections(markdown);
    const target = sections.find((section) => section.heading === 'Oversized Target');
    expect(target).toBeDefined();

    const result = packBudgetedResponse({
      query: 'listen code',
      contentMode: 'relevant_only',
      maxTokens: 700,
      sources: [packSource('https://a.test', markdown, 'listen code')],
      envelope: { query: 'listen code' },
      requestedSectionIds: [target!.id],
    });
    const body = JSON.parse(result.text);
    const preview = body.results[0].sections.omitted_preview;
    const marked = preview.find((item: { id: string }) => item.id === target!.id);

    expect(body.results[0].relevant_passages.passages).toEqual([]);
    expect(marked).toBeDefined();
    expect(['section_too_large', 'section_exceeds_max_budget']).toContain(marked.status);
    expect(marked.required_tokens).toBeGreaterThan(700);
    expect(result.text).not.toContain('listen code '.repeat(20));
  });

  it('does not imply full content was omitted when full markdown is included', () => {
    const markdown = [
      '## Fastify listen unique',
      '',
      'fastify listen unique',
      '',
      ...Array.from({ length: 6 }, (_, i) => `## Chairs ${i}\n\nunrelated furniture ${i}`),
    ].join('\n\n');
    const result = packBudgetedResponse({
      query: 'fastify listen unique',
      contentMode: 'full',
      maxTokens: 6000,
      sources: [packSource('https://a.test', markdown, 'fastify listen unique')],
      envelope: { query: 'fastify listen unique' },
    });
    const body = JSON.parse(result.text);
    expect(body.results[0].data.markdown).toBe(markdown);
    expect(body.results[0].full_content_omitted).toBeFalsy();
    expect(body.results[0].sections.omitted).toBe(0);
  });

  it('does not replace an explicit section selection with unrelated whole-page content', () => {
    const markdown = [
      '## Keep',
      '',
      'keep this requested section',
      '',
      '## Other',
      '',
      'unrelated chairs furniture',
    ].join('\n');
    const result = packBudgetedResponse({
      query: 'keep',
      contentMode: 'full',
      maxTokens: 6000,
      sources: [packSource('https://a.test', markdown, 'keep')],
      envelope: { query: 'keep' },
      requestedSectionIds: ['s0'],
    });
    const body = JSON.parse(result.text);
    const ids = body.results[0].relevant_passages.passages.map((p: { section_id: string }) => p.section_id);
    expect(ids).toEqual(['s0']);
    expect(body.results[0].data?.markdown).toBeUndefined();
  });
});
