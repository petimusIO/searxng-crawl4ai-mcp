import { describe, expect, it } from 'vitest';
import { buildCacheKey } from '../src/cache-key.js';

describe('buildCacheKey', () => {
  it('keeps delimiter characters isolated within their original fields', () => {
    const queryContainsDelimiter = buildCacheKey('search:primary-fallback', [
      'a:b',
      '',
      '',
      'en',
      'ddg',
      10,
    ]);
    const categoryContainsDelimiter = buildCacheKey('search:primary-fallback', [
      'a',
      'b:',
      '',
      'en',
      'ddg',
      10,
    ]);

    expect(queryContainsDelimiter).not.toBe(categoryContainsDelimiter);
    expect(queryContainsDelimiter).toBe(
      buildCacheKey('search:primary-fallback', ['a:b', '', '', 'en', 'ddg', 10]),
    );
  });
});
