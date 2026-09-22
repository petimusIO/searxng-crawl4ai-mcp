import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/url-normalizer.js';

describe('normalizeUrl', () => {
  it('should lowercase scheme and host without rewriting path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path'))
      .toBe('https://example.com/Path');
  });

  it('should preserve www prefix', () => {
    expect(normalizeUrl('https://www.example.com/page'))
      .toBe('https://www.example.com/page');
  });

  it('should preserve trailing slash on non-root paths', () => {
    expect(normalizeUrl('https://example.com/page/'))
      .toBe('https://example.com/page/');
  });

  it('should keep trailing slash when path is root', () => {
    expect(normalizeUrl('https://example.com/'))
      .toBe('https://example.com/');
  });

  it('should strip explicit utm_* tracking params and keep meaningful ones including generic ref', () => {
    expect(normalizeUrl('https://example.com/page?ref=foo&utm_source=bar&keep=me'))
      .toBe('https://example.com/page?keep=me&ref=foo');
  });

  it('preserves generic ref and utm query params as distinct page identity', () => {
    expect(normalizeUrl('https://example.com/page?ref=A'))
      .toBe('https://example.com/page?ref=A');
    expect(normalizeUrl('https://example.com/page?ref=B'))
      .toBe('https://example.com/page?ref=B');
    expect(normalizeUrl('https://example.com/page?ref=A'))
      .not.toBe(normalizeUrl('https://example.com/page?ref=B'));
    expect(normalizeUrl('https://example.com/page?utm=A'))
      .not.toBe(normalizeUrl('https://example.com/page?utm=B'));
  });

  it('should remove all query params if only tracking params present', () => {
    expect(normalizeUrl('https://example.com/page?utm_source=x&fbclid=y'))
      .toBe('https://example.com/page');
  });

  it('should sort remaining query params alphabetically', () => {
    expect(normalizeUrl('https://example.com/page?z=1&a=2'))
      .toBe('https://example.com/page?a=2&z=1');
  });

  it('should ignore fragment for page identity', () => {
    expect(normalizeUrl('https://example.com/page?utm=x#section'))
      .toBe('https://example.com/page?utm=x');
  });

  it('should preserve www on host-only URLs', () => {
    expect(normalizeUrl('https://WWW.Example.COM'))
      .toBe('https://www.example.com/');
  });

  it('should preserve wiki path case used for fetch identity', () => {
    expect(normalizeUrl('https://wiki.postgresql.org/wiki/SSI'))
      .toBe('https://wiki.postgresql.org/wiki/SSI');
  });

  it('should treat path-case, www, and trailing-slash variants as distinct keys', () => {
    expect(normalizeUrl('https://wiki.postgresql.org/wiki/SSI'))
      .not.toBe(normalizeUrl('https://wiki.postgresql.org/wiki/ssi'));
    expect(normalizeUrl('https://www.example.com/page'))
      .not.toBe(normalizeUrl('https://example.com/page'));
    expect(normalizeUrl('https://example.com/page/'))
      .not.toBe(normalizeUrl('https://example.com/page'));
  });

  it('should handle malformed URLs gracefully', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});
