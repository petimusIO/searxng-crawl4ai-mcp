import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ScrapeClient, scrapeProvenance } from '../src/scrape-client.js';
import {
  parseDocumentSections,
  rankDocumentSections,
} from '../src/passage-extractor.js';
import { packBudgetedResponse } from '../src/response-packer.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('scrape provenance: client mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries statusCode/renderedWith/elapsedMs into metadata', async () => {
    const client = new ScrapeClient('http://localhost:8001');
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          markdown: '# Page',
          metadata: {
            title: 'T',
            description: null,
            language: 'en',
            statusCode: 200,
            renderedWith: 'browser',
            elapsedMs: 1234,
          },
        },
      },
    });

    const result = await client.scrape('https://example.com');

    expect(result.data?.metadata.status_code).toBe(200);
    expect(result.data?.metadata.rendered_with).toBe('browser');
    expect(result.data?.metadata.elapsed_ms).toBe(1234);
  });

  it('omits provenance fields when CRW does not send them', async () => {
    const client = new ScrapeClient('http://localhost:8001');
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, data: { markdown: '# Page', metadata: { title: 'T' } } },
    });

    const result = await client.scrape('https://example.com');

    expect(result.data?.metadata).not.toHaveProperty('status_code');
    expect(result.data?.metadata).not.toHaveProperty('rendered_with');
    expect(result.data?.metadata).not.toHaveProperty('elapsed_ms');
  });
});

describe('scrapeProvenance', () => {
  it('returns undefined when no data or no fields were recorded', () => {
    expect(scrapeProvenance({ success: true, url: 'https://x.test' })).toBeUndefined();
    expect(scrapeProvenance({
      success: true,
      url: 'https://x.test',
      data: {
        markdown: 'x',
        metadata: { title: '', description: '', language: '', word_count: 0 },
      },
    })).toBeUndefined();
  });

  it('passes through only the present fields', () => {
    const provenance = scrapeProvenance({
      success: true,
      url: 'https://x.test',
      data: {
        markdown: 'x',
        metadata: {
          title: '',
          description: '',
          language: '',
          word_count: 1,
          status_code: 404,
          elapsed_ms: 87,
        },
      },
    });

    expect(provenance).toEqual({ status_code: 404, elapsed_ms: 87 });
  });
});

describe('packer surfaces fetch provenance', () => {
  function source(url: string, extras: Record<string, unknown> = {}) {
    const markdown = '## Install Fastify\n\nRun npm install fastify to get started quickly.';
    const sections = parseDocumentSections(markdown);
    return {
      url,
      title: url,
      snippet: 'discovery snippet',
      success: true,
      source_type: 'scraped' as const,
      document_id: `doc-${url}`,
      data: { markdown, metadata: { title: url, word_count: 9 } },
      markdown,
      sections,
      ranked: rankDocumentSections(sections, 'fastify'),
      ...extras,
    };
  }

  function pack(sources: ReturnType<typeof source>[]) {
    return packBudgetedResponse({
      query: 'fastify',
      contentMode: 'relevant_only',
      maxTokens: 6000,
      sources,
      envelope: { query: 'fastify' },
    });
  }

  it('includes the fetch block when present', () => {
    const packed = pack([
      source('https://a.test', { fetch: { status_code: 200, rendered_with: 'http', elapsed_ms: 42 } }),
    ]);
    const body = JSON.parse(packed.text);

    expect(body.results[0].fetch).toEqual({ status_code: 200, rendered_with: 'http', elapsed_ms: 42 });
  });

  it('omits the fetch block when absent', () => {
    const packed = pack([source('https://a.test')]);
    const body = JSON.parse(packed.text);

    expect(body.results[0]).not.toHaveProperty('fetch');
  });
});
