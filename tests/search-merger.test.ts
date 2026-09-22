import { describe, it, expect } from 'vitest';
import { mergeSearchResults, UnifiedResult } from '../src/search-merger.js';
import type { SearchResult } from '../src/searxng-client.js';
import type { FourgetWebResult } from '../src/fourget-client.js';

describe('mergeSearchResults', () => {
  const searxngResults: SearchResult[] = [
    {
      title: 'SearXNG Result 1',
      url: 'https://example.com/page1?utm_source=twitter',
      content: 'A long descriptive snippet from SearXNG',
      score: 0.95,
    },
    {
      title: 'SearXNG Result 2',
      url: 'https://example.com/page2',
      content: 'short',
      score: 0.80,
    },
  ];

  const fourgetResults: FourgetWebResult[] = [
    {
      title: '4get Result A',
      url: 'https://example.com/page1#intro',
      description: 'Short from 4get',
      date: '2026-01-15T00:00:00.000Z',
      type: 'web',
    },
    {
      title: '4get Result B',
      url: 'https://www.example.com/unique',
      description: 'A unique result only from 4get',
      date: null,
      type: 'web',
    },
  ];

  it('deduplicates by conservative identity and keeps original discovery URLs', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    // 3 unique URLs: page1 (deduped), page2 (searxng only), unique (4get only)
    expect(merged).toHaveLength(3);

    const urls = merged.map((r) => r.url);
    expect(urls).toContain('https://example.com/page1?utm_source=twitter');
    expect(urls).toContain('https://example.com/page2');
    expect(urls).toContain('https://www.example.com/unique');
  });

  it('prefers longer snippet when both sources match same URL', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    const page1 = merged.find((r) => r.url === 'https://example.com/page1?utm_source=twitter');
    expect(page1).toBeDefined();
    expect(page1!.content).toBe('A long descriptive snippet from SearXNG'); // longer wins
    expect(page1!.source).toBe('both');
  });

  it('does not collapse path-case variants and keeps each discovery URL', () => {
    const merged = mergeSearchResults(
      [{
        title: 'SSI',
        url: 'https://wiki.postgresql.org/wiki/SSI',
        content: 'Serializable Snapshot Isolation',
        score: 0.9,
      }],
      [{
        title: 'ssi',
        url: 'https://wiki.postgresql.org/wiki/ssi',
        description: 'lowercased wiki path',
        date: null,
        type: 'web',
      }],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0].url).toBe('https://wiki.postgresql.org/wiki/SSI');
    expect(merged[1].url).toBe('https://wiki.postgresql.org/wiki/ssi');
  });

  it('marks source correctly', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    const both = merged.find((r) => r.url === 'https://example.com/page1?utm_source=twitter');
    const searxngOnly = merged.find((r) => r.url === 'https://example.com/page2');
    const fourgetOnly = merged.find((r) => r.url === 'https://www.example.com/unique');

    expect(both!.source).toBe('both');
    expect(searxngOnly!.source).toBe('searxng');
    expect(fourgetOnly!.source).toBe('fourget');
  });

  it('orders SearXNG results first, then 4get-only results', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    // SearXNG results should come first (preserving their order)
    expect(merged[0].title).toBe('SearXNG Result 1');
    expect(merged[1].title).toBe('SearXNG Result 2');
    // 4get-only results appended
    expect(merged[2].title).toBe('4get Result B');
  });

  it('respects maxResults option', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults, { maxResults: 2 });

    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe('SearXNG Result 1');
    expect(merged[1].title).toBe('SearXNG Result 2');
  });

  it('handles empty 4get results gracefully', () => {
    const merged = mergeSearchResults(searxngResults, []);

    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe('searxng');
  });

  it('handles empty SearXNG results gracefully', () => {
    const merged = mergeSearchResults([], fourgetResults);

    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe('fourget');
  });

  it('returns empty array when both sources are empty', () => {
    const merged = mergeSearchResults([], []);
    expect(merged).toEqual([]);
  });

  it('preserves publishedDate from 4get when available', () => {
    const merged = mergeSearchResults([], fourgetResults);

    const page1 = merged.find((r) => r.url === 'https://example.com/page1#intro');
    expect(page1!.publishedDate).toBe('2026-01-15T00:00:00.000Z');
    // The unique 4get result (result B) has date: null
    const fourgetOnly = merged.find((r) => r.url === 'https://www.example.com/unique');
    expect(fourgetOnly!.publishedDate).toBeNull();
  });

  it('collapses SearXNG fragment variants to one first-ranked original page', () => {
    const merged = mergeSearchResults(
      [
        {
          title: 'First',
          url: 'https://docs.example/page#first',
          content: 'First preserved evidence',
          score: 0.91,
        },
        {
          title: 'Second',
          url: 'https://docs.example/page#second',
          content: 'Second evidence',
          score: 0.80,
        },
        {
          title: 'Other',
          url: 'https://docs.example/other',
          content: 'Other',
          score: 0.70,
        },
      ],
      [],
    );

    expect(merged.map((r) => r.title)).toEqual(['First', 'Other']);
    expect(merged[0].url).toBe('https://docs.example/page#first');
    expect(merged[0].title).toBe('First');
    expect(merged[0].content).toBe('First preserved evidence');
    expect(merged[0].searxngScore).toBe(0.91);
    expect(merged[1].url).toBe('https://docs.example/other');
  });

  it('keeps a longer later SearXNG snippet on the first-ranked original page', () => {
    const merged = mergeSearchResults(
      [
        {
          title: 'First',
          url: 'https://docs.example/page#first',
          content: 'short',
          score: 0.91,
        },
        {
          title: 'Second',
          url: 'https://docs.example/page#second',
          content: 'Second evidence is deliberately longer',
          score: 0.80,
        },
      ],
      [],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe('https://docs.example/page#first');
    expect(merged[0].title).toBe('First');
    expect(merged[0].content).toBe('Second evidence is deliberately longer');
  });

  it('fills a missing SearXNG publication date from a later fragment duplicate', () => {
    const merged = mergeSearchResults(
      [
        {
          title: 'First',
          url: 'https://docs.example/page#first',
          content: 'First preserved evidence',
        },
        {
          title: 'Second',
          url: 'https://docs.example/page#second',
          content: 'Second evidence',
          publishedDate: '2026-03-01T00:00:00.000Z',
        },
      ],
      [],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe('https://docs.example/page#first');
    expect(merged[0].publishedDate).toBe('2026-03-01T00:00:00.000Z');
  });
});
