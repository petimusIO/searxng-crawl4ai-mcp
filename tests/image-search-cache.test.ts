import { describe, expect, it } from 'vitest';
import { buildCacheKey } from '../src/cache-key.js';
import { IMAGE_CACHE_PREFIX, imageSearchCacheFields } from '../src/image-search.js';

describe('image search cache isolation', () => {
  it('uses a versioned images namespace separate from text search', () => {
    expect(IMAGE_CACHE_PREFIX).toMatch(/^images:v\d+/);
    expect(IMAGE_CACHE_PREFIX).not.toContain('search:primary-fallback');
    expect(IMAGE_CACHE_PREFIX).not.toContain('research:');
  });

  it('isolates cache entries by query, safe-search policy, scraper, and limit', () => {
    const base = imageSearchCacheFields({
      query: 'saturn',
      nsfw: 'no',
      scraper: 'ddg',
      maxResults: 6,
    });
    const otherQuery = imageSearchCacheFields({
      query: 'jupiter',
      nsfw: 'no',
      scraper: 'ddg',
      maxResults: 6,
    });
    const otherPolicy = imageSearchCacheFields({
      query: 'saturn',
      nsfw: 'yes',
      scraper: 'ddg',
      maxResults: 6,
    });
    const otherLimit = imageSearchCacheFields({
      query: 'saturn',
      nsfw: 'no',
      scraper: 'ddg',
      maxResults: 3,
    });

    expect(buildCacheKey(IMAGE_CACHE_PREFIX, base)).not.toBe(
      buildCacheKey(IMAGE_CACHE_PREFIX, otherQuery),
    );
    expect(buildCacheKey(IMAGE_CACHE_PREFIX, base)).not.toBe(
      buildCacheKey(IMAGE_CACHE_PREFIX, otherPolicy),
    );
    expect(buildCacheKey(IMAGE_CACHE_PREFIX, base)).not.toBe(
      buildCacheKey(IMAGE_CACHE_PREFIX, otherLimit),
    );
    expect(base).toContain('nsfw=no');
  });
});
