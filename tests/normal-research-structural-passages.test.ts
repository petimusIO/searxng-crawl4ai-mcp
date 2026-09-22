import { describe, expect, it } from 'vitest';
import { SearXNGMCPServer } from '../src/index.js';

const STRUCTURAL_MARKDOWN = [
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
  '',
  'Then start the server.',
].join('\n');

function scrapeOk(markdown: string) {
  return {
    success: true,
    url: 'https://example.com/docs',
    data: {
      markdown,
      metadata: {
        title: 'Page title must not become a truth score',
        description: '',
        language: 'en',
        word_count: markdown.split(/\s+/).length,
      },
    },
  };
}

function createServer(scrape: () => Promise<unknown>) {
  const server = Object.create(SearXNGMCPServer.prototype) as any;
  server.cache = {
    get: async () => null,
    set: async () => {},
  };
  server.scrapeSingleUrl = async () => scrape();
  return server;
}

async function normalResearch(
  server: any,
  extras: { query?: string; contentMode?: string } = {},
) {
  const response = await server.handleNormalResearch(
    extras.query ?? 'fastify listen',
    'single',
    [{ url: 'https://example.com/docs', title: 'Docs', content: 'discovery snippet' }],
    extras.contentMode ?? 'relevant_only',
    undefined,
    1,
    [],
    Date.now(),
    'research:test',
    'fourget',
  );
  return JSON.parse(response.content[0].text);
}

function passageTexts(result: { results: Array<{ relevant_passages?: { passages?: Array<{ text: string }> } }> }) {
  return result.results[0].relevant_passages?.passages?.map((p) => p.text) ?? [];
}

describe('normal research structural passages', () => {
  it('uses the structural extractor so research passages keep heading plus complete fenced code', async () => {
    const server = createServer(async () => scrapeOk(STRUCTURAL_MARKDOWN));
    const result = await normalResearch(server);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
    const texts = passageTexts(result);
    expect(texts.some((text) => text.includes('```js\nconst app = fastify()\n\napp.listen()\n```'))).toBe(true);
    expect(texts.some((text) => text.includes('## Install Fastify') && text.includes('Then start the server.'))).toBe(true);
    expect(result.results[0].relevant_passages.query).toBe('fastify listen');
    expect(result.results[0].relevant_passages).toMatchObject({
      passages: expect.any(Array),
      total_passages: expect.any(Number),
      top_n: expect.any(Number),
    });
  });

  it('keeps compact and full content-mode shapes compatible', async () => {
    const server = createServer(async () => scrapeOk(STRUCTURAL_MARKDOWN));

    const full = await normalResearch(server, { contentMode: 'full' });
    const compact = await normalResearch(server, { contentMode: 'relevant_only' });
    const snippet = await normalResearch(server, { contentMode: 'snippet' });

    expect(full.results[0].data.markdown).toBe(STRUCTURAL_MARKDOWN);
    expect(compact.results[0].data.markdown).toBeUndefined();
    expect(snippet.results[0].data.markdown).toBeUndefined();

    for (const result of [full, compact, snippet]) {
      expect(result.results[0].relevant_passages.passages.length).toBeGreaterThan(0);
      expect(result.results[0].relevant_passages).toEqual(expect.objectContaining({
        query: 'fastify listen',
        passages: expect.any(Array),
        total_passages: expect.any(Number),
        top_n: expect.any(Number),
      }));
      expect(result.results[0].url).toBe('https://example.com/docs');
      expect(result.results[0].snippet).toBe('discovery snippet');
      expect(result.results[0].source_type).toBe('scraped');
    }

    const snippetHasContext = passageTexts(snippet).some((text) => text.includes('chairs and furniture'));
    expect(snippetHasContext).toBe(false);
  });
});
