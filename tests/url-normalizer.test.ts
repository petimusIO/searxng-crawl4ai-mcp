import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/url-normalizer.js';

describe('normalizeUrl', () => {
  it('should lowercase scheme and host', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path'))
      .toBe('https://example.com/path');
  });

  it('should strip www prefix', () => {
    expect(normalizeUrl('https://www.example.com/page'))
      .toBe('https://example.com/page');
  });

  it('should strip trailing slash on path-only URLs', () => {
    expect(normalizeUrl('https://example.com/page/'))
      .toBe('https://example.com/page');
  });

  it('should keep trailing slash when path is root', () => {
    expect(normalizeUrl('https://example.com/'))
      .toBe('https://example.com/');
  });

  it('should strip known tracking query params', () => {
    expect(normalizeUrl('https://example.com/page?ref=foo&utm_source=bar&keep=me'))
      .toBe('https://example.com/page?keep=me');
  });

  it('should remove all query params if only tracking params present', () => {
    expect(normalizeUrl('https://example.com/page?utm_source=x&fbclid=y'))
      .toBe('https://example.com/page');
  });

  it('should sort remaining query params alphabetically', () => {
    expect(normalizeUrl('https://example.com/page?z=1&a=2'))
      .toBe('https://example.com/page?a=2&z=1');
  });

  it('should preserve fragment', () => {
    expect(normalizeUrl('https://example.com/page?utm=x#section'))
      .toBe('https://example.com/page#section');
  });

  it('should handle URLs without path', () => {
    expect(normalizeUrl('https://WWW.Example.COM'))
      .toBe('https://example.com/');
  });

  it('should handle malformed URLs gracefully', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});
