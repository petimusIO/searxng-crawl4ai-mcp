#!/usr/bin/env node
// Run after pnpm build. Pass --fixture <saved CRW source/raw JSON> for real pages.
import fs from 'node:fs';
import { clearMergeCache } from 'gpt-tokenizer/esm/encoding/o200k_base';
import { parseDocumentSections, rankDocumentSections } from '../dist/passage-extractor.js';
import { packBudgetedResponse } from '../dist/response-packer.js';
import { countResponseTokens } from '../dist/token-budget.js';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const runs = Number(options.get('--runs') ?? 20);
if (!Number.isInteger(runs) || runs < 1 || runs > 1000) throw new Error('--runs must be an integer from 1 to 1000');
const makePage = (name, markdown) => ({
  source: { url: `https://fixture.invalid/${name}`, title: name, success: true, source_type: 'scraped' },
  raw: { success: true, data: { markdown } },
});
const fixtures = [
  { name: 'prose', query: 'policy exception', pages: [makePage('prose', Array.from({ length: 35 }, (_, i) => `## Policy ${i}\n\n${'Keep the complete policy evidence and exception. '.repeat(12)}`).join('\n\n'))] },
  { name: 'structure', query: 'policy code', pages: [makePage('structure', Array.from({ length: 20 }, (_, i) => `## Policy ${i}\n\nKeep [the specification][ref${i}].\n\n\`\`\`js\nconst policy = ${i};\n\`\`\`\n\nThis qualification applies to the code.\n\n| Key | Value |\n| --- | --- |\n| policy | ${i} |\n\n[ref${i}]: https://example.org/${i}`).join('\n\n'))] },
  { name: 'multilingual', query: 'policy 中文 العربية', pages: [makePage('multilingual', Array.from({ length: 30 }, (_, i) => `## Policy ${i}\n\n中文政策与例外。 العربية سياسة واستثناءات. 日本語の方針。 😀\n\nKeep the complete policy and exception.`).join('\n\n'))] },
];
if (options.has('--fixture')) {
  const pages = JSON.parse(fs.readFileSync(options.get('--fixture'), 'utf8'));
  if (!Array.isArray(pages)) throw new Error('--fixture must contain an array of source/raw page snapshots');
  fixtures.unshift({ name: 'saved-pages', query: options.get('--query') ?? 'policy', pages: pages.filter(p => p.raw?.success && typeof p.raw.data?.markdown === 'string') });
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50_ms: sorted[Math.ceil(sorted.length * .5) - 1], p95_ms: sorted[Math.ceil(sorted.length * .95) - 1], min_ms: sorted[0], max_ms: sorted.at(-1) };
};
const output = { node: process.version, runs, cache: 'initialized modules, cold tokenizer merge cache per request, fresh parsing/ranking per request', fixtures: [] };
for (const fixture of fixtures) {
  if (!fixture.pages.length) throw new Error(`No usable pages in ${fixture.name}`);
  const samples = [];
  let evidence;
  for (let i = 0; i < runs; i++) {
    clearMergeCache();
    const started = performance.now();
    let parse_ms = 0, rank_ms = 0;
    const sources = fixture.pages.map(({ source, raw }) => {
      let at = performance.now();
      const sections = parseDocumentSections(raw.data.markdown);
      parse_ms += performance.now() - at;
      at = performance.now();
      const ranked = rankDocumentSections(sections, fixture.query);
      rank_ms += performance.now() - at;
      return { ...source, markdown: raw.data.markdown, sections, ranked };
    });
    const packStarted = performance.now();
    const packed = packBudgetedResponse({ query: fixture.query, contentMode: 'relevant_only', maxTokens: 6000, sources, envelope: { query: fixture.query } });
    const pack_ms = performance.now() - packStarted;
    const total_ms = performance.now() - started;
    const wire_tokens = countResponseTokens(packed.text);
    if (wire_tokens > 6000 || wire_tokens !== packed.payload.budget.used) throw new Error('Final wire budget verification failed');
    const signature = JSON.stringify(packed.payload.results);
    if (evidence !== undefined && signature !== evidence) throw new Error('Replay changed selected evidence');
    evidence = signature;
    samples.push({ parse_ms, rank_ms, pack_ms, total_ms, wire_tokens });
  }
  output.fixtures.push({ name: fixture.name, pages: fixture.pages.length, input_chars: fixture.pages.reduce((n, p) => n + p.raw.data.markdown.length, 0), stages: Object.fromEntries(['parse_ms', 'rank_ms', 'pack_ms', 'total_ms'].map(key => [key, stats(samples.map(s => s[key]))])), samples });
}
const text = JSON.stringify(output, null, 2);
if (options.has('--output')) fs.writeFileSync(options.get('--output'), text + '\n');
console.log(text);
