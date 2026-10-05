import type { FourgetImageSearchResponse } from './fourget-client.js';
import type { SearXNGSearchResponse } from './searxng-client.js';
import {
  dedupeSearchImages,
  normalizeFourgetImage,
  normalizeSearxngImage,
  type SearchImage,
} from './image-normalize.js';

export const IMAGE_CACHE_PREFIX = 'images:v1';
export const DEFAULT_IMAGE_LIMIT = 6;
export const SAFE_IMAGE_ENGINES = 'bing images,duckduckgo images';

export type ImageSearchRoute = 'fourget' | 'fourget-partial' | 'searxng-fallback' | 'empty';

interface FourgetImageClient {
  searchImages(
    query: string,
    options?: { scraper?: string; nsfw?: string; timeoutMs?: number },
  ): Promise<FourgetImageSearchResponse>;
}

interface SearxngImageClient {
  search(
    query: string,
    options?: {
      categories?: string;
      engines?: string;
      language?: string;
      safesearch?: 0 | 1 | 2;
      timeoutMs?: number;
    },
  ): Promise<SearXNGSearchResponse>;
}

export interface SearchImagesOptions {
  query: string;
  fourget: FourgetImageClient;
  searxng: SearxngImageClient;
  maxResults?: number;
  minFourgetResults?: number;
  fourgetTimeoutMs?: number;
  fallbackTimeoutMs?: number;
  scraper?: string;
}

export interface SearchImagesResult {
  query: string;
  images: SearchImage[];
  route: ImageSearchRoute;
  fallbackReason?: string;
}

export interface ImageSearchCacheInput {
  query: string;
  nsfw: string;
  scraper: string;
  maxResults: number;
}

export function imageSearchCacheFields(input: ImageSearchCacheInput): readonly unknown[] {
  return [
    input.query.trim().toLowerCase(),
    `nsfw=${input.nsfw}`,
    input.scraper,
    input.maxResults,
  ];
}

function usableFourgetImages(raw: FourgetImageSearchResponse['image'] | undefined): SearchImage[] {
  return dedupeSearchImages((raw ?? []).map(normalizeFourgetImage).filter((image): image is SearchImage => Boolean(image)));
}

export async function searchImages(options: SearchImagesOptions): Promise<SearchImagesResult> {
  const maxResults = Math.min(Math.max(options.maxResults ?? DEFAULT_IMAGE_LIMIT, 1), DEFAULT_IMAGE_LIMIT);
  const minFourgetResults = options.minFourgetResults ?? maxResults;
  const scraper = options.scraper || 'ddg';
  const query = options.query;

  let fourgetImages: SearchImage[] = [];
  let fallbackReason = 'error';

  try {
    const fourgetResponse = await options.fourget.searchImages(query, {
      scraper,
      nsfw: 'no',
      timeoutMs: options.fourgetTimeoutMs ?? 2500,
    });
    fourgetImages = usableFourgetImages(fourgetResponse.image).slice(0, maxResults);

    if (fourgetResponse.status === 'ok' && fourgetImages.length >= minFourgetResults) {
      return {
        query,
        images: fourgetImages,
        route: 'fourget',
      };
    }

    fallbackReason = fourgetResponse.status === 'ok'
      ? `insufficient-results:${fourgetImages.length}`
      : 'status-error';
  } catch {
    fallbackReason = 'error';
  }

  const fallbackTimeoutMs = options.fallbackTimeoutMs ?? 1_800;

  try {
    const searxngResponse = await Promise.race([
      options.searxng.search(query, {
        engines: SAFE_IMAGE_ENGINES,
        language: 'en',
        safesearch: 2,
        timeoutMs: fallbackTimeoutMs,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('searxng-timeout')), fallbackTimeoutMs);
      }),
    ]);
    const searxngImages = dedupeSearchImages(
      (searxngResponse.results ?? [])
        .map(normalizeSearxngImage)
        .filter((image): image is SearchImage => Boolean(image)),
    );
    const merged = dedupeSearchImages([...fourgetImages, ...searxngImages]).slice(0, maxResults);

    if (merged.length === 0) {
      return { query, images: [], route: 'empty', fallbackReason };
    }

    return {
      query,
      images: merged,
      route: fourgetImages.length > 0 && searxngImages.length === 0 ? 'fourget-partial' : 'searxng-fallback',
      fallbackReason,
    };
  } catch {
    if (fourgetImages.length > 0) {
      return {
        query,
        images: fourgetImages.slice(0, maxResults),
        route: 'fourget-partial',
        fallbackReason: `${fallbackReason};searxng-error`,
      };
    }

    return { query, images: [], route: 'empty', fallbackReason: `${fallbackReason};searxng-error` };
  }
}
