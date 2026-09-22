import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, it, expect } from 'vitest';
import { extractRelevantPassages, preprocessText } from '../src/passage-extractor.js';

const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();

function firstDefinitionUrl(markdown: string, identifier: string): string | undefined {
  const tree = markdownParser.parse(markdown) as {
    children?: Array<{ type?: string; identifier?: string; url?: string }>;
  };
  const def = (tree.children ?? []).find((node) => (
    node.type === 'definition' && node.identifier === identifier
  ));
  return def?.url;
}

describe('preprocessText', () => {
  it('should lowercase and strip punctuation', () => {
    expect(preprocessText('Hello, World! Fastify is great.'))
      .toEqual(['hello', 'world', 'fastify', 'is', 'great']);
  });

  it('should filter empty tokens', () => {
    expect(preprocessText('a  b   c'))
      .toEqual(['a', 'b', 'c']);
  });

  it('preserves Node.js, read_csv, C++, C#, and version numbers as exact tokens', () => {
    expect(preprocessText('Node.js')).toEqual(expect.arrayContaining(['node.js', 'node', 'js']));
    expect(preprocessText('read_csv')).toEqual(expect.arrayContaining(['read_csv', 'read', 'csv']));
    expect(preprocessText('C++')).toEqual(['c++']);
    expect(preprocessText('C#')).toEqual(['c#']);
    expect(preprocessText('3.11')).toEqual(['3.11']);
    expect(preprocessText('C++')).not.toContain('c');
  });

  it('keeps non-Latin words instead of stripping them', () => {
    expect(preprocessText('東京')).toContain('東京');
    expect(preprocessText('欢迎来到東京旅行')).toContain('東京');
  });

  it('emits identifier components so csv can find read_csv without substring matching', () => {
    expect(preprocessText('read_csv')).toEqual(expect.arrayContaining(['read_csv', 'csv']));
    expect(preprocessText('chair')).toEqual(['chair']);
    expect(preprocessText('chair')).not.toContain('air');
  });

  it('preserves negation words that can be identifiers', () => {
    expect(preprocessText('not deprecated')).toEqual(['not', 'deprecated']);
  });

  it('keeps accented Latin words as whole Unicode tokens', () => {
    expect(preprocessText('café')).toEqual(['café']);
    expect(preprocessText('naïve résumé')).toEqual(['naïve', 'résumé']);
  });

  it('matches C# and C++ only at identifier boundaries', () => {
    expect(preprocessText('the C# language and C++ templates')).toEqual(
      expect.arrayContaining(['c#', 'c++']),
    );
    expect(preprocessText('learnC#now ABC#DEF')).not.toContain('c#');
    expect(preprocessText('C#embedded')).not.toContain('c#');
    expect(preprocessText('embedC++code')).not.toContain('c++');
    expect(preprocessText('C++code')).not.toContain('c++');
  });

  it('recognizes lowercase C++, C#, and F# on both tokenizer paths', () => {
    expect(preprocessText('c++')).toEqual(['c++']);
    expect(preprocessText('c#')).toEqual(['c#']);
    expect(preprocessText('f#')).toEqual(['f#']);
    expect(preprocessText('c++')).not.toContain('c');
    expect(preprocessText('use c++ and c# with f# 東京')).toEqual(
      expect.arrayContaining(['c++', 'c#', 'f#', '東京']),
    );
    expect(preprocessText('learnc++now embedc#code f#embedded')).not.toEqual(
      expect.arrayContaining(['c++', 'c#', 'f#']),
    );
  });

  it('keeps accented Latin words intact when mixed with CJK', () => {
    expect(preprocessText('café 東京')).toEqual(['café', '東京']);
    expect(preprocessText('naïve résumé 東京')).toEqual(['naïve', 'résumé', '東京']);
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

const FENCED_INSTALL = [
  '## Install Fastify',
  '',
  'Create the project first.',
  '',
  '```js',
  'const app = fastify()',
  '',
  'app.listen()',
  '```',
  '',
  'Then start the server.',
].join('\n');

const GFM_TABLE = [
  '## Versions',
  '',
  'Supported releases:',
  '',
  '| Version | Status |',
  '| ------- | ------ |',
  '| 1.0     | stable |',
  '| 2.0     | beta   |',
].join('\n');

const NESTED_LIST = [
  '## Steps',
  '',
  'Do these:',
  '',
  '- parent',
  '  - child a',
  '  - child b',
  '- sibling',
].join('\n');

const INDENTED_CODE = [
  '## Example',
  '',
  'Indent the block:',
  '',
  '    def read_csv():',
  '        return 1',
].join('\n');

describe('extractRelevantPassages structural grouping', () => {
  it('keeps heading, explanation, fenced code with blank lines, and qualification together', () => {
    const result = extractRelevantPassages(FENCED_INSTALL, '', { topN: 5 });

    expect(result.total_passages).toBe(1);
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0].text).toBe(FENCED_INSTALL);
    expect(result.passages[0].text).toContain('```js\nconst app = fastify()\n\napp.listen()\n```');
    expect(result.passages[0].heading).toBe('Install Fastify');
  });

  it('keeps a GFM table intact with its heading and explanation', () => {
    const result = extractRelevantPassages(GFM_TABLE, '', { topN: 5 });

    expect(result.total_passages).toBe(1);
    expect(result.passages[0].text).toBe(GFM_TABLE);
    expect(result.passages[0].text).toContain('| 1.0     | stable |');
    expect(result.passages[0].text).toContain('| 2.0     | beta   |');
  });

  it('keeps a nested list intact with its heading', () => {
    const result = extractRelevantPassages(NESTED_LIST, '', { topN: 5 });

    expect(result.total_passages).toBe(1);
    expect(result.passages[0].text).toContain('- parent\n  - child a\n  - child b\n- sibling');
    expect(result.passages[0].heading).toBe('Steps');
  });

  it('keeps indented code intact with its heading and explanation', () => {
    const result = extractRelevantPassages(INDENTED_CODE, '', { topN: 5 });

    expect(result.total_passages).toBe(1);
    expect(result.passages[0].text).toContain('    def read_csv():\n        return 1');
    expect(result.passages[0].text).toContain('Indent the block:');
  });

  it('does not merge adjacent heading sections', () => {
    const markdown = [
      '## First',
      '',
      'First body mentions apples.',
      '',
      '## Second',
      '',
      'Second body mentions oranges.',
    ].join('\n');

    const result = extractRelevantPassages(markdown, '', { topN: 5 });

    expect(result.total_passages).toBe(2);
    expect(result.passages[0].text).toContain('## First');
    expect(result.passages[0].text).toContain('apples');
    expect(result.passages[0].text).not.toContain('## Second');
    expect(result.passages[1].text).toContain('## Second');
    expect(result.passages[1].text).toContain('oranges');
    expect(result.passages[0].position).toBe(0);
    expect(result.passages[1].position).toBe(1);
  });

  it('keeps headerless plain paragraphs as individual passages', () => {
    const markdown = 'Para one about cats.\n\nPara two about dogs.';
    const result = extractRelevantPassages(markdown, '', { topN: 5 });

    expect(result.total_passages).toBe(2);
    expect(result.passages.map((p) => p.text)).toEqual([
      'Para one about cats.',
      'Para two about dogs.',
    ]);
  });

  it('groups headerless explanation with the following code fence', () => {
    const markdown = [
      'Call read_csv like this:',
      '',
      '```py',
      'read_csv("a.csv")',
      '```',
    ].join('\n');

    const result = extractRelevantPassages(markdown, '', { topN: 5 });

    expect(result.total_passages).toBe(1);
    expect(result.passages[0].text).toBe(markdown);
  });

  it('groups multi-level headings with their own body, never a heading alone', () => {
    const markdown = [
      '# Guide',
      '',
      'Intro paragraph.',
      '',
      '## Setup',
      '',
      'Setup details.',
      '',
      '### Linux',
      '',
      'Linux notes.',
    ].join('\n');

    const result = extractRelevantPassages(markdown, '', { topN: 5 });

    expect(result.total_passages).toBe(3);
    expect(result.passages[0].heading).toBe('Guide');
    expect(result.passages[0].text).toContain('# Guide');
    expect(result.passages[0].text).toContain('Intro paragraph.');
    expect(result.passages[0].text).not.toContain('## Setup');
    expect(result.passages[1].heading).toBe('Guide Setup');
    expect(result.passages[1].text).toContain('## Setup');
    expect(result.passages[1].text).toContain('Setup details.');
    expect(result.passages[2].heading).toBe('Guide Setup Linux');
    expect(result.passages[2].text).toContain('### Linux');
    expect(result.passages[2].text).toContain('Linux notes.');
    for (const passage of result.passages) {
      const onlyHeading = /^(#{1,6}\s+[^\n]+)\s*$/.test(passage.text);
      expect(onlyHeading).toBe(false);
    }
  });

  it('keeps a short headed prose section together instead of splitting every paragraph', () => {
    const markdown = [
      '## History',
      '',
      'Paragraph one about origins.',
      '',
      'Paragraph two about growth.',
      '',
      'Paragraph three about today.',
      '',
      'Paragraph four about future.',
    ].join('\n');

    const result = extractRelevantPassages(markdown, '', { topN: 5 });

    expect(result.total_passages).toBe(1);
    expect(result.passages[0].text).toBe(markdown);
    expect(result.passages[0].heading).toBe('History');
  });

  it('splits a truly long headed section at AST block boundaries near the soft character target', () => {
    const block = (label: string) => `${label} ${'word '.repeat(220).trim()}.`;
    const markdown = [
      '## Long History',
      '',
      block('First'),
      '',
      block('Second'),
      '',
      block('Third'),
      '',
      block('Fourth'),
    ].join('\n');

    const result = extractRelevantPassages(markdown, '', { topN: 8 });

    expect(result.total_passages).toBeGreaterThan(1);
    expect(result.passages[0].text).toContain('## Long History');
    expect(result.passages[0].text).toContain('First');
    expect(result.passages.some((p) => p.text.includes('Fourth'))).toBe(true);
    expect(result.passages.every((p) => p.heading === 'Long History')).toBe(true);
    for (const passage of result.passages) {
      expect(passage.text.includes('First') && passage.text.includes('Fourth') && passage.text.length > 4000).toBe(false);
    }
    expect(result.passages.some((p) => /Fir\s*st/.test(p.text) && !p.text.includes('First'))).toBe(false);
  });

  it('keeps headed continuation groups together after a soft-size split', () => {
    const large = (label: string) => `${label} ${'word '.repeat(450).trim()}.`;
    const markdown = [
      '## Continued',
      '',
      large('Lead'),
      '',
      large('Mid'),
      '',
      'Tail paragraph one stays with the continuation.',
      '',
      'Tail paragraph two also stays with the continuation.',
    ].join('\n');

    const result = extractRelevantPassages(markdown, '', { topN: 8 });
    const tails = result.passages.filter((p) => (
      p.text.includes('Tail paragraph one') || p.text.includes('Tail paragraph two')
    ));

    expect(result.total_passages).toBeGreaterThan(1);
    expect(result.passages[0].text).toContain('## Continued');
    expect(result.passages.every((p) => p.heading === 'Continued')).toBe(true);
    expect(tails).toHaveLength(1);
    expect(tails[0].text).toContain('Tail paragraph one');
    expect(tails[0].text).toContain('Tail paragraph two');
    expect(tails[0].text).not.toMatch(/^## /);
  });

  it('does not truncate a single giant AST node that exceeds the soft target', () => {
    const giant = `Giant ${'word '.repeat(1200).trim()}.`;
    const markdown = `## Giant\n\n${giant}`;
    const result = extractRelevantPassages(markdown, '', { topN: 3 });

    expect(result.total_passages).toBe(1);
    expect(result.passages[0].text).toContain(giant);
  });

  it('attaches consecutive headings without bodies to the following content', () => {
    const markdown = [
      '# Documentation',
      '',
      '# TypeScript 4.9',
      '',
      '## The operator',
      '',
      'Body after empty headings.',
      '',
      '## Next',
      '',
      'Next body.',
    ].join('\n');

    const result = extractRelevantPassages(markdown, '', { topN: 5 });

    expect(result.passages.some((p) => /^(#{1,6}\s+[^\n]+)\s*$/.test(p.text))).toBe(false);
    expect(result.passages[0].text).toContain('# Documentation');
    expect(result.passages[0].text).toContain('# TypeScript 4.9');
    expect(result.passages[0].text).toContain('## The operator');
    expect(result.passages[0].text).toContain('Body after empty headings.');
    expect(result.passages[0].text).not.toContain('## Next');
    expect(result.passages[1].text).toContain('## Next');
  });

  it('exposes source offsets that slice the original markdown', () => {
    const markdown = 'Intro para.\n\n## Target\n\nTarget body.';
    const result = extractRelevantPassages(markdown, '', { topN: 5 });

    expect(result.total_passages).toBe(2);
    const target = result.passages.find((p) => p.text.includes('## Target'));
    expect(target?.source_offset).toEqual({
      start: expect.any(Number),
      end: expect.any(Number),
    });
    expect(markdown.slice(target!.source_offset!.start, target!.source_offset!.end)).toBe(target!.text);
  });

  it('attaches a referenced link definition to the selected text', () => {
    const markdown = 'See the [docs][ref].\n\n[ref]: https://example.com/docs';
    const result = extractRelevantPassages(markdown, '', { topN: 5 });
    const passage = result.passages.find((p) => p.text.includes('See the [docs][ref].'));

    expect(passage).toBeDefined();
    expect(passage!.text).toContain('https://example.com/docs');
    expect(markdown.slice(passage!.source_offset!.start, passage!.source_offset!.end)).toBe('See the [docs][ref].');
    expect(markdown.slice(passage!.source_offset!.start, passage!.source_offset!.end)).not.toBe(passage!.text);
    expect(passage!.definitions).toEqual([
      expect.objectContaining({
        identifier: 'ref',
        text: '[ref]: https://example.com/docs',
        source_offset: { start: expect.any(Number), end: expect.any(Number) },
      }),
    ]);
    const def = passage!.definitions![0];
    expect(markdown.slice(def.source_offset.start, def.source_offset.end)).toBe(def.text);
  });
});

describe('extractRelevantPassages lexical ranking', () => {
  it('ranks whole token air above chair', () => {
    const markdown = 'Sit on the chair.\n\nFresh air outside.';
    const result = extractRelevantPassages(markdown, 'air', { topN: 2 });

    expect(result.passages[0].text).toContain('Fresh air');
    expect(result.passages[0].score).toBeGreaterThan(result.passages.find((p) => p.text.includes('chair'))?.score ?? -1);
  });

  it('ranks Node.js as an exact identifier, not a punctuation-stripped collapse', () => {
    const markdown = [
      'Install Node separately and compile js later.',
      '',
      'Use Node.js 20 for the server runtime.',
    ].join('\n');
    const result = extractRelevantPassages(markdown, 'Node.js', { topN: 1 });

    expect(result.passages[0].text).toContain('Node.js 20');
    expect(result.passages[0].score).toBeGreaterThan(0);
  });

  it('ranks read_csv above a split read csv phrase', () => {
    const markdown = 'Please read csv files by hand.\n\nCall read_csv on the path.';
    const result = extractRelevantPassages(markdown, 'read_csv', { topN: 1 });

    expect(result.passages[0].text).toContain('read_csv');
    expect(result.passages[0].score).toBeGreaterThan(0);
  });

  it('ranks a non-Latin Tokyo query without stripping the script', () => {
    const markdown = 'Paris is in France.\n\n東京は日本の首都です。';
    const result = extractRelevantPassages(markdown, '東京', { topN: 1 });

    expect(result.passages[0].text).toContain('東京');
    expect(result.passages[0].score).toBeGreaterThan(0);
  });

  it('distinguishes C++ from C and C#', () => {
    const markdown = [
      '## C',
      '',
      'Use C for kernels.',
      '',
      '## C++',
      '',
      'Use C++ for games.',
      '',
      '## C#',
      '',
      'Use C# for Windows.',
    ].join('\n');
    const result = extractRelevantPassages(markdown, 'C++', { topN: 3, minScore: 0.0001 });

    expect(result.passages[0].text).toContain('C++ for games');
    expect(result.passages[0].heading).toBe('C++');
    expect(result.passages.some((p) => p.text.includes('C for kernels') && p.score >= result.passages[0].score)).toBe(false);
    expect(result.passages.some((p) => p.text.includes('C# for Windows') && p.score >= result.passages[0].score)).toBe(false);
  });

  it('preserves numbers and does not collapse 3.11 into 311', () => {
    const markdown = 'Error code 311 is unrelated.\n\nProtocol version 3.11 is current.';
    const result = extractRelevantPassages(markdown, '3.11', { topN: 1 });

    expect(result.passages[0].text).toContain('3.11');
    expect(result.passages[0].score).toBeGreaterThan(0);
  });

  it('preserves negation so not deprecated outranks is deprecated', () => {
    const markdown = 'This API is deprecated.\n\nThis API is not deprecated.';
    const result = extractRelevantPassages(markdown, 'not deprecated', { topN: 2 });

    expect(result.passages[0].text).toContain('not deprecated');
    expect(result.passages[0].score).toBeGreaterThan(
      result.passages.find((p) => p.text.includes('is deprecated') && !p.text.includes('not'))?.score ?? 0,
    );
  });

  it('returns deterministic score-zero fallback for empty query and no lexical hits', () => {
    const markdown = [
      'Fastify is a fast and low-overhead web framework for Node.js.',
      'TypeScript adds static type checking to JavaScript.',
      'To set up a Fastify server, install the package and create an app instance.',
      'Prisma is a next-generation ORM for TypeScript and Node.js.',
      'Fastify plugins extend server functionality with decorators and hooks.',
      'This document has nothing to do with the query at all.',
    ].join('\n\n');

    const noQuery = extractRelevantPassages(markdown, '', { topN: 2 });
    expect(noQuery.passages).toHaveLength(2);
    expect(noQuery.passages.every((p) => p.score === 0)).toBe(true);
    expect(noQuery.passages[0].text).toContain('Fastify is a fast');
    expect(noQuery.passages[0].position).toBe(0);

    const noHits = extractRelevantPassages(markdown, 'quantum computing', { topN: 3 });
    expect(noHits.passages).toHaveLength(3);
    expect(noHits.passages.every((p) => p.score === 0)).toBe(true);
    expect(noHits.passages.map((p) => p.position)).toEqual([0, 1, 2]);

    const noHitsMinScore = extractRelevantPassages(markdown, 'quantum computing', { topN: 3, minScore: 0.1 });
    expect(noHitsMinScore.passages).toEqual([]);

    const noQueryMinScore = extractRelevantPassages(markdown, '', { topN: 2, minScore: 0.1 });
    expect(noQueryMinScore.passages).toHaveLength(2);
    expect(noQueryMinScore.passages.every((p) => p.score === 0)).toBe(true);
  });

  it('lets csv find read_csv while exact read_csv outranks a split read csv phrase', () => {
    const markdown = 'Please read csv files by hand.\n\nCall read_csv on the path.';
    const component = extractRelevantPassages(markdown, 'csv', { topN: 2, contextWindow: 0 });
    expect(component.passages.some((p) => p.text.includes('read_csv') && p.score > 0)).toBe(true);

    const exact = extractRelevantPassages(markdown, 'read_csv', { topN: 2, contextWindow: 0 });
    expect(exact.passages[0].text).toContain('read_csv');
    expect(exact.passages[0].score).toBeGreaterThan(
      exact.passages.find((p) => p.text.includes('read csv'))?.score ?? 0,
    );
  });

  it('finds Tokyo inside Chinese or Japanese prose without swallowing the whole script run', () => {
    const markdown = '欢迎来到巴黎旅行。\n\n欢迎来到東京旅行。\n\n東京は日本の首都です。';
    const chinese = extractRelevantPassages(markdown, '東京', { topN: 2, contextWindow: 0 });
    expect(chinese.passages[0].text).toMatch(/東京/);
    expect(chinese.passages[0].score).toBeGreaterThan(0);
  });

  it('respects topN, minScore, and contextWindow on structural groups', () => {
    const markdown = [
      '## Alpha',
      '',
      'Unrelated furniture.',
      '',
      '## Beta',
      '',
      'Fastify server setup lives here.',
      '',
      '## Gamma',
      '',
      'Also unrelated.',
    ].join('\n');

    const limited = extractRelevantPassages(markdown, 'fastify', { topN: 1, contextWindow: 0 });
    expect(limited.passages).toHaveLength(1);
    expect(limited.passages[0].text).toContain('Fastify server setup');

    const filtered = extractRelevantPassages(markdown, 'fastify', { topN: 5, minScore: 999, contextWindow: 0 });
    expect(filtered.passages).toEqual([]);

    const withContext = extractRelevantPassages(markdown, 'fastify', { topN: 1, contextWindow: 1 });
    expect(withContext.passages.map((p) => p.heading)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('breaks equal scores by structural position', () => {
    const markdown = 'The widget appears here.\n\nThe widget appears here.';
    const result = extractRelevantPassages(markdown, 'widget', { topN: 2, contextWindow: 0 });

    expect(result.passages).toHaveLength(2);
    expect(result.passages[0].score).toBe(result.passages[1].score);
    expect(result.passages[0].position).toBe(0);
    expect(result.passages[1].position).toBe(1);
  });

  it('ranks lowercase c++ against C++ documents without collapsing to C', () => {
    const markdown = 'Use C here.\n\nUse C++ here.';
    const result = extractRelevantPassages(markdown, 'c++', { topN: 5, minScore: 0.0001 });

    expect(result.passages).toHaveLength(1);
    expect(result.passages[0].text).toContain('Use C++ here.');
    expect(result.passages.some((p) => p.text === 'Use C here.')).toBe(false);
  });

  it('finds café and résumé in mixed-script documents', () => {
    const cafe = extractRelevantPassages('café 東京', 'café', { topN: 1, minScore: 0.0001 });
    expect(cafe.passages).toHaveLength(1);
    expect(cafe.passages[0].text).toContain('café');
    expect(cafe.passages[0].score).toBeGreaterThan(0);

    const resume = extractRelevantPassages('Unrelated.\n\nrésumé 東京', 'résumé', { topN: 1, minScore: 0.0001 });
    expect(resume.passages).toHaveLength(1);
    expect(resume.passages[0].text).toContain('résumé');
    expect(resume.passages[0].score).toBeGreaterThan(0);
  });

  it('preserves first-definition precedence when a later conflicting def is in the base span', () => {
    const markdown = [
      '[ref]: https://correct.example',
      '',
      '## Topic',
      '',
      'See [docs][ref].',
      '',
      '[ref]: https://wrong.example',
      '',
      'More text.',
    ].join('\n');
    const result = extractRelevantPassages(markdown, 'docs', { topN: 1 });
    const passage = result.passages[0];
    const base = markdown.slice(passage.source_offset!.start, passage.source_offset!.end);

    expect(firstDefinitionUrl(markdown, 'ref')).toBe('https://correct.example');
    expect(firstDefinitionUrl(passage.text, 'ref')).toBe('https://correct.example');
    expect(base).toContain('## Topic');
    expect(base).toContain('See [docs][ref].');
    expect(base).toContain('[ref]: https://wrong.example');
    expect(base).not.toContain('[ref]: https://correct.example');
    expect(passage.text.startsWith('[ref]: https://correct.example')).toBe(true);
    expect(passage.definitions).toEqual([
      expect.objectContaining({
        identifier: 'ref',
        text: '[ref]: https://correct.example',
        source_offset: { start: 0, end: '[ref]: https://correct.example'.length },
      }),
    ]);
    expect(passage.definitions).toHaveLength(1);
  });

  it('collects nested typed references, stops cycles, and keeps footnote/link namespaces distinct', () => {
    const nested = 'Claim[^n].\n\n[^n]: See [source][ref].\n\n[ref]: https://example.com/evidence';
    const nestedResult = extractRelevantPassages(nested, '', { topN: 10 });
    const claim = nestedResult.passages.find((p) => p.text.includes('Claim[^n].'));
    expect(claim).toBeDefined();
    expect(claim!.text).toContain('[^n]: See [source][ref].');
    expect(firstDefinitionUrl(claim!.text, 'ref')).toBe('https://example.com/evidence');
    expect(claim!.definitions?.map((d) => d.identifier)).toEqual(['n', 'ref']);

    const cyclic = 'Start[^a].\n\n[^a]: See [^b].\n\n[^b]: Back to [^a].';
    const cyclicResult = extractRelevantPassages(cyclic, '', { topN: 10 });
    const start = cyclicResult.passages.find((p) => p.text.includes('Start[^a].'));
    expect(start).toBeDefined();
    expect(start!.text).toContain('[^a]: See [^b].');
    expect(start!.text).toContain('[^b]: Back to [^a].');
    expect(start!.definitions?.map((d) => d.identifier).sort()).toEqual(['a', 'b']);

    const namespaced = 'Claim[^n].\n\n[^n]: Footnote only.\n\n[n]: https://link-namespace.example';
    const namespacedResult = extractRelevantPassages(namespaced, '', { topN: 10 });
    const footnoteClaim = namespacedResult.passages.find((p) => p.text.includes('Claim[^n].'));
    expect(footnoteClaim).toBeDefined();
    expect(footnoteClaim!.text).toContain('[^n]: Footnote only.');
    expect(footnoteClaim!.text).not.toContain('https://link-namespace.example');
    expect(footnoteClaim!.definitions?.every((d) => d.identifier === 'n' && d.text.startsWith('[^n]:'))).toBe(true);
  });

  it('expands contextWindow on zero-score no-hit fallback but not empty query or positive minScore', () => {
    const markdown = 'Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.';

    const noHit = extractRelevantPassages(markdown, 'unmatchedxyz', {
      topN: 1,
      contextWindow: 1,
      minScore: 0,
    });
    expect(noHit.passages.map((p) => p.text)).toEqual([
      'Alpha paragraph.',
      'Beta paragraph.',
    ]);

    const emptyQuery = extractRelevantPassages(markdown, '', {
      topN: 1,
      contextWindow: 1,
      minScore: 0,
    });
    expect(emptyQuery.passages.map((p) => p.text)).toEqual(['Alpha paragraph.']);

    const filtered = extractRelevantPassages(markdown, 'unmatchedxyz', {
      topN: 1,
      contextWindow: 1,
      minScore: 0.1,
    });
    expect(filtered.passages).toEqual([]);
  });
});
