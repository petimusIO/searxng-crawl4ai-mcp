import { describe, it, expect } from 'vitest';

type ContentMode = 'full' | 'relevant_only' | 'snippet';

function stripMarkdownFromData(
  data: { markdown?: string; [key: string]: unknown } | undefined,
  contentMode: ContentMode | undefined
): typeof data {
  if (!data) return data;
  if (!contentMode || contentMode === 'full') return data;
  const { markdown: _, ...rest } = data;
  return rest;
}

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
});
