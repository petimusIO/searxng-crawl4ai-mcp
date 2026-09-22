import { describe, expect, it, vi } from 'vitest';
import { discoverUrls } from '../src/url-discovery.js';

function fourgetResults(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    title: `4get result ${index}`,
    url: `https://fourget.example/${index}`,
    description: `snippet ${index}`,
    date: null,
    type: 'web',
  }));
}

function searxngResults(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    title: `SearXNG result ${index}`,
    url: `https://searxng.example/${index}`,
    content: `snippet ${index}`,
  }));
}

describe('discoverUrls', () => {
  it('returns valid 4get results without calling SearXNG', async () => {
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: fourgetResults(10),
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'test',
        number_of_results: 10,
        results: searxngResults(10),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'test query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('fourget');
    expect(result.results).toHaveLength(10);
    expect(result.results.every((item) => item.source === 'fourget')).toBe(true);
    expect(result.sourcesConsulted).toEqual({ fourget: true, searxng: false });
    expect(searxng.search).not.toHaveBeenCalled();
  });

  it('falls back to SearXNG when 4get returns too few valid results', async () => {
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: [],
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'test query',
        number_of_results: 10,
        results: searxngResults(10),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [['brave', 'rate limited']],
      }),
    };

    const result = await discoverUrls({
      query: 'test query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
      categories: 'general',
      language: 'en',
    });

    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('insufficient-results:0');
    expect(result.results).toHaveLength(10);
    expect(result.results.every((item: { source: string }) => item.source === 'searxng')).toBe(true);
    expect(result.sourcesConsulted).toEqual({ fourget: true, searxng: true });
    expect(searxng.search).toHaveBeenCalledWith('test query', {
      categories: 'general',
      engines: undefined,
      language: 'en',
      pageno: 1,
      format: 'json',
    });
  });

  it('falls back to SearXNG when 4get throws', async () => {
    const fourget = {
      search: vi.fn().mockRejectedValue(new Error('network blocked')),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'test query',
        number_of_results: 6,
        results: searxngResults(6),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'test query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('error');
    expect(result.results).toHaveLength(6);
    expect(searxng.search).toHaveBeenCalledOnce();
  });

  it('uses SearXNG directly when category-specific results are requested', async () => {
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: fourgetResults(10),
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'latest news',
        number_of_results: 8,
        results: searxngResults(8),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'latest news',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
      categories: 'news',
      language: 'en',
    });

    expect(result.route).toBe('searxng-required');
    expect(result.fallbackReason).toBe('required-options:categories');
    expect(result.sourcesConsulted).toEqual({ fourget: false, searxng: true });
    expect(fourget.search).not.toHaveBeenCalled();
    expect(searxng.search).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'specific SearXNG engines', extra: { engines: 'bing' }, reason: 'engines' },
    { label: 'a non-English language', extra: { language: 'fr' }, reason: 'language' },
  ])('uses SearXNG directly when $label are requested', async ({ extra, reason }) => {
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: fourgetResults(10),
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'filtered query',
        number_of_results: 8,
        results: searxngResults(8),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'filtered query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
      ...extra,
    });

    expect(result.route).toBe('searxng-required');
    expect(result.fallbackReason).toBe(`required-options:${reason}`);
    expect(result.sourcesConsulted).toEqual({ fourget: false, searxng: true });
    expect(fourget.search).not.toHaveBeenCalled();
    expect(searxng.search).toHaveBeenCalledOnce();
  });

  it('falls back when 4get lacks five distinct valid HTTP URLs', async () => {
    const duplicate = fourgetResults(1)[0];
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: [
          duplicate,
          duplicate,
          duplicate,
          duplicate,
          duplicate,
          { ...duplicate, title: '   ', url: 'https://example.com/blank-title' },
          { ...duplicate, title: 'Bad scheme', url: 'javascript:alert(1)' },
          { ...duplicate, title: 'Malformed', url: 'not a url' },
        ],
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'duplicate query',
        number_of_results: 6,
        results: searxngResults(6),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'duplicate query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('insufficient-results:1');
    expect(result.results).toHaveLength(7);
    expect(searxng.search).toHaveBeenCalledOnce();
  });

  it('returns partial 4get results when the SearXNG fallback fails', async () => {
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: fourgetResults(3),
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockRejectedValue(new Error('internal searxng endpoint failed')),
    };

    const result = await discoverUrls({
      query: 'partial query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('fourget-partial');
    expect(result.fallbackReason).toBe('insufficient-results:3;searxng-error');
    expect(result.results).toHaveLength(3);
    expect(result.results.every((item) => item.source === 'fourget')).toBe(true);
    expect(result.sourcesConsulted).toEqual({ fourget: true, searxng: true });
  });

  it('uses a stable reason code for non-ok 4get status text', async () => {
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'internal endpoint at http://fourget:80 failed',
        web: [],
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'status query',
        number_of_results: 6,
        results: searxngResults(6),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'status query',
      fourget,
      searxng,
      scraper: 'google',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('status-error');
    expect(result.fallbackReason).not.toContain('fourget:80');
  });

  it('sanitizes a total SearXNG failure on a required route', async () => {
    const fourget = {
      search: vi.fn(),
    };
    const searxng = {
      search: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED http://searxng:8080')),
    };

    await expect(discoverUrls({
      query: 'news query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
      categories: 'news',
    })).rejects.toThrow('searxng-error');

    expect(fourget.search).not.toHaveBeenCalled();
  });

  it('keeps original discovery URLs instead of rewritten cache keys', async () => {
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: [
          {
            title: 'PostgreSQL SSI',
            url: 'https://wiki.postgresql.org/wiki/SSI',
            description: 'Serializable Snapshot Isolation',
            date: null,
            type: 'web',
          },
          ...fourgetResults(9).map((result, index) => ({
            ...result,
            url: `https://fourget.example/keep/${index}`,
          })),
        ],
        answer: [],
        npt: '',
      }),
    };
    const searxng = { search: vi.fn() };

    const result = await discoverUrls({
      query: 'postgresql ssi',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('fourget');
    expect(result.results[0].url).toBe('https://wiki.postgresql.org/wiki/SSI');
    expect(searxng.search).not.toHaveBeenCalled();
  });

  it('treats fragment variants as one URL for the quality gate', async () => {
    const base = fourgetResults(1)[0];
    const fourget = {
      search: vi.fn().mockResolvedValue({
        status: 'ok',
        web: Array.from({ length: 5 }, (_, index) => ({
          ...base,
          url: `https://fourget.example/resource#section-${index}`,
        })),
        answer: [],
        npt: '',
      }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'fragment query',
        number_of_results: 6,
        results: searxngResults(6),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'fragment query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('insufficient-results:1');
  });

  it('classifies Axios timeout codes as timeout fallback', async () => {
    const timeoutError = Object.assign(new Error('timeout of 50ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const fourget = {
      search: vi.fn().mockRejectedValue(timeoutError),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'timeout query',
        number_of_results: 6,
        results: searxngResults(6),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await discoverUrls({
      query: 'timeout query',
      fourget,
      searxng,
      scraper: 'ddg',
      maxResults: 10,
      minFourgetResults: 5,
      fourgetTimeoutMs: 50,
    });

    expect(result.route).toBe('searxng-fallback');
    expect(result.fallbackReason).toBe('timeout');
  });
});
