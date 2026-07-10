import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ScrapeClient } from '../src/scrape-client.js';

vi.mock('axios');

const mockedAxios = vi.mocked(axios);

describe('ScrapeClient.map', () => {
  let client: ScrapeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ScrapeClient('http://localhost:8001');
  });

  it('calls POST /v1/map with url and default options', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          links: ['https://example.com', 'https://example.com/about'],
          droppedActionCount: 1,
          strippedTrackingCount: 2,
        },
      },
    });

    const result = await client.map('https://example.com');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/map',
      {
        url: 'https://example.com',
        maxDepth: 2,
        useSitemap: true,
        crawlFallback: true,
      },
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(result.success).toBe(true);
    expect(result.data.links).toHaveLength(2);
    expect(result.data.droppedActionCount).toBe(1);
  });

  it('uses custom maxDepth and timeout from options', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, data: { links: [], droppedActionCount: 0, strippedTrackingCount: 0 } },
    });

    await client.map('https://example.com', { maxDepth: 5, timeout: 60 });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/map',
      expect.objectContaining({ maxDepth: 5 }),
      expect.objectContaining({ timeout: 60000 })
    );
  });

  it('returns error object on axios failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await client.map('https://example.com');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
    expect(result.data.links).toEqual([]);
  });

  it('handles CRW response without data.data wrapper', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        links: ['https://example.com/page1'],
      },
    });

    const result = await client.map('https://example.com');

    expect(result.data.links).toEqual(['https://example.com/page1']);
  });
});

describe('ScrapeClient.crawl', () => {
  let client: ScrapeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ScrapeClient('http://localhost:8001');
  });

  it('calls POST /v1/crawl and returns job ID', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        id: 'crawl-job-123',
      },
    });

    const result = await client.crawl('https://example.com');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/crawl',
      { url: 'https://example.com' },
      expect.any(Object)
    );
    expect(result.success).toBe(true);
    expect(result.id).toBe('crawl-job-123');
  });

  it('passes maxPages, maxDepth, and scrapeOptions', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, id: 'job-1', url: '...' },
    });

    await client.crawl('https://example.com', {
      maxPages: 5,
      maxDepth: 2,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/crawl',
      {
        url: 'https://example.com',
        maxPages: 5,
        maxDepth: 2,
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      },
      expect.any(Object)
    );
  });

  it('returns error on failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Timeout'));

    const result = await client.crawl('https://example.com');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Timeout');
  });
});

describe('ScrapeClient.crawlStatus', () => {
  let client: ScrapeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ScrapeClient('http://localhost:8001');
  });

  it('calls GET /v1/crawl/{id} and returns status', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'completed',
        total: 3,
        completed: 3,
        data: [
          {
            markdown: '# Page 1',
            metadata: {
              title: 'Page 1',
              description: null,
              sourceURL: 'https://example.com',
              language: 'en',
              statusCode: 200,
              renderedWith: 'http',
              elapsedMs: 15,
            },
          },
        ],
      },
    });

    const result = await client.crawlStatus('crawl-job-123');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://localhost:8001/v1/crawl/crawl-job-123',
      expect.any(Object)
    );
    expect(result.status).toBe('completed');
    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(1);
  });

  it('handles scraping status correctly', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'scraping',
        total: 10,
        completed: 4,
        data: [],
      },
    });

    const result = await client.crawlStatus('active-job');

    expect(result.status).toBe('scraping');
    expect(result.completed).toBe(4);
  });

  it('handles raw string response from CRW (non-JSON)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: 'Invalid URL: Cannot parse `id` with value `bad-uuid`: UUID parsing failed',
    });

    const result = await client.crawlStatus('bad-uuid');

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Invalid JSON response from CRW');
  });

  it('handles 400 status as failed crawl', async () => {
    const axiosError = new Error('Request failed with status code 400') as any;
    axiosError.response = { status: 400 };
    mockedAxios.get.mockRejectedValueOnce(axiosError);

    const result = await client.crawlStatus('nonexistent');

    expect(result.status).toBe('failed');
    expect(result.data).toEqual([]);
  });
});
