import { describe, expect, it } from 'vitest';
import {
  extractRelevantPassages,
  parseDocumentSections,
  rankDocumentSections,
} from '../src/passage-extractor.js';

const MARKDOWN = [
  '## Other Topic',
  '',
  'This section talks about chairs and furniture.',
  '',
  '## Install Fastify',
  '',
  'Create the project first.',
  '',
  '```js',
  'const app = fastify()',
  '',
  'app.listen()',
  '```',
].join('\n');

describe('parse and rank document sections', () => {
  it('parses stable sN ids and ranks every section without rewriting source text', () => {
    const parsed = parseDocumentSections(MARKDOWN);

    expect(parsed.map((section) => section.id)).toEqual(['s0', 's1']);
    expect(parsed[1].text).toContain('```js\nconst app = fastify()\n\napp.listen()\n```');
    expect(MARKDOWN.slice(parsed[1].source_offset.start, parsed[1].source_offset.end)).toContain('## Install Fastify');

    const ranked = rankDocumentSections(parsed, 'fastify listen');
    expect(ranked).toHaveLength(parsed.length);
    expect(ranked[0].id).toBe('s1');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);

    const extracted = extractRelevantPassages(MARKDOWN, 'fastify listen', { topN: 5 });
    expect(extracted.passages[0].section_id).toBe('s1');
    expect(extracted.passages[0].text).toBe(parsed[1].text);
  });

  it('keeps needed reference definitions with the parsed section text', () => {
    const markdown = 'See the [docs][ref].\n\n[ref]: https://example.com/docs';
    const parsed = parseDocumentSections(markdown);
    expect(parsed[0].id).toBe('s0');
    expect(parsed[0].text).toContain('[ref]: https://example.com/docs');
    expect(parsed[0].definitions?.[0]?.text).toBe('[ref]: https://example.com/docs');
    expect(markdown.slice(parsed[0].source_offset.start, parsed[0].source_offset.end)).toBe('See the [docs][ref].');
  });
});
