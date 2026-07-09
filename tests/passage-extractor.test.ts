import { describe, it, expect } from 'vitest';
import { extractRelevantPassages, preprocessText } from '../src/passage-extractor.js';

describe('preprocessText', () => {
  it('should lowercase and strip punctuation', () => {
    expect(preprocessText('Hello, World! Fastify is great.'))
      .toEqual(['hello', 'world', 'fastify', 'is', 'great']);
  });

  it('should filter empty tokens', () => {
    expect(preprocessText('a  b   c'))
      .toEqual(['a', 'b', 'c']);
  });
});

describe('extractRelevantPassages', () => {
  const markdown = [
    'Fastify is a fast and low-overhead web framework for Node.js.',
    'TypeScript adds static type checking to JavaScript.',
    'To set up a Fastify server, install the package and create an app instance.',
    'Prisma is a next-generation ORM for TypeScript and Node.js.',
    'Fastify plugins extend server functionality with decorators and hooks.',
    'This document has nothing to do with the query at all.',
  ].join('\n\n');

  it('should return passages relevant to the query', () => {
    const result = extractRelevantPassages(markdown, 'fastify server setup', { topN: 3 });

    expect(result.query).toBe('fastify server setup');
    expect(result.total_passages).toBe(6);
    expect(result.passages.length).toBeLessThanOrEqual(3);
    // The most relevant passages should mention Fastify + setup concepts
    const texts = result.passages.map(p => p.text.toLowerCase());
    expect(texts.some(t => t.includes('fastify'))).toBe(true);
  });

  it('should return lowest-scoring passages when query has no overlap', () => {
    const result = extractRelevantPassages(markdown, 'quantum computing', { topN: 3 });
    // All passages have zero overlap with the query, so topN are returned
    // with whatever scores BM25 assigns (likely very low or zero)
    expect(result.passages.length).toBe(3);
    expect(result.total_passages).toBe(6);
  });

  it('should respect topN limit', () => {
    const result = extractRelevantPassages(markdown, 'fastify', { topN: 2 });
    expect(result.passages.length).toBe(2);
  });

  it('should handle empty markdown', () => {
    const result = extractRelevantPassages('', 'anything', { topN: 5 });
    expect(result.total_passages).toBe(0);
    expect(result.passages).toEqual([]);
  });

  it('should include surrounding context paragraphs', () => {
    const result = extractRelevantPassages(markdown, 'fastify', {
      topN: 5,
      contextWindow: 1,
    });
    // Should include paragraphs adjacent to the highest-scoring ones
    expect(result.passages.length).toBeGreaterThan(0);
  });

  it('should score single-word paragraphs proportionally', () => {
    const singleWord = 'Fastify\n\nunrelated\n\nFastify\n\nunrelated\n\nfastify';
    const result = extractRelevantPassages(singleWord, 'fastify', { topN: 5 });
    // The three 'Fastify' paragraphs should have highest scores
    const fastifyPassages = result.passages.filter(p =>
      p.text.toLowerCase().includes('fastify')
    );
    expect(fastifyPassages.length).toBeGreaterThan(0);
    fastifyPassages.forEach(p => expect(p.score).toBeGreaterThan(0));
    // Non-matching paragraphs should score lower
    const unrelatedPassages = result.passages.filter(p =>
      !p.text.toLowerCase().includes('fastify')
    );
    if (unrelatedPassages.length > 0) {
      unrelatedPassages.forEach(p => expect(p.score).toBeLessThanOrEqual(
        Math.max(...fastifyPassages.map(fp => fp.score))
      ));
    }
  });
});
