/**
 * Structural Markdown sections and optional query ranking for webfetch.
 *
 * Groups remark-parse + remark-gfm AST blocks (exact original slices),
 * ranks whole sections locally for explicit query/section budget selection.
 */

import MiniSearch from 'minisearch';
import MarkdownIt from 'markdown-it';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface PassageDefinition {
  identifier: string;
  text: string;
  source_offset: { start: number; end: number };
}

export interface DocumentSection {
  id: string;
  text: string;
  heading?: string;
  source_offset: { start: number; end: number };
  definitions?: PassageDefinition[];
}

export interface RankedSection {
  id: string;
  score: number;
  position: number;
}

interface ParsedBlockNode {
  type: string;
  depth?: number;
  identifier?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: unknown[];
}

type ReferenceNamespace = 'link' | 'footnote';

interface StructuralRef {
  identifier: string;
  namespace: ReferenceNamespace;
}

interface StructuralBlock {
  type: string;
  start: number;
  end: number;
  depth?: number;
  identifier?: string;
  text: string;
  referencedRefs: StructuralRef[];
}

interface StructuralGroup {
  text: string;
  heading?: string;
  start: number;
  end: number;
  definitions: PassageDefinition[];
}

const STRUCTURAL_TYPES = new Set(['code', 'table', 'list']);
const PROSE_TYPES = new Set(['paragraph', 'blockquote']);
const DEFINITION_TYPES = new Set(['definition', 'footnoteDefinition']);
const REFERENCE_TYPES = new Set(['linkReference', 'imageReference', 'footnoteReference']);
const SOFT_GROUP_CHARS = 4000;
const SPECIAL_BOUNDED = String.raw`(?<![\p{L}\p{N}_])(?:C\+\+|C#|F#)(?![\p{L}\p{N}_])`;
const UNICODE_IDENTIFIER = String.raw`[\p{L}][\p{L}\p{N}_]*(?:[._][\p{L}\p{N}_]+)+`;
const UNICODE_WORD = String.raw`[\p{L}][\p{L}\p{N}_]*`;
const LATIN_IDENTIFIER = String.raw`[\p{Script=Latin}][\p{Script=Latin}\p{N}_]*(?:[._][\p{Script=Latin}\p{N}_]+)+`;
const LATIN_WORD = String.raw`[\p{Script=Latin}][\p{Script=Latin}\p{N}_]*`;
const DECIMAL = String.raw`-?\d+\.\d+`;
const INTEGER = String.raw`\d+`;
const FAST_WORD_SOURCE = `${SPECIAL_BOUNDED}|${UNICODE_IDENTIFIER}|${DECIMAL}|${UNICODE_WORD}|${INTEGER}`;
const MIXED_EXTRACT_SOURCE = `${SPECIAL_BOUNDED}|${LATIN_IDENTIFIER}|${DECIMAL}|${LATIN_WORD}|${INTEGER}`;
const NEEDS_SEGMENTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();
// Ranking needs block boundaries, not an inline rendering tree. Definitions
// still use remark so reference resolution and attached source spans stay exact.
const blockParser = new MarkdownIt({ html: true }).disable('inline');

function isStructural(type: string): boolean {
  return STRUCTURAL_TYPES.has(type);
}

function isProse(type: string): boolean {
  return PROSE_TYPES.has(type);
}

function isParsedBlockNode(node: unknown): node is ParsedBlockNode {
  return Boolean(
    node
    && typeof node === 'object'
    && 'type' in node
    && typeof (node as { type: unknown }).type === 'string',
  );
}

function parsedRootChildren(tree: unknown): ParsedBlockNode[] {
  if (!tree || typeof tree !== 'object' || !('children' in tree) || !Array.isArray(tree.children)) {
    return [];
  }
  return tree.children.filter(isParsedBlockNode);
}

function referenceNamespace(type: string): ReferenceNamespace | undefined {
  if (type === 'footnoteReference' || type === 'footnoteDefinition') return 'footnote';
  if (type === 'linkReference' || type === 'imageReference' || type === 'definition') return 'link';
  return undefined;
}

function collectReferenceIds(node: unknown, refs: StructuralRef[]): void {
  if (!node || typeof node !== 'object') return;
  const typed = node as { type?: string; identifier?: string; children?: unknown[] };
  if (typed.type && REFERENCE_TYPES.has(typed.type) && typed.identifier) {
    const namespace = referenceNamespace(typed.type);
    if (namespace) refs.push({ identifier: typed.identifier, namespace });
  }
  if (!Array.isArray(typed.children)) return;
  for (const child of typed.children) collectReferenceIds(child, refs);
}

