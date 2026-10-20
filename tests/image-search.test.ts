import { describe, expect, it, vi } from 'vitest';
import { SAFE_IMAGE_ENGINES, searchImages } from '../src/image-search.js';

function fourgetImage(index: number) {
  return {
    title: `4get image ${index}`,
    url: `https://fourget.example/page/${index}`,
    source: [
      { url: `https://cdn.fourget.example/full-${index}.jpg`, width: 800, height: 600 },
      { url: `https://cdn.fourget.example/thumb-${index}.jpg`, width: 120, height: 90 },
    ],
  };
}

function searxngImage(index: number) {
  return {
    title: `SearXNG image ${index}`,
    url: `https://searxng.example/page/${index}`,
    img_src: `https://cdn.searxng.example/full-${index}.jpg`,
    thumbnail_src: `https://cdn.searxng.example/thumb-${index}.jpg`,
    engine: 'bing images',
  };
}

describe('searchImages', () => {
  it('returns 4get results without calling SearXNG when enough images arrive', async () => {
    const fourget = {
      searchImages: vi.fn().mockResolvedValue({
        status: 'ok',
        image: [0, 1, 2, 3, 4, 5].map(fourgetImage),
      }),
    };
    const searxng = { search: vi.fn() };

    const result = await searchImages({
      query: 'saturn planet',
      fourget,
      searxng,
      maxResults: 6,
    });

    expect(result.route).toBe('fourget');
    expect(result.images).toHaveLength(6);
    expect(result.images[0].engine).toBe('fourget');
    expect(searxng.search).not.toHaveBeenCalled();
    expect(fourget.searchImages).toHaveBeenCalledWith(
      'saturn planet',
      expect.objectContaining({ nsfw: 'no', scraper: 'ddg' }),
    );
  });

  it('falls back to SearXNG image search with safesearch=2 and photo engines', async () => {
    const fourget = {
      searchImages: vi.fn().mockResolvedValue({ status: 'ok', image: [] }),
    };
    const searxng = {
      search: vi.fn().mockResolvedValue({
        query: 'saturn planet',
        number_of_results: 3,
        results: [0, 1, 2].map(searxngImage),
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
    };

    const result = await searchImages({
      query: 'saturn planet',
      fourget,
      searxng,
      maxResults: 6,
    });

    expect(result.route).toBe('searxng-fallback');
    expect(result.images).toHaveLength(3);
    expect(searxng.search).toHaveBeenCalledWith('saturn planet', expect.objectContaining({
      safesearch: 2,
      engines: SAFE_IMAGE_ENGINES,
      timeoutMs: expect.any(Number),
    }));
    const args = searxng.search.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('categories');
    expect(SAFE_IMAGE_ENGINES).toBe('bing images,duckduckgo images');
    expect(SAFE_IMAGE_ENGINES).not.toMatch(/wikicommons|anime|danbooru|iconfinder|deviantart|artic|lucide|pinterest/i);
  });

  it('keeps completed 4get images when the SearXNG fallback times out', async () => {
    const fourget = {
      searchImages: vi.fn().mockResolvedValue({
        status: 'ok',
        image: [fourgetImage(0), fourgetImage(1)],
      }),
    };
    const searxng = {
      search: vi.fn().mockImplementation(
        () => new Promise(() => {}),
      ),
    };

    const started = Date.now();
    const result = await searchImages({
      query: 'saturn planet',
      fourget,
      searxng,
      maxResults: 6,
      minFourgetResults: 6,
      fallbackTimeoutMs: 40,
    });

    expect(result.route).toBe('fourget-partial');
    expect(result.images).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps valid 4get images when SearXNG fallback fails', async () => {
    const fourget = {
      searchImages: vi.fn().mockResolvedValue({
        status: 'ok',
        image: [fourgetImage(0), fourgetImage(1)],
      }),
    };
    const searxng = {
      search: vi.fn().mockRejectedValue(new Error('searxng down')),
    };

    const result = await searchImages({
      query: 'saturn planet',
      fourget,
      searxng,
      maxResults: 6,
      minFourgetResults: 6,
    });

    expect(result.route).toBe('fourget-partial');
    expect(result.images).toHaveLength(2);
    expect(result.images.every((image) => image.engine === 'fourget')).toBe(true);
  });

  it('returns an empty set when both providers fail', async () => {
    const fourget = {
      searchImages: vi.fn().mockRejectedValue(new Error('4get down')),
    };
    const searxng = {
      search: vi.fn().mockRejectedValue(new Error('searxng down')),
    };

    const result = await searchImages({
      query: 'saturn planet',
      fourget,
      searxng,
      maxResults: 6,
    });

    expect(result.images).toEqual([]);
    expect(result.route).toBe('empty');
  });

  it('caps results and does not crawl image binaries', async () => {
    const fourget = {
      searchImages: vi.fn().mockResolvedValue({
        status: 'ok',
        image: Array.from({ length: 20 }, (_, index) => fourgetImage(index)),
      }),
    };
    const searxng = { search: vi.fn() };

    const result = await searchImages({
      query: 'saturn planet',
      fourget,
      searxng,
      maxResults: 6,
    });

    expect(result.images).toHaveLength(6);
    expect(result.images.every((image) => image.imageUrl.endsWith('.jpg'))).toBe(true);
  });
});
