import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

import axios from 'axios';
import { SearXNGClient } from '../src/searxng-client.js';

describe('SearXNGClient image timeout', () => {
  afterEach(() => {
    vi.mocked(axios.get).mockReset();
  });

  it('uses the caller timeout for image search instead of the 10s default', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        query: 'saturn',
        number_of_results: 0,
        results: [],
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      },
    });

    const client = new SearXNGClient('http://searxng.test');
    await client.search('saturn planet', {
      engines: 'bing images,duckduckgo images',
      safesearch: 2,
      timeoutMs: 1800,
    });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('engines=bing+images%2Cduckduckgo+images'),
      expect.objectContaining({ timeout: 1800 }),
    );
    const url = String(vi.mocked(axios.get).mock.calls[0]?.[0]);
    expect(url).not.toContain('categories=');
  });
});
