import { describe, it, expect } from 'vitest';
import { stripMarkdownFromData, ContentMode } from '../src/content-utils.js';

describe('stripMarkdownFromData', () => {
  const fullData = {
    markdown: '# Hello\n\nThis is a long article.',
    metadata: { title: 'Test', description: 'A test', language: 'en', word_count: 50 },
  };

  it('returns full data when mode is undefined (default)', () => {
    const result = stripMarkdownFromData(fullData, undefined);
    expect(result).toEqual(fullData);
    expect(result).toHaveProperty('markdown');
  });

  it('returns full data when mode is "full"', () => {
    const result = stripMarkdownFromData(fullData, 'full');
    expect(result).toEqual(fullData);
    expect(result).toHaveProperty('markdown');
  });

  it('strips markdown when mode is "relevant_only"', () => {
    const result = stripMarkdownFromData(fullData, 'relevant_only');
    expect(result).not.toHaveProperty('markdown');
    expect(result).toHaveProperty('metadata');
  });

  it('strips markdown when mode is "snippet"', () => {
    const result = stripMarkdownFromData(fullData, 'snippet');
    expect(result).not.toHaveProperty('markdown');
    expect(result).toHaveProperty('metadata');
  });

  it('handles undefined data gracefully', () => {
    const result = stripMarkdownFromData(undefined, 'relevant_only');
    expect(result).toBeUndefined();
  });

  it('does not mutate the original object', () => {
    const copy = { ...fullData };
    stripMarkdownFromData(fullData, 'relevant_only');
    expect(fullData).toEqual(copy);
    expect(fullData).toHaveProperty('markdown');
  });
});