function fastMarkdownBlocks(markdown: string): StructuralBlock[] | undefined {
  if (markdown.includes(']:') || markdown.startsWith('\uFEFF')) return undefined;
  const starts = [0];
  for (const match of markdown.matchAll(/\r\n|\r|\n/g)) {
    starts.push(match.index! + match[0].length);
  }
  const lineEnd = (line: number): number => {
    let end = starts[line + 1] ?? markdown.length;
    if (markdown[end - 1] === '\n') end--;
    if (markdown[end - 1] === '\r') end--;
    return end;
  };
  const tokens = blockParser.parse(markdown, {});
  // markdown-it maps exclude trailing indented blank code lines that remark
  // retains. Use its exact node endpoints rather than guessing those spans.
  if (tokens.some((token) => token.type === 'code_block')) return undefined;
  // HTML can terminate a lazy list/quote differently across parsers. Keep the
  // reference parser for mixed containers rather than changing section units.
  if (markdown.includes('<') && tokens.some((token) => (
    token.type === 'blockquote_open' || token.type === 'bullet_list_open' || token.type === 'ordered_list_open'
  ))) return undefined;
  const blocks: StructuralBlock[] = [];
  for (const token of tokens) {
    if (token.level !== 0 || !token.map || token.nesting === -1) continue;
    let [first, last] = token.map;
    last--;
    while (last > first) {
      const line = markdown.slice(starts[last], lineEnd(last));
      if (!/^[ \t]*$/.test(line)) break;
      // NBSP/BOM lines are paragraph content, not CommonMark blank lines.
      last--;
    }
    let start = starts[first];
    let end = lineEnd(last);
    if (token.type === 'fence') {
      const closing = new RegExp(`^ {0,3}${token.markup[0]}{${token.markup.length},}[ \\t]*$`);
      if (last === first || !closing.test(markdown.slice(starts[last], end))) {
        end = markdown.length;
      }
    }
    const type = token.type === 'heading_open' ? 'heading'
      : token.type === 'paragraph_open' ? 'paragraph'
      : token.type === 'blockquote_open' ? 'blockquote'
      : token.type === 'bullet_list_open' || token.type === 'ordered_list_open' ? 'list'
      : token.type === 'fence' ? 'code'
      : token.type === 'table_open' ? 'table'
      : token.type === 'html_block' ? 'html'
      : token.type === 'hr' ? 'thematicBreak' : undefined;
    if (!type) return undefined;
    if (token.type !== 'html_block') {
      // CommonMark excludes a block's optional 1–3 leading spaces from its
      // start position, while raw HTML retains its indentation.
      while (start < end && start - starts[first] < 3 && markdown[start] === ' ') start++;
    }
    blocks.push({
      type,
      start,
      end,
      depth: type === 'heading' ? Number(token.tag.slice(1)) : undefined,
      text: markdown.slice(start, end),
      referencedRefs: [],
    });
  }
  return blocks;
}

function parseMarkdownBlocks(markdown: string): StructuralBlock[] {
  const fast = fastMarkdownBlocks(markdown);
  if (fast) return fast;
  const tree = markdownParser.parse(markdown);
  const nodes = parsedRootChildren(tree);
  const collectRefs = nodes.some((node) => DEFINITION_TYPES.has(node.type));
  const blocks: StructuralBlock[] = [];
  for (const node of nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const referencedRefs: StructuralRef[] = [];
    if (collectRefs) collectReferenceIds(node, referencedRefs);
    blocks.push({
      type: node.type,
      start,
      end,
      depth: node.type === 'heading' ? node.depth : undefined,
      identifier: node.identifier,
      text: markdown.slice(start, end),
      referencedRefs,
    });
  }
  return blocks;
}

function headingPlain(block: StructuralBlock): string {
  return block.text.replace(/^#{1,6}\s+/, '').trim();
}

function hasQualification(blocks: StructuralBlock[]): boolean {
  for (let i = 0; i < blocks.length - 1; i++) {
    if (isStructural(blocks[i].type) && isProse(blocks[i + 1].type)) return true;
  }
  return false;
}

function hasBody(blocks: StructuralBlock[]): boolean {
  return blocks.some((block) => block.type !== 'heading');
}

function applyHeading(
  stack: Array<{ depth: number; text: string }>,
  block: StructuralBlock,
): void {
  const depth = block.depth ?? 1;
  while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
    stack.pop();
  }
  stack.push({ depth, text: headingPlain(block) });
}

