import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/document-store.js';
import { SearXNGMCPServer } from '../src/index.js';
import { parseDocumentSections } from '../src/passage-extractor.js';
import { countResponseTokens, prepareSafeErrorPayload } from '../src/token-budget.js';

function decode(response: { content: Array<{ text: string }> }) {
  const text = response.content[0].text;
  return { text, body: JSON.parse(text) as any };
}

function scrapeOk(url: string, markdown: string, title = 'Docs') {
  return {
    success: true,
    url,
    data: {
      markdown,
      metadata: {
        title,
        description: 'fresh description from crawler',
        language: 'en',
        word_count: 9999,
      },
    },
  };
}

function createHarness(scrape?: (url: string) => Promise<unknown> | unknown) {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  const cache = new Map<string, unknown>();
  let scrapeCalls = 0;
  let scrapeImpl = scrape ?? (async (url: string) => scrapeOk(url, '## Page\n\nHello.'));
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

function expectStableErrorCode(code: unknown) {
  expect(typeof code).toBe('string');
  expect(code).toMatch(/^[a-z][a-z0-9_]{0,39}$/i);
  expect((code as string).length).toBeGreaterThan(0);
  expect((code as string).length).toBeLessThanOrEqual(40);
}

describe('CORRECTNESS1 bounded upstream scrape errors', () => {
  it('prepareSafeErrorPayload maps long error strings to a stable code instead of copying them', () => {
    const huge = `blocked ${'x'.repeat(2000)}`;
    const safe = prepareSafeErrorPayload({
      success: false,
      url: 'https://blocked.test/page',
      error: huge,
    });

    expectStableErrorCode(safe.error);
    expect(String(safe.error)).not.toBe(huge);
    expect(JSON.stringify(safe)).not.toContain('x'.repeat(200));
    expect(safe.url).toBe('https://blocked.test/page');
    if (typeof safe.diagnostic === 'string') {
      expect(safe.diagnostic.length).toBeLessThanOrEqual(80);
    }
  });

  it('handleScrapeUrl bounds success:false with a 2000x blocked error under max_tokens 512', async () => {
    const harness = createHarness(async () => ({
      success: false,
      url: 'https://blocked.test/page',
      error: 'blocked '.repeat(2000),
    }));

    const result = decode(await harness.server.handleScrapeUrl({
      url: 'https://blocked.test/page',
      max_tokens: 512,
    }));

    expect(result.body.success).toBe(false);
    expectStableErrorCode(result.body.error);
    expect(result.body.error).not.toContain('blocked blocked');
    expect(result.text).not.toContain('blocked '.repeat(20));
    expect(result.body.url).toBe('https://blocked.test/page');
    expect(result.body.budget.limit).toBe(512);
    expect(result.body.budget.used).toBe(countResponseTokens(result.text));
    expect(result.body.budget.used).toBeLessThanOrEqual(512);
    expect(harness.scrapeCalls).toBe(1);
  });

  it('keeps a short blocked code and bounds unknown arbitrary strings plus thrown errors', async () => {
    const harness = createHarness(async () => ({
      success: false,
      url: 'https://blocked.test/short',
      error: 'blocked',
    }));
    const short = decode(await harness.server.handleScrapeUrl({
      url: 'https://blocked.test/short',
      max_tokens: 512,
    }));
    expect(short.body.error).toBe('blocked');
    expect(short.body.budget.used).toBeLessThanOrEqual(512);

    harness.setScrape(async () => ({
      success: false,
      url: 'https://blocked.test/arbitrary',
      error: `??? ${'Q'.repeat(3000)} unexpected crawler dump`,
    }));
    const arbitrary = decode(await harness.server.handleScrapeUrl({
      url: 'https://blocked.test/arbitrary',
      max_tokens: 512,
    }));
    expectStableErrorCode(arbitrary.body.error);
    expect(arbitrary.body.error).not.toContain('???');
    expect(arbitrary.text).not.toContain('Q'.repeat(200));
    expect(arbitrary.body.url).toBe('https://blocked.test/arbitrary');
    expect(arbitrary.body.budget.used).toBeLessThanOrEqual(512);
    if (typeof arbitrary.body.diagnostic === 'string') {
      expect(arbitrary.body.diagnostic.length).toBeLessThanOrEqual(80);
    }

    harness.setScrape(async () => {
      throw new Error(`thrown dump ${'E'.repeat(400)}`);
    });
    const thrown = decode(await harness.server.handleScrapeUrl({
      url: 'https://blocked.test/thrown',
      max_tokens: 512,
    }));
    expect(thrown.body.success).toBe(false);
    expectStableErrorCode(thrown.body.error);
    expect(thrown.text).not.toContain('thrown dump');
    expect(thrown.body.budget.used).toBeLessThanOrEqual(512);
  });
});

describe('CORRECTNESS2 canonical snapshot body and metadata', () => {
  const OLD = '## Old\n\nOriginal evidence.';
  const NEW = '## New\n\nReplacement evidence.';

  it('packScrapedDocument full mode uses retained snapshot markdown and metadata, not fresh scrape data', () => {
    const server = Object.create(SearXNGMCPServer.prototype) as any;
    server.documentStore = new DocumentStore();
    const retained = server.retainDocument('https://same.test/page', 'Old', OLD);
    const packed = decode(server.packScrapedDocument(
      {
        success: true,
        url: 'https://same.test/page',
        data: {
          markdown: NEW,
          metadata: {
            title: 'New',
            description: 'fresh replacement description',
            word_count: 4242,
          },
        },
      },
      retained,
      { max_tokens: 6000, content_mode: 'full' },
    ));

    expect(packed.body.document_id).toBe(retained.document_id);
    expect(packed.body.data.markdown).toBe(OLD);
    expect(packed.body.data.markdown).not.toContain('Replacement evidence');
    expect(packed.body.data.metadata?.title).toBe('Old');
    expect(packed.body.data.metadata?.description).toBeUndefined();
    expect(packed.body.data.metadata?.word_count).not.toBe(4242);
    const oldSection = parseDocumentSections(OLD)[0];
    const passage = packed.body.relevant_passages.passages.find((p: { section_id: string }) => p.section_id === oldSection.id);
    expect(passage.source_offset).toEqual(oldSection.source_offset);
    expect(packed.body.budget.used).toBe(countResponseTokens(packed.text));
  });

  it('handleNormalResearch and a later saved full read both return the retained body', async () => {
    const harness = createHarness();
    const retained = harness.server.retainDocument('https://example.com/docs', 'Old', OLD);
    harness.setScrape(async (url: string) => scrapeOk(url, NEW, 'New'));

    const research = decode(await harness.server.handleNormalResearch(
      'Original evidence',
      'single',
      [{ url: 'https://example.com/docs', title: 'New', content: 'discovery snippet' }],
      'full',
      undefined,
      1,
      [],
      Date.now(),
      'research:canonical-final',
      'fourget',
      undefined,
      6000,
    ));

    expect(research.body.results[0].document_id).toBe(retained.document_id);
    expect(research.body.results[0].data.markdown).toBe(OLD);
    expect(research.body.results[0].data.metadata?.title).toBe('Old');
    expect(research.body.results[0].data.metadata?.description).toBeUndefined();
    expect(research.body.results[0].title).toBe('Old');

    const saved = decode(await harness.server.handleScrapeUrl({
      document_id: retained.document_id,
      content_mode: 'full',
      max_tokens: 6000,
    }));
    expect(saved.body.data.markdown).toBe(OLD);
    expect(saved.body.data.markdown).toBe(research.body.results[0].data.markdown);
    expect(saved.body.document_id).toBe(retained.document_id);
    expect(harness.scrapeCalls).toBe(1);
  });
});

describe('CORRECTNESS3 reserved requested section outcomes', () => {
  const SMALL = `## Small\n\n${'word '.repeat(90)}`;
  const LARGE = `## Large\n\n${'evidence '.repeat(2000)}`;
  const MIXED = `${SMALL}\n\n${LARGE}`;

  async function savedMixed(harness: ReturnType<typeof createHarness>) {
    const saved = harness.server.documentStore.save({
      url: 'https://mixed.test/page',
      title: 'Mixed',
      markdown: MIXED,
      sections: parseDocumentSections(MIXED),
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('save failed');
    return saved.document;
  }

  it('mixed small+large requested ids keep s0 evidence and a required s1 outcome at 512', async () => {
    const harness = createHarness();
    const document = await savedMixed(harness);
    const result = decode(await harness.server.handleScrapeUrl({
      document_id: document.document_id,
      section_ids: ['s0', 's1'],
      max_tokens: 512,
    }));

    expect(result.body.budget.used).toBe(countResponseTokens(result.text));
    expect(result.body.budget.used).toBeLessThanOrEqual(512);
    if (result.body.error === 'budget_too_small') {
      expect(result.body.required_tokens).toBeGreaterThan(512);
      return;
    }
    const passages = result.body.relevant_passages?.passages ?? [];
    expect(passages.map((p: { section_id: string }) => p.section_id)).toEqual(['s0']);
    expect(passages[0].text.startsWith('## Small')).toBe(true);
    expect(passages[0].text).toContain('word ');
    expect(result.text).not.toContain('evidence '.repeat(50));
    const marked = (result.body.sections?.omitted_preview ?? []).find((item: { id: string }) => item.id === 's1');
    expect(marked).toBeDefined();
    expect(['section_too_large', 'section_exceeds_max_budget']).toContain(marked.status);
    expect(marked.required_tokens).toBeGreaterThan(512);
    expect(result.body.sections.omitted).toBeGreaterThanOrEqual(1);
  });

  it('reverse requested order still reports the oversized section after flatten', async () => {
    const harness = createHarness();
    const document = await savedMixed(harness);
    const result = decode(await harness.server.handleScrapeUrl({
      document_id: document.document_id,
      section_ids: ['s1', 's0'],
      max_tokens: 512,
    }));

    expect(result.body.budget.used).toBeLessThanOrEqual(512);
    if (result.body.error === 'budget_too_small') {
      expect(result.body.required_tokens).toBeGreaterThan(512);
      return;
    }
    expect((result.body.relevant_passages?.passages ?? []).map((p: { section_id: string }) => p.section_id)).toEqual(['s0']);
    const marked = (result.body.sections?.omitted_preview ?? []).find((item: { id: string }) => item.id === 's1');
    expect(marked).toBeDefined();
    expect(['section_too_large', 'section_exceeds_max_budget']).toContain(marked.status);
    expect(marked.required_tokens).toBeGreaterThan(512);
  });

  it('many requested outcomes that cannot fit emit budget_too_small with required size', async () => {
    const harness = createHarness();
    const markdown = Array.from({ length: 32 }, (_, i) => (
      `## Heading ${i} ${'H'.repeat(50)}\n\nshort body ${i}.`
    )).join('\n\n');
    const sections = parseDocumentSections(markdown);
    const saved = harness.server.documentStore.save({
      url: 'https://many.test/page',
      title: 'Many',
      markdown,
      sections,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const result = decode(await harness.server.handleScrapeUrl({
      document_id: saved.document.document_id,
      section_ids: sections.map((section: { id: string }) => section.id),
      max_tokens: 512,
    }));

    expect(result.body.budget.used).toBe(countResponseTokens(result.text));
    expect(result.body.budget.used).toBeLessThanOrEqual(512);
    if (result.body.error === 'budget_too_small') {
      expect(result.body.required_tokens).toBeGreaterThan(512);
      return;
    }
    const requested = new Set(sections.map((section: { id: string }) => section.id));
    const included = new Set((result.body.relevant_passages?.passages ?? []).map((p: { section_id: string }) => p.section_id));
    const preview = new Set((result.body.sections?.omitted_preview ?? []).map((item: { id: string }) => item.id));
    for (const id of requested) {
      expect(included.has(id) || preview.has(id), `missing outcome for ${id}`).toBe(true);
    }
  });
});
