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