function headingPath(stack: Array<{ depth: number; text: string }>): string | undefined {
  return stack.map((item) => item.text).join(' ') || undefined;
}

function isTightAttach(current: StructuralBlock[], incoming: StructuralBlock): boolean {
  const last = current[current.length - 1];
  if (!last) return true;
  if (isProse(last.type) && isStructural(incoming.type)) return true;
  if (isStructural(last.type) && isProse(incoming.type) && !hasQualification(current)) return true;
  return false;
}

function isHeaderlessParagraphSplit(
  current: { heading?: string; blocks: StructuralBlock[] },
  incoming: StructuralBlock,
): boolean {
  if (current.heading) return false;
  const last = current.blocks[current.blocks.length - 1];
  if (!last) return false;
  return isProse(incoming.type) && isProse(last.type) && !isStructural(last.type);
}

function sliceLength(blocks: StructuralBlock[], incoming: StructuralBlock): number {
  if (blocks.length === 0) return incoming.end - incoming.start;
  return incoming.end - blocks[0].start;
}

function firstDefinitionsByKey(definitions: StructuralBlock[]): Map<string, StructuralBlock> {
  const first = new Map<string, StructuralBlock>();
  for (const definition of definitions) {
    const identifier = definition.identifier ?? '';
    const namespace = referenceNamespace(definition.type);
    if (!identifier || !namespace) continue;
    const key = `${namespace}:${identifier}`;
    if (!first.has(key)) first.set(key, definition);
  }
  return first;
}

function referencedDefinitions(
  _markdown: string,
  groupBlocks: StructuralBlock[],
  definitions: StructuralBlock[],
): PassageDefinition[] {
  const start = groupBlocks[0].start;
  const end = groupBlocks[groupBlocks.length - 1].end;
  const first = firstDefinitionsByKey(definitions);
  const queue: StructuralRef[] = [];
  const seen = new Set<string>();
  const attached: PassageDefinition[] = [];

  for (const block of groupBlocks) {
    for (const ref of block.referencedRefs) queue.push(ref);
  }

  while (queue.length > 0) {
    const ref = queue.shift();
    if (!ref) break;
    const key = `${ref.namespace}:${ref.identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const definition = first.get(key);
    if (!definition) continue;

    for (const nested of definition.referencedRefs) queue.push(nested);
    if (definition.start >= start && definition.end <= end) continue;

    attached.push({
      identifier: definition.identifier ?? ref.identifier,
      text: definition.text,
      source_offset: { start: definition.start, end: definition.end },
    });
  }

  return attached;
}

function flushGroup(
  markdown: string,
  current: { heading?: string; blocks: StructuralBlock[] } | null,
  definitions: StructuralBlock[],
  groups: StructuralGroup[],
): void {
  if (!current || current.blocks.length === 0) return;
  const start = current.blocks[0].start;
  const end = current.blocks[current.blocks.length - 1].end;
  const defs = referencedDefinitions(markdown, current.blocks, definitions);
  const sliced = markdown.slice(start, end);
  groups.push({
    text: defs.length > 0
      ? [...defs.map((definition) => definition.text), sliced].join('\n\n')
      : sliced,
    heading: current.heading,
    start,
    end,
    definitions: defs,
  });
}

function groupMarkdownSections(markdown: string): StructuralGroup[] {
  const blocks = parseMarkdownBlocks(markdown);
  const definitions = blocks.filter((block) => DEFINITION_TYPES.has(block.type));
  const groups: StructuralGroup[] = [];
  const headingStack: Array<{ depth: number; text: string }> = [];
  let current: { heading?: string; blocks: StructuralBlock[] } | null = null;

  for (const block of blocks) {
    if (DEFINITION_TYPES.has(block.type)) continue;

    if (block.type === 'heading') {
      if (current && hasBody(current.blocks)) {
        flushGroup(markdown, current, definitions, groups);
        current = null;
      }
      applyHeading(headingStack, block);
      if (!current) {
        current = { heading: headingPath(headingStack), blocks: [block] };
      } else {
        current.blocks.push(block);
        current.heading = headingPath(headingStack);
      }
      continue;
    }

    if (!current) {
      current = { heading: headingPath(headingStack), blocks: [block] };
      continue;
    }

    if (isHeaderlessParagraphSplit(current, block)) {
      flushGroup(markdown, current, definitions, groups);
      current = { heading: headingPath(headingStack), blocks: [block] };
      continue;
    }

    const overSoft = hasBody(current.blocks)
      && sliceLength(current.blocks, block) > SOFT_GROUP_CHARS
      && !isTightAttach(current.blocks, block);

    if (overSoft) {
      flushGroup(markdown, current, definitions, groups);
      current = { heading: headingPath(headingStack), blocks: [block] };
      continue;
    }

    current.blocks.push(block);
  }

  flushGroup(markdown, current, definitions, groups);
  return groups;
}

function identifierComponents(token: string): string[] {
  if (/^(?:C\+\+|C#|F#)$/i.test(token) || /^-?\d/.test(token) || !/[._]/.test(token)) {
    return [];
  }
  return token.split(/[._]/).filter(Boolean);
}

function pushToken(tokens: string[], token: string): void {
  tokens.push(token);
  for (const part of identifierComponents(token)) tokens.push(part);
}

function tokenizeLatinFast(text: string): string[] {
  const tokens: string[] = [];
  const latin = new RegExp(FAST_WORD_SOURCE, 'giu');
  for (const match of text.matchAll(latin)) {
    pushToken(tokens, match[0]);
  }
  return tokens;
}

function segmentWords(text: string): string[] {
  const tokens: string[] = [];
  for (const part of wordSegmenter.segment(text)) {
    if (part.isWordLike) tokens.push(part.segment);
  }
  return tokens;
}

function tokenizeText(text: string): string[] {
  if (!NEEDS_SEGMENTER.test(text)) {
    return tokenizeLatinFast(text);
  }

  const tokens: string[] = [];
  const extractable = new RegExp(MIXED_EXTRACT_SOURCE, 'giu');
  let cursor = 0;
  for (const match of text.matchAll(extractable)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push(...segmentWords(text.slice(cursor, index)));
    pushToken(tokens, match[0]);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) tokens.push(...segmentWords(text.slice(cursor)));
  return tokens;
}

/**
 * Tokenize query and document text with the same identifier-aware splitter.
 */
export function preprocessText(text: string): string[] {
  return tokenizeText(text).map((token) => token.toLowerCase());
}

function searchableBody(text: string): string {
  return text.replace(/```[\w+-]*/g, ' ');
}

