import { errorTimingStatus, skipTiming, timedAsync, timedFunction, timedSync, withSourceTiming } from '../search-timing.js';
import { logger } from '../logger.js';
import { ScrapeClient, ScrapeClientResponse, scrapeProvenance, scrapeOutcome, scrapeCacheEligible, type ScrapeOptions, type FetchProvenance } from '../scrape-client.js';
import { RedisCache } from '../redis-cache.js';
import { normalizeUrl } from '../url-normalizer.js';
import { parseDocumentSections as parseSections, rankDocumentSections as rankSections } from '../passage-extractor.js';
import type { ContentMode } from '../content-utils.js';
import { resolveErrorBudget, validateScrapeArgs } from '../budget-args.js';
import { DocumentStore } from '../document-store.js';
import { flattenPackedSource as flatten, packBudgetedResponse as packResponse, packSectionIndex as packIndex } from '../response-packer.js';
import { boundUpstreamError } from '../token-budget.js';
import { mcpJson } from '../tool-response.js';
const parseDocumentSections = timedFunction('mcp.parse', parseSections);
const rankDocumentSections = timedFunction('mcp.rank', rankSections);
const packBudgetedResponse = timedFunction('mcp.pack', packResponse, true);
const flattenPackedSource = timedFunction('mcp.pack', flatten, true);
const packSectionIndex = timedFunction('mcp.pack', packIndex, true);
const URL_SCRAPE_CACHE_TTL_MS = Number(process.env.MCP_URL_SCRAPE_CACHE_TTL_MS) || 86_400_000;
const configuredWebFetchTimeout = Number(process.env.MCP_WEBFETCH_TIMEOUT_MS);
export const DEFAULT_WEBFETCH_TIMEOUT_MS = Number.isSafeInteger(configuredWebFetchTimeout) && configuredWebFetchTimeout > 0
  ? configuredWebFetchTimeout
  : 3000;
function scrapeTimingStatus(result: ScrapeClientResponse) {
  if (!result.success) return errorTimingStatus({ message: result.error });
  const outcome = scrapeOutcome(result);
  return outcome === 'degraded' ? 'partial' : outcome === 'success' ? 'success' : 'error';
}
export class WebFetchTool {
  private _scrapeClient?: ScrapeClient;
  private documentStore?: DocumentStore;
  constructor(private cache: RedisCache) {}
  async healthCheck() { return this.getScrapeClient().healthCheck(); }

  private getDocumentStore(): DocumentStore {
    if (!this.documentStore) this.documentStore = new DocumentStore();
    return this.documentStore;
  }

  private canonicalSourceData(retained: { markdown: string; title: string }) {
    const trimmed = retained.markdown.trim();
    return {
      markdown: retained.markdown,
      metadata: {
        title: retained.title,
        word_count: trimmed ? trimmed.split(/\s+/).length : 0,
      },
    };
  }

  private retainDocument(url: string, title: string, markdown: string, fetch?: FetchProvenance, reuseByUrl = true) {
    const sections = parseDocumentSections(markdown);
    const saved = timedSync('mcp.document.save', () => this.getDocumentStore().save({ url, title, markdown, sections, fetch, reuseByUrl }));
    if (!saved.ok) {
      return {
        url,
        title,
        markdown,
        sections,
        document_id: undefined,
        read_more_unavailable: true as const,
      };
    }
    return {
      url: saved.document.url,
      title: saved.document.title,
      markdown: saved.document.markdown,
      sections: saved.document.sections,
      document_id: saved.document.document_id,
      saved_at: saved.document.saved_at,
      expires_at: saved.document.expires_at,
      read_more_unavailable: false as const,
    };
  }

