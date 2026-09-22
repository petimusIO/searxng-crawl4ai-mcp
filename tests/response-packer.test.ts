import { describe, expect, it } from 'vitest';
import {
  parseDocumentSections,
  rankDocumentSections,
} from '../src/passage-extractor.js';
import { packBudgetedResponse } from '../src/response-packer.js';
import { countResponseTokens, serializeResponseText } from '../src/token-budget.js';

function source(url: string, markdown: string, query: string, extras: Record<string, unknown> = {}) {
  const sections = parseDocumentSections(markdown);
  return {
    url,
    title: url,
    snippet: 'discovery snippet',
    success: true,
    source_type: 'scraped' as const,
    document_id: `doc-${url}`,
    data: { markdown, metadata: { title: url, word_count: 10 } },
    markdown,
    sections,
    ranked: rankDocumentSections(sections, query),
    ...extras,
  };
}

function pack(sources: ReturnType<typeof source>[], extras: {
  query?: string;
  contentMode?: 'full' | 'relevant_only' | 'snippet';
  maxTokens?: number;
  envelope?: Record<string, unknown>;
} = {}) {
  return packBudgetedResponse({
    query: extras.query ?? 'fastify listen',
    contentMode: extras.contentMode ?? 'relevant_only',
    maxTokens: extras.maxTokens ?? 6000,
    sources,
    envelope: extras.envelope ?? { query: extras.query ?? 'fastify listen' },
  });
}

function decoded(result: { payload: unknown; text: string }) {
  return JSON.parse(result.text) as any;
}

const SMALL = [
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
].join('\n');

const TABLE = [
  '## Releases',
  '',
  '| Version | Status |',
  '| ------- | ------ |',
  '| 1.0     | stable |',
  '| 2.0     | beta   |',
].join('\n');