function sectionId(position: number): string {
  return `s${position}`;
}

function toDocumentSection(group: StructuralGroup, position: number): DocumentSection {
  return {
    id: sectionId(position),
    text: group.text,
    heading: group.heading,
    source_offset: { start: group.start, end: group.end },
    ...(group.definitions.length > 0 ? { definitions: group.definitions } : {}),
  };
}

/**
 * Parse markdown into stable structural sections without ranking.
 */
export function parseDocumentSections(markdown: string): DocumentSection[] {
  return groupMarkdownSections(markdown).map((group, position) => toDocumentSection(group, position));
}

function scoreSections(sections: DocumentSection[], query: string): number[] {
  const scores = sections.map(() => 0);
  const queryTerms = new Set(tokenizeText(query).map((term) => term.toLowerCase()));
  if (queryTerms.size === 0 || sections.length === 0) return scores;

  const index = new MiniSearch({
    fields: ['heading', 'body'],
    storeFields: ['id'],
    tokenize: tokenizeText,
    // With prefix/fuzzy disabled only exact query terms can contribute. MiniSearch
    // records full field lengths before processTerm filtering, preserving BM25
    // normalization while avoiding postings for every unrelated page word.
    processTerm: (term) => {
      const lower = term.toLowerCase();
      return queryTerms.has(lower) ? lower : null;
    },
    searchOptions: searchDefaults,
  });

  index.addAll(sections.map((section, id) => ({
    id,
    heading: section.heading ?? '',
    body: searchableBody(section.text),
  })));

  for (const hit of index.search(query)) {
    scores[hit.id] = hit.score;
  }
  return scores;
}

/**
 * Rank every parsed section locally. Scores are not comparable across documents.
 */
export function rankDocumentSections(sections: DocumentSection[], query: string): RankedSection[] {
  const scores = scoreSections(sections, query);
  return sections
    .map((section, position) => ({
      id: section.id,
      score: scores[position],
      position,
    }))
    .sort((a, b) => b.score - a.score || a.position - b.position);
}

const searchDefaults = { boost: { heading: 2, body: 1 }, fuzzy: false as const, prefix: false as const };
