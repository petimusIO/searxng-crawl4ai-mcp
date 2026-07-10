import { normalizeUrl } from './url-normalizer.js';
import type { SearchResult } from './searxng-client.js';
import type { FourgetWebResult } from './fourget-client.js';

export interface UnifiedResult {
  title: string;
  url: string;
  content: string;         // Snippet from either source
  publishedDate: string | null;
  source: 'searxng' | 'fourget' | 'both';
  searxngScore?: number;
}

export interface MergeOptions {
  maxResults?: number;
}

/**
 * Merge and deduplicate search results from SearXNG and 4get.
 *
 * Strategy:
 * 1. Build a Map keyed by normalized URL
 * 2. For duplicate URLs: keep the result with the longer snippet
 *    and mark source as 'both'
 * 3. Order: SearXNG results first (preserving relevance order),
 *    then 4get-only results appended
 * 4. Optionally truncate to maxResults
 */
export function mergeSearchResults(
  searxngResults: SearchResult[],
  fourgetResults: FourgetWebResult[],
  options: MergeOptions = {}
): UnifiedResult[] {
  const merged = new Map<string, UnifiedResult>();
  const searxngOrder: string[] = [];  // normalized URLs in order

  // Process SearXNG results first (primary source, determines ordering)
  for (const sr of searxngResults) {
    const normalized = normalizeUrl(sr.url);
    searxngOrder.push(normalized);
    merged.set(normalized, {
      title: sr.title,
      url: normalized,
      content: sr.content || '',
      publishedDate: sr.publishedDate || null,
      source: 'searxng',
      searxngScore: sr.score,
    });
  }

  // Process 4get results — merge into existing entries or append
  const fourgetOnly: UnifiedResult[] = [];

  for (const fr of fourgetResults) {
    const normalized = normalizeUrl(fr.url);

    if (merged.has(normalized)) {
      // Duplicate — update if 4get has a longer snippet
      const existing = merged.get(normalized)!;
      if (fr.description.length > existing.content.length) {
        existing.content = fr.description;
      }
      // Inherit date from 4get if SearXNG didn't provide one
      if (!existing.publishedDate && fr.date) {
        existing.publishedDate = fr.date;
      }
      existing.source = 'both';
    } else {
      // New — 4get-only result
      fourgetOnly.push({
        title: fr.title,
        url: normalized,
        content: fr.description,
        publishedDate: fr.date,
        source: 'fourget',
      });
    }
  }

  // Build ordered result: SearXNG results in original order, then 4get-only
  const results: UnifiedResult[] = [];

  for (const normalized of searxngOrder) {
    const entry = merged.get(normalized);
    if (entry) results.push(entry);
  }

  results.push(...fourgetOnly);

  // Apply maxResults truncation
  if (options.maxResults && options.maxResults > 0) {
    return results.slice(0, options.maxResults);
  }

  return results;
}
