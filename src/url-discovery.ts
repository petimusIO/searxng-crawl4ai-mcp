import type { FourgetSearchResponse } from './fourget-client.js';
import type { SearXNGSearchResponse } from './searxng-client.js';
import { mergeSearchResults, type UnifiedResult } from './search-merger.js';
import { normalizeUrl } from './url-normalizer.js';

export type DiscoveryRoute = 'fourget' | 'fourget-partial' | 'searxng-fallback' | 'searxng-required';

interface FourgetSearchClient {
  search(query: string, scraper?: string, timeoutMs?: number): Promise<FourgetSearchResponse>;
}

interface SearxngSearchClient {
  search(
    query: string,
    options?: {
      categories?: string;
      engines?: string;
      language?: string;
      pageno?: number;
      time_range?: string;
      format?: 'html' | 'json';
    },
  ): Promise<SearXNGSearchResponse>;
}

export interface DiscoverUrlsOptions {
  query: string;
  fourget: FourgetSearchClient;
  searxng: SearxngSearchClient;
  scraper: string;
  maxResults: number;
  minFourgetResults: number;
  fourgetTimeoutMs: number;
  categories?: string;
  engines?: string;
  language?: string;
}

export interface DiscoverUrlsResult {
  results: UnifiedResult[];
  route: DiscoveryRoute;
  fallbackReason?: string;
  numberOfResults: number;
  unresponsiveEngines: string[];
  sourcesConsulted: { fourget: boolean; searxng: boolean };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`4get timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.message.startsWith('4get timed out')) return true;
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { code?: unknown }).code);
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

function distinctUsableFourgetResults(
  results: FourgetSearchResponse['web'] | undefined,
): FourgetSearchResponse['web'] {
  const seen = new Set<string>();
  const usable: FourgetSearchResponse['web'] = [];

  for (const result of results ?? []) {
    const title = result.title?.trim();
    const url = result.url?.trim();
    if (!title || !url) continue;

    let normalized: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      parsed.hash = '';
      normalized = normalizeUrl(parsed.toString());
    } catch {
      continue;
    }

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    usable.push({ ...result, title, url });
  }

  return usable;
}

export async function discoverUrls(options: DiscoverUrlsOptions): Promise<DiscoverUrlsResult> {
  let fourgetResults: FourgetSearchResponse['web'] = [];
  let fallbackReason: string;

  const useSearxng = async (
    route: 'searxng-fallback' | 'searxng-required',
    reason: string,
  ): Promise<DiscoverUrlsResult> => {
    try {
      const response = await options.searxng.search(options.query, {
        categories: options.categories,
        engines: options.engines,
        language: options.language || 'en',
        pageno: 1,
        format: 'json',
      });
      const results = (response.results || []).filter((result) => result.title && result.url);

      return {
        results: mergeSearchResults(results, fourgetResults, { maxResults: options.maxResults }),
        route,
        fallbackReason: reason,
        numberOfResults: response.number_of_results ?? results.length,
        unresponsiveEngines: response.unresponsive_engines || [],
        sourcesConsulted: { fourget: route !== 'searxng-required', searxng: true },
      };
    } catch {
      if (route !== 'searxng-fallback' || fourgetResults.length === 0) {
        throw new Error('searxng-error');
      }

      return {
        results: mergeSearchResults([], fourgetResults, { maxResults: options.maxResults }),
        route: 'fourget-partial',
        fallbackReason: `${reason};searxng-error`,
        numberOfResults: fourgetResults.length,
        unresponsiveEngines: [],
        sourcesConsulted: { fourget: true, searxng: true },
      };
    }
  };

  const categories = (options.categories || '')
    .split(',')
    .map((category) => category.trim())
    .filter(Boolean);
  if (categories.some((category) => category !== 'general')) {
    return useSearxng('searxng-required', 'required-options:categories');
  }
  if (options.engines?.trim()) {
    return useSearxng('searxng-required', 'required-options:engines');
  }
  if (options.language && !/^en(?:-|$)/i.test(options.language.trim())) {
    return useSearxng('searxng-required', 'required-options:language');
  }

  try {
    const fourgetResponse = await withTimeout(
      options.fourget.search(options.query, options.scraper, options.fourgetTimeoutMs),
      options.fourgetTimeoutMs,
    );
    fourgetResults = distinctUsableFourgetResults(fourgetResponse.web);

    if (fourgetResponse.status === 'ok' && fourgetResults.length >= options.minFourgetResults) {
      return {
        results: mergeSearchResults([], fourgetResults, { maxResults: options.maxResults }),
        route: 'fourget',
        numberOfResults: fourgetResults.length,
        unresponsiveEngines: [],
        sourcesConsulted: { fourget: true, searxng: false },
      };
    }

    fallbackReason = fourgetResponse.status === 'ok'
      ? `insufficient-results:${fourgetResults.length}`
      : 'status-error';
  } catch (error) {
    fallbackReason = isTimeoutError(error) ? 'timeout' : 'error';
  }

  return useSearxng('searxng-fallback', fallbackReason);
}
