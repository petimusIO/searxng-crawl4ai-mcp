import { cachedTiming, timedAsync, timedSync, responseTimingStatus } from '../search-timing.js';
import { logger } from '../logger.js';
import { SearXNGClient } from '../searxng-client.js';
import { FourgetClient, DEFAULT_FOURGET_NEWS_SCRAPER, DEFAULT_FOURGET_SCRAPER } from '../fourget-client.js';
import { RedisCache } from '../redis-cache.js';
import { discoverUrls as discover, isFourgetNewsRoute } from '../url-discovery.js';
import { buildCacheKey } from '../cache-key.js';
import { DEFAULT_IMAGE_LIMIT, IMAGE_CACHE_PREFIX, imageSearchCacheFields, searchImages } from '../image-search.js';
import { mcpJson } from '../tool-response.js';
import { attachResponseBudget, compactUntrustedText, countResponseTokens, validateMaxTokens } from '../token-budget.js';
import { resolveErrorBudget } from '../budget-args.js';
const DEFAULT_LIMIT = Number(process.env.WEB_SEARCH_LIMIT) || 25;
const SEARCH_CACHE_TTL_MS = Number(process.env.MCP_SEARCH_CACHE_TTL_MS) || 300_000;
const FOURGET_PRIMARY_TIMEOUT_MS = Number(process.env.MCP_FOURGET_PRIMARY_TIMEOUT_MS) || 1500;
const FOURGET_MIN_RESULTS = Number(process.env.MCP_FOURGET_MIN_RESULTS) || 5;
const discoverUrls: typeof discover = options => timedAsync('mcp.discovery', () => discover(options), undefined, true);

export class WebSearchTool {
  constructor(private searxng: SearXNGClient, private fourget: FourgetClient, private cache: RedisCache) {}
  async handle(args: any) {
    const parsed = timedSync('mcp.validation', () => validateMaxTokens(args?.max_tokens), false, result => result.ok ? 'success' : 'validation_error');
    if (!parsed.ok || typeof args?.query !== 'string' || !args.query.trim()) return mcpJson({ error: 'invalid_arguments', message: !parsed.ok ? parsed.error : 'query must be a nonempty string' }, resolveErrorBudget(args));
    args = { ...args, max_tokens: parsed.max_tokens };
    if (args?.categories === 'images') return timedAsync('mcp.images.total', () => this.handleSearchImages(args), responseTimingStatus, true);
    const { query, maxResults, categories, engines, language } = args;
    const news = isFourgetNewsRoute({ categories, engines, language });
    const scraper = args.scraper || (news ? DEFAULT_FOURGET_NEWS_SCRAPER : DEFAULT_FOURGET_SCRAPER);

    logger.info(`Searching web (4get primary): ${query}`);

    const limit = Math.min(maxResults || DEFAULT_LIMIT, 50);

    // Check cache — include scraper and result limit in key
    const cacheKey = buildCacheKey('websearch:v1', [
      query,
      categories || '',
      engines || '',
      language || 'en',
      scraper,
      limit,
      args.max_tokens,
      ...(news ? ['fourget-news:v1', scraper] : []),
    ]);
    const cached = await timedAsync('mcp.cache.get', () => this.cache.get(cacheKey), value => value ? 'hit' : 'miss', true);
    if (cached) {
      cachedTiming(['mcp.discovery', 'mcp.provider.fourget', 'mcp.provider.searxng', 'mcp.serialization', 'mcp.cache.set']);
      return cached;
    }

    const discovery = await discoverUrls({
      query,
      fourget: this.fourget,
      searxng: this.searxng,
      scraper,
      maxResults: limit,
      minFourgetResults: FOURGET_MIN_RESULTS,
      fourgetTimeoutMs: FOURGET_PRIMARY_TIMEOUT_MS,
      categories,
      engines,
      language: language || 'en',
    });

    logger.info('URL discovery completed', {
      query,
      route: discovery.route,
      fallbackReason: discovery.fallbackReason,
      resultCount: discovery.results.length,
    });

    const response = this.packResults({
      query,
      total_results: discovery.results.length,
      results: discovery.results.map(result => ({ title: result.title, url: result.url, content: result.content, publishedDate: result.publishedDate, source: result.source })),
      engine_info: { route: discovery.route, fallback_reason: discovery.fallbackReason, sources_consulted: discovery.sourcesConsulted },
    }, args.max_tokens);

    await timedAsync('mcp.cache.set', () => this.cache.set(cacheKey, response, SEARCH_CACHE_TTL_MS), undefined, true);
    return response;
  }

  /**
   * Image search via 4get DDG primary with SearXNG image fallback.
   * Separate from text URL discovery. Never crawls image binaries.
   */
  private async handleSearchImages(args: any) {
    const query = String(args?.query || '').trim();
    const scraper = args.scraper || DEFAULT_FOURGET_SCRAPER;
    const maxResults = Math.min(Number(args?.maxResults) || DEFAULT_IMAGE_LIMIT, DEFAULT_IMAGE_LIMIT);

    const cacheKey = buildCacheKey(IMAGE_CACHE_PREFIX, imageSearchCacheFields({
      query,
      nsfw: 'no',
      scraper,
      maxResults,
    }).concat([String(args.max_tokens)]));
    const cached = await timedAsync('mcp.cache.get', () => this.cache.get(cacheKey), value => value ? 'hit' : 'miss', true);
    if (cached) {
      cachedTiming(['mcp.images.primary', 'mcp.images.fallback', 'mcp.images.normalize', 'mcp.pack', 'mcp.serialization', 'mcp.cache.set']);
      return cached;
    }

    const discovery = await searchImages({
      query,
      fourget: this.fourget,
      searxng: this.searxng,
      maxResults,
      scraper,
      fourgetTimeoutMs: 1_500,
      fallbackTimeoutMs: 1_500,
    });

    const response = this.packResults({
      query,
      total_results: discovery.images.length,
      images: discovery.images,
      engine_info: {
        route: discovery.route,
        fallback_reason: discovery.fallbackReason,
      },
    }, args.max_tokens);

    await timedAsync('mcp.cache.set', () => this.cache.set(cacheKey, response, SEARCH_CACHE_TTL_MS), undefined, true);
    return response;
  }

  private packResults(payload: { query: string; results?: unknown[]; images?: unknown[]; [key: string]: unknown }, maxTokens: number) {
    return timedSync('mcp.pack', () => {
      const safe = { ...payload, query: compactUntrustedText(payload.query) };
      const entries = [...(safe.results ?? safe.images ?? [])];
      const discoveredCount = entries.length;
      if (safe.results) safe.results = entries; else safe.images = entries;
      const counted = () => ({
        ...safe,
        total_results: entries.length,
        ...(entries.length < discoveredCount ? { omitted_results: discoveredCount - entries.length } : {}),
      });
      while (entries.length > 0 && countResponseTokens(JSON.stringify(attachResponseBudget(counted(), maxTokens), null, 2)) > maxTokens) entries.pop();
      return mcpJson(counted(), maxTokens);
    }, true);
  }
}
