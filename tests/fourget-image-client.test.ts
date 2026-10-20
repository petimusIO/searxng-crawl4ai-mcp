import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { FourgetClient } from '../src/fourget-client.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('FourgetClient.searchImages', () => {
  let client: FourgetClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FourgetClient('http://fourget:80');
  });

  it('calls GET /api/v1/images with ddg scraper and nsfw=no', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { status: 'ok', image: [] },
    });

    await client.searchImages('saturn planet');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://fourget:80/api/v1/images',
      expect.objectContaining({
        params: {
          s: 'saturn planet',
          scraper: 'ddg',
          nsfw: 'no',
        },
      }),
    );
  });

  it('never sends safesearch=2 to 4get image search', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { status: 'ok', image: [] },
    });

    await client.searchImages('saturn planet', { nsfw: 'yes' });

    const params = mockedAxios.get.mock.calls[0]?.[1]?.params as Record<string, unknown>;
    expect(params.nsfw).toBe('no');
    expect(params).not.toHaveProperty('safesearch');
  });

  it('returns the raw image array from 4get', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        status: 'ok',
        image: [
          {
            title: 'Saturn',
            url: 'https://nasa.gov/saturn',
            source: [{ url: 'https://cdn.nasa.gov/full.jpg', width: 10, height: 10 }],
          },
        ],
      },
    });

    const result = await client.searchImages('saturn');
    expect(result.status).toBe('ok');
    expect(result.image).toHaveLength(1);
    expect(result.image[0].title).toBe('Saturn');
  });
});
