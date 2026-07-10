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
      url: 'https://example.com/PAGE1',  // case-diff, same as page1 after normalization
      description: 'Short from 4get',
      date: '2026-01-15T00:00:00.000Z',
      type: 'web',
    },
    {
      title: '4get Result B',
      url: 'https://www.example.com/unique',  // www prefix, stripped by normalizeUrl
      description: 'A unique result only from 4get',
      date: null,
      type: 'web',
    },
  ];

  it('deduplicates by normalized URL', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    // 3 unique URLs: page1 (deduped), page2 (searxng only), unique (4get only)
    expect(merged).toHaveLength(3);

    const urls = merged.map((r) => r.url);
    // Normalized URLs
    expect(urls).toContain('https://example.com/page1');
    expect(urls).toContain('https://example.com/page2');
    expect(urls).toContain('https://example.com/unique');
  });

  it('prefers longer snippet when both sources match same URL', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    const page1 = merged.find((r) => r.url === 'https://example.com/page1');
    expect(page1).toBeDefined();
    expect(page1!.content).toBe('A long descriptive snippet from SearXNG'); // longer wins
    expect(page1!.source).toBe('both');
  });

  it('marks source correctly', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    const both = merged.find((r) => r.url === 'https://example.com/page1');
    const searxngOnly = merged.find((r) => r.url === 'https://example.com/page2');
    const fourgetOnly = merged.find((r) => r.url === 'https://example.com/unique');

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

    // The page1 result was deduped with SearXNG (which had no publishedDate)
    // So the merged result at page1 should inherit the 4get date
    const page1 = merged.find((r) => r.url === 'https://example.com/page1');
    expect(page1!.publishedDate).toBe('2026-01-15T00:00:00.000Z');
    // The unique 4get result (result B) has date: null
    const fourgetOnly = merged.find((r) => r.url === 'https://example.com/unique');
    expect(fourgetOnly!.publishedDate).toBeNull();
  });
});
