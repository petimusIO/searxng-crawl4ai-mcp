import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { FourgetClient } from '../src/fourget-client.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('FourgetClient', () => {
  let client: FourgetClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FourgetClient('http://fourget:80');
  });

  describe('search', () => {
    it('calls GET /api/v1/web with query and scraper', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'Test Result',
              url: 'https://example.com',
              description: [
                { type: 'text', value: 'A test description' },
              ],
              date: null,
              type: 'web',
            },
          ],
          npt: 'next-page-token',
        },
      });

      const result = await client.search('test query', 'brave');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://fourget:80/api/v1/web',
        expect.objectContaining({
          params: {
            s: 'test query',
            scraper: 'brave',
          },
        })
      );
      expect(result.status).toBe('ok');
      expect(result.web).toHaveLength(1);
      expect(result.web[0].title).toBe('Test Result');
      expect(result.web[0].url).toBe('https://example.com');
      expect(result.web[0].description).toBe('A test description');
    });

    it('uses default scraper "brave" when none provided', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { status: 'ok', web: [], npt: '' },
      });

      await client.search('query');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://fourget:80/api/v1/web',
        expect.objectContaining({
          params: { s: 'query', scraper: 'brave' },
        })
      );
    });

    it('flattens compound description arrays into plain text', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'Rich Result',
              url: 'https://example.com/2',
              description: [
                { type: 'text', value: 'Some text ' },
                { type: 'inline_code', value: 'SELECT 1' },
                { type: 'text', value: ' more text' },
                { type: 'quote', value: 'blockquote content' },
              ],
              date: 1747526400,
              type: 'web',
            },
          ],
          npt: '',
        },
      });

      const result = await client.search('rich');

      expect(result.web[0].description).toBe('Some text SELECT 1 more textblockquote content');
    });

    it('handles null/undefined description gracefully', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'No Description',
              url: 'https://example.com/3',
              description: null,
              date: null,
              type: 'web',
            },
          ],
          npt: '',
        },
      });

      const result = await client.search('nodesc');
      expect(result.web[0].description).toBe('');
    });

    it('converts Unix date to ISO string', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'Dated',
              url: 'https://example.com/4',
              description: [],
              date: 1747526400,
              type: 'web',
            },
          ],
          npt: '',
        },
      });

      const result = await client.search('dated');
      expect(result.web[0].date).toBe('2025-05-18T00:00:00.000Z');
    });

    it('handles API errors gracefully', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(client.search('fail')).rejects.toThrow('Connection refused');
    });
  });

  describe('healthCheck', () => {
    it('returns true when 4get responds', async () => {
      mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { status: 'ok' } });

      const healthy = await client.healthCheck();
      expect(healthy).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://fourget:80/api/v1/web',
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('returns false on timeout', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Timeout'));

      const healthy = await client.healthCheck();
      expect(healthy).toBe(false);
    });
  });
});
