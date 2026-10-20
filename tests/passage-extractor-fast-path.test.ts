import { beforeEach, describe, expect, it, vi } from 'vitest';

const ast = vi.hoisted(() => ({ calls: 0 }));
vi.mock('unified', async (load) => {
  const original = await load<typeof import('unified')>();
  return {
    ...original,
    unified: () => {
      const processor = original.unified();
      const parse = processor.parse.bind(processor);
      processor.parse = ((...args: Parameters<typeof parse>) => {
        ast.calls += 1;
        return parse(...args);
      }) as typeof processor.parse;
      return processor;
    },
  };
});

import { parseDocumentSections, rankDocumentSections } from '../src/passage-extractor.js';
import { packBudgetedResponse } from '../src/response-packer.js';

beforeEach(() => { ast.calls = 0; });

describe('structural parsing fast path', () => {
  it('groups ordinary headings, code, tables and qualifications without a full inline AST', () => {
    const markdown = '## Setup\n\nKeep the introduction.\n\n```js\nconst x = 1;\n```\n\nKeep the qualification.\n\n## Matrix\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const sections = parseDocumentSections(markdown);
    expect(sections).toHaveLength(2);
    expect(sections[0].text).toContain('```js\nconst x = 1;\n```\n\nKeep the qualification.');
    expect(sections[1].text).toContain('| 1 | 2 |');
    for (const section of sections) {
      expect(markdown.slice(section.source_offset.start, section.source_offset.end)).toBe(section.text);
    }
    expect(ast.calls).toBe(0);
  });

  it('retains the reference-aware parser when definitions need resolution', () => {
    const sections = parseDocumentSections('See [the policy][ref].\n\n[ref]: https://example.org/policy');
    expect(sections[0].definitions?.[0].identifier).toBe('ref');
    expect(sections[0].text).toContain('[ref]: https://example.org/policy');
    expect(ast.calls).toBe(1);
  });

  it('preserves trailing newlines in an unclosed code fence', () => {
    const markdown = '```js\nunclosed()\n\n';
    const sections = parseDocumentSections(markdown);
    expect(sections[0].text).toBe(markdown);
    expect(sections[0].source_offset.end).toBe(markdown.length);
  });

  it('preserves indentation at the start of raw HTML blocks', () => {
    const markdown = '  <div>\nhtml\n</div>\n';
    const sections = parseDocumentSections(markdown);
    expect(sections[0].source_offset.start).toBe(0);
    expect(sections[0].text).toBe(markdown.slice(0, -1));
  });

  it('keeps HTML evidence separately retrievable after a lazy blockquote', () => {
    const markdown = '> ' + 'unrelated '.repeat(8000) + '\n<x>\nPolicy exception: preserve this evidence.\n</x>\n';
    const sections = parseDocumentSections(markdown);
    expect(sections).toHaveLength(2);
    const ranked = rankDocumentSections(sections, 'policy exception');
    const packed = packBudgetedResponse({
      query: 'policy exception', contentMode: 'relevant_only', maxTokens: 6000,
      sources: [{ url: 'https://fixture.invalid/lazy', title: 'Lazy HTML boundary', success: true, source_type: 'scraped', markdown, sections, ranked }],
      envelope: {},
    });
    expect((packed.payload.results as any[])[0].relevant_passages.passages[0].text)
      .toBe('Policy exception: preserve this evidence.\n</x>');
  });

  it.each(['    code\n    \n', '    code\n\t\n', 'alpha\n\u00a0\n', 'alpha\n\uFEFF\n'])(
    'preserves meaningful trailing whitespace in %j', (markdown) => {
      const sections = parseDocumentSections(markdown);
      expect(sections[0].text).toBe(markdown.slice(0, -1));
      expect(sections[0].source_offset.end).toBe(markdown.length - 1);
    },
  );

  it('preserves original CRLF offsets and final line endings', () => {
    const markdown = '\r\n## Setup\r\n\r\nA full paragraph.\r\n\r\n```js\r\nx()\r\n```\r\n';
    const sections = parseDocumentSections(markdown);
    expect(sections[0].source_offset).toEqual({ start: 2, end: markdown.length - 2 });
    expect(sections[0].text).toBe(markdown.slice(2, -2));
    expect(ast.calls).toBe(0);
  });
});
