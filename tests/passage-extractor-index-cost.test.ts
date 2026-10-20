import { describe, expect, it, vi } from 'vitest';
const seen = vi.hoisted(() => ({ terms: 0 }));
vi.mock('minisearch', async (load) => {
  const actual = await load<typeof import('minisearch')>();
  return {
    ...actual,
    default: class extends actual.default {
      search(query: string, ...args: any[]) {
        seen.terms = (this as any)._index.size;
        return super.search(query, ...args);
      }
    },
  };
});
import { parseDocumentSections, preprocessText, rankDocumentSections } from '../src/passage-extractor.js';

describe('query-scoped lexical index', () => {
  it('indexes only query terms while keeping full-corpus BM25 scores', async () => {
    const query = 'policy exception';
    const markdown = Array.from({ length: 10 }, (_, i) => (
      `## section ${i}\n\npolicy ${'exception '.repeat(i + 1)} ${Array.from({ length: 100 }, (_, j) => `unrelated${i}word${j}`).join(' ')}`
    )).join('\n\n');
    const sections = parseDocumentSections(markdown);
    const ranked = rankDocumentSections(sections, query);
    const indexedTerms = seen.terms;
    const { default: MiniSearch } = await vi.importActual<typeof import('minisearch')>('minisearch');
    const reference = new MiniSearch({
      fields: ['heading', 'body'], storeFields: ['id'], tokenize: preprocessText,
      processTerm: term => term.toLowerCase(),
      searchOptions: { boost: { heading: 2, body: 1 }, fuzzy: false, prefix: false },
    });
    reference.addAll(sections.map((s, id) => ({ id, heading: s.heading ?? '', body: s.text })));
    const expected = reference.search(query).map(hit => ({ id: sections[hit.id].id, score: hit.score }));
    expect(ranked.map(({ id, score }) => ({ id, score }))).toEqual(expected);
    expect(indexedTerms).toBeLessThanOrEqual(2);
  });
});