describe('response packer', () => {
  it('caps the actual serialized JSON including budget metadata and never uses char/4', () => {
    const result = pack([source('https://a.test', SMALL, 'fastify listen')], { maxTokens: 512 });
    const body = decoded(result);

    expect(result.text).toBe(serializeResponseText(result.payload));
    expect(body.budget).toEqual({
      tokenizer: 'o200k_base',
      limit: 512,
      used: body.budget.used,
      scope: 'response_text',
    });
    expect(body.budget.used).toBe(countResponseTokens(result.text));
    expect(body.budget.used).toBeLessThanOrEqual(512);
    expect(body.budget.used).not.toBe(Math.ceil(result.text.length / 4));
    expect(body.results[0].relevant_passages.passages[0].section_id).toMatch(/^s\d+$/);
  });

  it('keeps complete code and tables and tries a later smaller section when a large one does not fit', () => {
    const huge = `## Huge Fastify\n\n${'fastify listen '.repeat(400)}`;
    const smaller = `${TABLE}\n\nFastify listen release notes.`;
    const markdown = `${huge}\n\n${smaller}`;
    const result = pack([source('https://a.test', markdown, 'fastify listen')], { maxTokens: 700 });
    const body = decoded(result);
    const texts: string[] = body.results[0].relevant_passages.passages.map((p: { text: string }) => p.text);

    expect(texts.some((text) => text.includes('| 1.0     | stable |'))).toBe(true);
    expect(texts.some((text) => text.includes(huge))).toBe(false);
    expect(texts.some((text) => /\| 1\.0\s+\| stab/.test(text) && !text.includes('| 2.0     | beta   |'))).toBe(false);
    expect(body.results[0].sections.omitted).toBeGreaterThan(0);
    expect(body.results[0].sections.total).toBe(body.results[0].sections.included + body.results[0].sections.omitted);
  });

  it('shares one budget across sources, suppresses exact duplicate text, and keeps failures', () => {
    const query = 'fastify listen';
    const result = pack([
      source('https://a.test', SMALL, query),
      source('https://b.test', SMALL, query),
      {
        url: 'https://fail.test',
        title: 'fail',
        snippet: 'blocked snippet',
        success: false,
        source_type: 'snippet',
        error: 'blocked',
        sections: [],
        ranked: [],
      },
    ], { query, maxTokens: 900 });
    const body = decoded(result);
    const included = body.results.flatMap((r: any) => r.relevant_passages?.passages ?? []);
    const installTexts = included.filter((p: { text: string }) => p.text.includes('const app = fastify()'));

    expect(installTexts).toHaveLength(1);
    expect(body.results[2].success).toBe(false);
    expect(body.results[2].error).toBe('blocked');
    expect(body.results[2].snippet).toBe('blocked snippet');
    expect(body.budget.used).toBeLessThanOrEqual(900);
  });

  it('returns exact full markdown when it fits and omits the whole field when it does not', () => {
    const fits = pack([source('https://a.test', SMALL, 'fastify listen')], { contentMode: 'full', maxTokens: 6000 });
    expect(decoded(fits).results[0].data.markdown).toBe(SMALL);
    expect(decoded(fits).results[0].full_content_omitted).toBeFalsy();

    const huge = `## Fastify\n\n${'listen '.repeat(2000)}`;
    const omitted = pack([source('https://a.test', huge, 'fastify listen')], { contentMode: 'full', maxTokens: 800 });
    const body = decoded(omitted);
    expect(body.results[0].data?.markdown).toBeUndefined();
    expect(body.results[0].full_content_omitted).toBe(true);
    expect(body.results[0].relevant_passages.passages.every((p: { text: string }) => p.text.includes('listen'))).toBe(true);
  });

  it('marks zero-match, preserves reference definitions, and encodes special-token text', () => {
    const markdown = 'See the [docs][ref] about <|endoftext|> chairs.\n\n[ref]: https://example.com/docs';
    const result = pack([source('https://a.test', markdown, 'zzzz-no-hit')], {
      query: 'zzzz-no-hit',
      maxTokens: 800,
    });
    const body = decoded(result);
    const passage = body.results[0].relevant_passages.passages[0];

    expect(body.results[0].match_status).toBe('zero_match');
    expect(passage.text).toContain('[ref]: https://example.com/docs');
    expect(passage.text).toContain('<|endoftext|>');
    expect(body.budget.used).toBe(countResponseTokens(result.text));
  });

  it('returns compact budget_too_small when mandatory metadata cannot fit', () => {
    const result = pack([source('https://a.test', SMALL, 'fastify listen')], {
      maxTokens: 512,
      envelope: { query: 'fastify listen', padding: 'meta '.repeat(400) },
    });
    const body = decoded(result);

    expect(body.error).toBe('budget_too_small');
    expect(body.required_tokens).toBeGreaterThan(512);
    expect(body.results).toBeUndefined();
    expect(body.budget.used).toBeLessThanOrEqual(512);
    expect(body.budget.used).toBe(countResponseTokens(result.text));
  });

  it('marks a requested oversized atomic section without cutting it', () => {
    const huge = `## Fastify\n\n${'listen code '.repeat(2500)}`;
    const result = packBudgetedResponse({
      query: 'fastify listen',
      contentMode: 'relevant_only',
      maxTokens: 600,
      sources: [source('https://a.test', huge, 'fastify listen')],
      envelope: { query: 'fastify listen' },
      requestedSectionIds: ['s0'],
    });
    const body = decoded(result);
    const omitted = body.results[0].sections.omitted_preview[0];

    expect(body.results[0].relevant_passages.passages).toEqual([]);
    expect(omitted.id).toBe('s0');
    expect(['section_too_large', 'section_exceeds_max_budget']).toContain(omitted.status);
    expect(omitted.required_tokens).toBeGreaterThan(600);
    expect(result.text.includes('listen code listen code listen code listen code listen code listen code listen code listen code listen code listen code listen code listen code listen code listen code listen code')).toBe(false);
  });
});