  private packSavedDocument(
    document: {
      document_id: string;
      url: string;
      title: string;
      markdown: string;
      sections: ReturnType<typeof parseDocumentSections>;
      saved_at?: number;
      expires_at?: number;
      fetch?: FetchProvenance;
    },
    request: { query?: string; section_ids?: string[]; list_sections: boolean; section_offset?: number; max_tokens: number; content_mode: ContentMode },
  ) {
    if (request.list_sections) {
      const offset = request.section_offset ?? 0;
      if (offset >= document.sections.length) {
        return mcpJson({
          error: 'invalid_arguments',
          message: 'section_offset is beyond the section list',
        }, request.max_tokens);
      }
      const packed = packSectionIndex({
        url: document.url,
        title: document.title,
        document_id: document.document_id,
        sections: document.sections,
        sectionOffset: offset,
        maxTokens: request.max_tokens,
      });
      return { content: [{ type: 'text', text: packed.text }] };
    }

    if (request.section_ids) {
      const unknown = request.section_ids.filter((id) => !document.sections.some((section) => section.id === id));
      if (unknown.length > 0) {
        return mcpJson({
          error: 'invalid_arguments',
          message: 'unknown section_ids',
          unknown,
        }, request.max_tokens);
      }
    }

    const query = request.query ?? '';
    const packed = flattenPackedSource(packBudgetedResponse({
      query,
      contentMode: request.content_mode,
      maxTokens: request.max_tokens,
      sources: [{
        url: document.url,
        title: document.title,
        success: true,
        fetch: document.fetch,
        document_id: document.document_id,
        saved_at: document.saved_at,
        expires_at: document.expires_at,
        data: this.canonicalSourceData(document),
        markdown: document.markdown,
        sections: document.sections,
        ranked: rankDocumentSections(document.sections, query),
      }],
      envelope: { url: document.url, success: true },
      requestedSectionIds: request.section_ids,
      deferFinalize: true,
    }), request.max_tokens, request.section_ids);
    return { content: [{ type: 'text', text: packed.text }] };
  }

  private packScrapedDocument(
    result: ScrapeClientResponse,
    retained: ReturnType<WebFetchTool['retainDocument']>,
    request: { query?: string; max_tokens: number; content_mode: ContentMode },
  ) {
    const query = request.query ?? '';
    const packed = flattenPackedSource(packBudgetedResponse({
      query,
      contentMode: request.content_mode,
      maxTokens: request.max_tokens,
      sources: [{
        url: retained.url,
        title: retained.title,
        success: Boolean(result.success && retained.markdown.trim()),
        error: result.success ? undefined : result.error,
        fetch: scrapeProvenance(result),
        document_id: retained.document_id,
        read_more_unavailable: retained.read_more_unavailable,
        saved_at: retained.saved_at,
        expires_at: retained.expires_at,
        data: this.canonicalSourceData(retained),
        markdown: retained.markdown,
        sections: retained.sections,
        ranked: rankDocumentSections(retained.sections, query),
      }],
      envelope: {
        success: result.success,
        url: result.url,
        ...(result.error ? { error: result.error } : {}),
      },
    }), request.max_tokens);
    return { content: [{ type: 'text', text: packed.text }] };
  }

  /** Lazily initialise the scrape client so env-var fallback order works. */
  private getScrapeClient(): ScrapeClient {
    if (!this._scrapeClient) {
      const baseUrl = (process.env.CRW_URL || process.env.CRAWL4AI_URL || 'http://localhost:8001').replace(/\/$/, '');
      this._scrapeClient = new ScrapeClient(baseUrl);
    }
    return this._scrapeClient;
  }

  /**
   * Scrape a URL via CRW with per-URL caching (24h TTL).
   * Uses normalized URLs for cache keys to maximize reuse.
   * Returns the raw ScrapeClientResponse — callers shape output as needed.
   */
  private async cachedScrapeUrl(
    url: string,
    formats: string[],
    timeout: number = DEFAULT_WEBFETCH_TIMEOUT_MS,
    controls: Pick<ScrapeOptions, 'wait_for' | 'renderJs' | 'onlyMainContent' | 'renderer'> = {},
  ): Promise<ScrapeClientResponse> {
    const normalized = normalizeUrl(url);
    const cacheKey = `scrape_url:v3:${normalized}:${(formats || ['markdown']).join(',')}:${timeout}:${JSON.stringify(controls)}`;
    const cached = await timedAsync('mcp.cache.get', () => this.cache.get<ScrapeClientResponse>(cacheKey), value => value ? 'hit' : 'miss', true);
    if (cached) {
      skipTiming('mcp.crawl.page', 'cached');
      return cached;
    }

    const result = await timedAsync('mcp.crawl.page', () => this.getScrapeClient().scrape(url, {
      formats: formats || ['markdown'],
      timeout,
      ...controls,
      proxy_url: process.env.PROXY_URL,
    }), scrapeTimingStatus);

    if (scrapeCacheEligible(result)) {
      await timedAsync('mcp.cache.set', () => this.cache.set(cacheKey, result, URL_SCRAPE_CACHE_TTL_MS), undefined, true);
    } else {
      skipTiming('mcp.cache.set');
    }
    return result;
  }

