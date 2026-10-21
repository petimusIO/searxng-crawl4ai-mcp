import { describe, expect, it } from 'vitest';
import { WebFetchTool } from '../src/tools/webfetch.js';

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
  const server = Object.create(WebFetchTool.prototype) as any;
  server.cache = {
    get: async () => null,
    set: async () => {},
  };
  server.getScrapeClient = () => ({ scrape });
  return server;
}

async function normalResearch(
  server: any,
  extras: { query?: string; contentMode?: string } = {},
) {
  const response = await server.handle({ url: 'https://example.com/docs', query: extras.query ?? 'fastify listen', content_mode: extras.contentMode ?? 'relevant_only' });
  return JSON.parse(response.content[0].text);
}

function passageTexts(result: { relevant_passages?: { passages?: Array<{ text: string }> } }) {
  return result.relevant_passages?.passages?.map((p) => p.text) ?? [];
}

describe('webfetch structural passages', () => {
  it('uses the structural extractor so fetched passages keep heading plus complete fenced code', async () => {
    const server = createServer(async () => scrapeOk(STRUCTURAL_MARKDOWN));
    const result = await normalResearch(server);

    expect(result.success).toBe(true);
    const texts = passageTexts(result);
    expect(texts.some((text) => text.includes('```js\nconst app = fastify()\n\napp.listen()\n```'))).toBe(true);
    expect(texts.some((text) => text.includes('## Install Fastify') && text.includes('Then start the server.'))).toBe(true);
    expect(result.relevant_passages.query).toBe('fastify listen');
    expect(result.relevant_passages).toMatchObject({
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

    expect(full.data.markdown).toBe(STRUCTURAL_MARKDOWN);
    expect(compact.data.markdown).toBeUndefined();
    expect(snippet.data.markdown).toBeUndefined();

    for (const result of [full, compact, snippet]) {
      expect(result.relevant_passages.passages.length).toBeGreaterThan(0);
      expect(result.relevant_passages).toEqual(expect.objectContaining({
        query: 'fastify listen',
        passages: expect.any(Array),
        total_passages: expect.any(Number),
        top_n: expect.any(Number),
      }));
      expect(result.url).toBe('https://example.com/docs');
    }

    const snippetHasContext = passageTexts(snippet).some((text) => text.includes('chairs and furniture'));
    expect(snippetHasContext).toBe(false);
  });
});