  async handle(args: any) {
    return withSourceTiming(0, () => this.handleIndexedScrapeUrl(args));
  }

  private async handleIndexedScrapeUrl(args: any) {
    const parsed = timedSync('mcp.validation', () => validateScrapeArgs(args), false, result => result.ok ? 'success' : 'validation_error');
    if (!parsed.ok) {
      for (const stage of ['mcp.discovery', 'mcp.crawl.batch', 'mcp.crawl.page', 'mcp.parse', 'mcp.rank', 'mcp.cache.get', 'mcp.cache.set']) skipTiming(stage);
      return mcpJson({ error: parsed.error, message: parsed.message }, resolveErrorBudget(args));
    }
    const request = parsed.value;

    if (request.document_id) {
      const lookedUp = timedSync('mcp.document.get', () => this.getDocumentStore().get(request.document_id!));
      if (!lookedUp.ok) {
        return mcpJson({
          error: 'document_unavailable',
          document_id: request.document_id,
          reason: lookedUp.reason,
          guidance: 'Saved document is missing or expired. Call webfetch with the original url.',
        }, request.max_tokens);
      }
      skipTiming('mcp.crawl.page', 'cached');
      skipTiming('mcp.parse', 'cached');
      return this.packSavedDocument(lookedUp.document, request);
    }

    const url = request.url as string;
    const existing = timedSync('mcp.document.get', () => this.getDocumentStore().getByUrl(url));
    if (existing.ok && !existing.document.fetch?.outcome && args.wait_for === undefined && args.renderJs === undefined && args.onlyMainContent === undefined && args.renderer === undefined) {
      skipTiming('mcp.crawl.page', 'cached');
      skipTiming('mcp.parse', 'cached');
      return this.packSavedDocument(existing.document, request);
    }

    logger.info(`Scraping with CRW: ${url}`);

    try {
      const result = await this.cachedScrapeUrl(
        url,
        args.formats || ['markdown'],
        args.timeout || DEFAULT_WEBFETCH_TIMEOUT_MS,
        {
          ...(args.wait_for !== undefined ? { wait_for: args.wait_for } : {}),
          ...(args.renderJs !== undefined ? { renderJs: args.renderJs } : {}),
          ...(args.onlyMainContent !== undefined ? { onlyMainContent: args.onlyMainContent } : {}),
          ...(args.renderer !== undefined ? { renderer: args.renderer } : {}),
        },
      );
      const markdown = typeof result.data?.markdown === 'string' ? result.data.markdown : '';
      const title = (result.data?.metadata as { title?: string } | undefined)?.title || url;
      const outcome = scrapeOutcome(result);
      if (!result.success || !markdown.trim() || outcome === 'unusable' || outcome === 'failed') {
        skipTiming('mcp.parse');
        skipTiming('mcp.rank');
        const bounded = boundUpstreamError(
          !result.success ? (result.error || 'scrape_failed') : !markdown.trim() ? 'Empty extraction' : outcome === 'unusable' ? 'No usable content (known shell or block)' : 'scrape_failed',
        );
        return mcpJson({
          success: false,
          url,
          error: bounded.error,
          fetch: scrapeProvenance(result),
          ...(bounded.diagnostic ? { diagnostic: bounded.diagnostic } : {}),
        }, request.max_tokens);
      }
      const explicitControls = args.wait_for !== undefined || args.renderJs !== undefined || args.onlyMainContent !== undefined || args.renderer !== undefined;
      const retained = this.retainDocument(url, title, markdown, scrapeProvenance(result), !explicitControls);
      if (request.list_sections) {
        if (!retained.document_id) {
          return mcpJson({
            success: true,
            url,
            read_more_unavailable: true,
          }, request.max_tokens);
        }
        return this.packSavedDocument({
          document_id: retained.document_id,
          url: retained.url,
          title: retained.title,
          markdown: retained.markdown,
          sections: retained.sections,
          saved_at: retained.saved_at,
          expires_at: retained.expires_at,
          fetch: scrapeProvenance(result),
        }, request);
      }
      return this.packScrapedDocument(result, retained, request);
    } catch (error) {
      logger.error('CRW scrape failed:', error);
      skipTiming('mcp.parse');
      skipTiming('mcp.rank');
      return mcpJson({
        success: false,
        url,
        error: 'scrape_failed',
      }, request.max_tokens);
    }
  }

}
