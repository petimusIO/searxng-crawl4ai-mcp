import axios, { AxiosResponse } from 'axios';
import { logger } from './logger.js';
import { withCrwTiming } from './search-timing.js';

export interface ScrapeOptions {
  formats?: string[];
  wait_for?: number;
  renderJs?: boolean;
  onlyMainContent?: boolean;
  renderer?: 'auto' | 'lightpanda';
  timeout?: number;
  proxy_url?: string;
}

export interface MapOptions {
  maxDepth?: number;        // default: 2
  useSitemap?: boolean;     // default: true
  crawlFallback?: boolean;  // default: true
  timeout?: number;         // default: 120 (seconds)
}

export interface MapResponse {
  success: boolean;
  data: {
    links: string[];
    droppedActionCount: number;
    strippedTrackingCount: number;
  };
  error?: string;
}

export interface CrawlOptions {
  maxPages?: number;          // default: 100
  maxDepth?: number;          // default: 2
  scrapeOptions?: {
    formats?: string[];
    onlyMainContent?: boolean;
  };
}

export interface CrawlAcceptedResponse {
  success: boolean;
  id: string;
  url: string;  // polling URL (relative)
  error?: string;
}

export interface CrawlStatusResponse {
  success: boolean;
  status: 'scraping' | 'completed' | 'failed';
  total: number;
  completed: number;
  data?: Array<{
    markdown: string;
    metadata: {
      title: string;
      description: string | null;
      sourceURL: string;
      language: string;
      statusCode: number;
      renderedWith: string;
      elapsedMs: number;
    };
  }>;
  error?: string;
}

export interface ScrapeClientResponse {
  success: boolean;
  url: string;
  data?: {
    markdown: string;
    html?: string;
    links?: string[];
    media?: string[];
    metadata: {
      title: string;
      description: string;
      language: string;
      word_count: number;
      status_code?: number;
      rendered_with?: string;
      elapsed_ms?: number;
    };
  };
  error?: string;
  diagnostics?: FetchProvenance;
}

export interface FetchProvenance {
  status_code?: number;
  rendered_with?: string;
  elapsed_ms?: number;
  outcome?: 'degraded' | 'unusable' | 'failed';
  error_code?: string;
  warnings?: string[];
  render_decision?: { kind?: string; chosen?: string; from?: string; skipped?: string; renderer?: string; reason?: string; chain?: string[] };
  block?: { vendor?: string; reason?: string };
}

// Diagnostics are untrusted: whitelist fields, cap size, never forward debug/body objects.
function diagnosticText(value: unknown, limit = 240): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/((?:token|password|authorization|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f]/g, ' ').slice(0, limit);
}

function normalizeDiagnostics(raw: any): FetchProvenance {
  const data = raw.data ?? {};
  const warnings = [...new Set([raw.warning, data.warning, ...(Array.isArray(raw.warnings) ? raw.warnings : []), ...(Array.isArray(data.warnings) ? data.warnings : [])]
    .map(value => diagnosticText(value)).filter((value): value is string => Boolean(value)))].slice(0, 4);
  const diagnostics: FetchProvenance = {};
  const code = diagnosticText(raw.errorCode ?? raw.error_code ?? data.errorCode ?? data.error_code, 80);
  if (code) diagnostics.error_code = code;
  if (warnings.length) diagnostics.warnings = warnings;
  const decision = data.renderDecision ?? data.render_decision ?? raw.renderDecision ?? raw.render_decision;
  if (decision && typeof decision === 'object') {
    const bounded: NonNullable<FetchProvenance['render_decision']> = {};
    for (const key of ['kind', 'chosen', 'from', 'skipped', 'renderer', 'reason'] as const) {
      const value = diagnosticText(decision[key], 80);
      if (value) bounded[key] = value;
    }
    if (Array.isArray(decision.chain)) bounded.chain = decision.chain.slice(0, 4).map((value: unknown) => diagnosticText(value, 40)).filter(Boolean);
    if (Object.keys(bounded).length) diagnostics.render_decision = bounded;
  }
  const block = data.block ?? raw.block;
  if (block && typeof block === 'object') {
    diagnostics.block = { vendor: diagnosticText(block.vendor, 80), reason: diagnosticText(block.reason, 160) };
    diagnostics.outcome = 'unusable';
  } else if (raw.success === false) diagnostics.outcome = 'failed';
  else if (code || data.truncated === true || decision?.kind === 'failover' || warnings.some(w => /fail|timeout|timed out|fallback|unavailable|truncat|no usable|placeholder|empty.?root|crash/i.test(w))) diagnostics.outcome = 'degraded';
  return diagnostics;
}

export class ScrapeClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:3000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeClientResponse> {
    try {
      logger.info(`Scraping with CRW: ${url}`);

      const deadlineMs = options.timeout || 30000;
      return await withCrwTiming(async (crwRequestId) => {
        const response: AxiosResponse<any> = await axios.post(
          `${this.baseUrl}/v1/scrape`,
          {
            url,
            formats: options.formats || ['markdown'],
            deadlineMs,
            ...(options.wait_for !== undefined ? { waitFor: options.wait_for } : {}),
            ...(options.renderJs !== undefined ? { renderJs: options.renderJs } : {}),
            ...(options.onlyMainContent !== undefined ? { onlyMainContent: options.onlyMainContent } : {}),
            ...(options.renderer !== undefined ? { renderer: options.renderer } : {}),
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-seek-crawl-id': crwRequestId,
            },
            timeout: deadlineMs + 1000,
          }
        );

        return this.normalizeResponse(response.data, url);
      }, result => {
        const outcome = scrapeOutcome(result);
        return outcome === 'success' ? 'success' : outcome === 'degraded' ? 'partial' : 'error';
      });
    } catch (error) {
      logger.error(`CRW scrape error for ${url}:`, error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, {
        timeout: 5000,
      });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  async map(url: string, options: MapOptions = {}): Promise<MapResponse> {
    try {
      logger.info(`Mapping site with CRW: ${url}`);

      const response = await axios.post(
        `${this.baseUrl}/v1/map`,
        {
          url,
          maxDepth: options.maxDepth ?? 2,
          useSitemap: options.useSitemap ?? true,
          crawlFallback: options.crawlFallback ?? true,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: (options.timeout || 120) * 1000, // seconds to ms
        }
      );

      return {
        success: response.data.success ?? true,
        data: {
          links: response.data.data?.links ?? response.data.links ?? [],
          droppedActionCount: response.data.data?.droppedActionCount ?? 0,
          strippedTrackingCount: response.data.data?.strippedTrackingCount ?? 0,
        },
        error: response.data.error,
      };
    } catch (error: any) {
      logger.error(`CRW map error for ${url}:`, error);
      return {
        success: false,
        data: { links: [], droppedActionCount: 0, strippedTrackingCount: 0 },
        error: error.message || 'Map failed',
      };
    }
  }

  async crawl(url: string, options: CrawlOptions = {}): Promise<CrawlAcceptedResponse> {
    try {
      logger.info(`Starting crawl with CRW: ${url}`);

      const payload: Record<string, unknown> = { url };
      if (options.maxPages != null) payload.maxPages = options.maxPages;
      if (options.maxDepth != null) payload.maxDepth = options.maxDepth;
      if (options.scrapeOptions) {
        payload.scrapeOptions = {};
        if (options.scrapeOptions.formats) {
          (payload.scrapeOptions as Record<string, unknown>).formats = options.scrapeOptions.formats;
        }
        if (options.scrapeOptions.onlyMainContent != null) {
          (payload.scrapeOptions as Record<string, unknown>).onlyMainContent = options.scrapeOptions.onlyMainContent;
        }
      }

      const response = await axios.post(
        `${this.baseUrl}/v1/crawl`,
        payload,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000, // initial POST timeout
        }
      );

      return {
        success: response.data.success ?? true,
        id: response.data.id ?? '',
        url: response.data.url ?? `${this.baseUrl}/v1/crawl/${response.data.id}`,
        error: response.data.error,
      };
    } catch (error: any) {
      logger.error(`CRW crawl error for ${url}:`, error);
      return {
        success: false,
        id: '',
        url: '',
        error: error.message || 'Crawl failed',
      };
    }
  }

  async crawlStatus(jobId: string): Promise<CrawlStatusResponse> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v1/crawl/${jobId}`,
        { timeout: 10000 }
      );

      // CRW returns raw strings for invalid UUIDs — wrap in try/catch
      let data: any;
      try {
        data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      } catch {
        logger.warn(`CRW crawlStatus for ${jobId}: response is not JSON: ${String(response.data).slice(0, 200)}`);
        return {
          success: false,
          status: 'failed',
          total: 0,
          completed: 0,
          data: [],
          error: 'Invalid JSON response from CRW',
        };
      }

      return {
        success: data.success ?? true,
        status: data.status ?? 'scraping',
        total: data.total ?? 0,
        completed: data.completed ?? 0,
        data: data.data ?? [],
        error: data.error,
      };
    } catch (error: any) {
      // Axios-level error (network, timeout, 4xx)
      logger.error(`CRW crawlStatus error for ${jobId}:`, error);
      const statusCode = error.response?.status;
      // 400 likely means invalid UUID — treat as failed
      if (statusCode === 400 || statusCode === 404) {
        return {
          success: false,
          status: 'failed',
          total: 0,
          completed: 0,
          data: [],
          error: `Crawl job not found: ${error.message}`,
        };
      }
      return {
        success: false,
        status: 'failed',
        total: 0,
        completed: 0,
        data: [],
        error: error.message || 'Status check failed',
      };
    }
  }

  /**
   * Normalize the CRW API response to match the Crawl4AI-compatible interface
   * used throughout the MCP server code.
   */
  private normalizeResponse(raw: any, url: string): ScrapeClientResponse {
    const markdown = raw.data?.markdown ?? '';
    const metadata = raw.data?.metadata ?? {};

    return {
      success: raw.success ?? true,
      url: metadata.sourceURL ?? url,
      data: {
        markdown,
        html: undefined,
        links: undefined,
        media: undefined,
        metadata: {
          title: metadata.title ?? '',
          description: metadata.description ?? '',  // normalize null to ''
          language: metadata.language ?? '',
          word_count: markdown ? markdown.split(/\s+/).filter(Boolean).length : 0,
          ...(typeof metadata.statusCode === 'number' ? { status_code: metadata.statusCode } : {}),
          ...(typeof metadata.renderedWith === 'string' && metadata.renderedWith ? { rendered_with: metadata.renderedWith } : {}),
          ...(typeof metadata.elapsedMs === 'number' ? { elapsed_ms: metadata.elapsedMs } : {}),
        },
      },
      error: raw.error,
      diagnostics: normalizeDiagnostics(raw),
    };
  }
}

/**
 * Extract fetch provenance (HTTP status, render path, CRW elapsed time) from a
 * scrape result so callers can distinguish "the page said nothing" from
 * "the page 404'd" or "the page was JS-rendered". Undefined when CRW sent none.
 */
export function scrapeProvenance(result: ScrapeClientResponse): FetchProvenance | undefined {
  const meta = result.data?.metadata;
  const provenance: FetchProvenance = { ...result.diagnostics };
  if (typeof meta?.status_code === 'number') provenance.status_code = meta.status_code;
  if (typeof meta?.rendered_with === 'string' && meta.rendered_with) provenance.rendered_with = meta.rendered_with;
  if (typeof meta?.elapsed_ms === 'number') provenance.elapsed_ms = meta.elapsed_ms;
  const outcome = scrapeOutcome(result);
  if (outcome !== 'success') provenance.outcome = outcome;
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

/** Exact shell signatures, not a minimum length or relevance/word-count heuristic. */
export function scrapeOutcome(result: ScrapeClientResponse): 'success' | 'degraded' | 'unusable' | 'failed' {
  if (!result.success) return 'failed';
  const markdown = result.data?.markdown?.trim() ?? '';
  if (!markdown || result.diagnostics?.block || result.diagnostics?.outcome === 'unusable') return 'unusable';
  const body = markdown.replace(/^#{1,6}\s+.*$/gm, '').trim() || markdown.replace(/^#{1,6}\s+/gm, '');
  const plain = body.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(?:loading(?:\.{1,3}|…)?|please wait(?:\.{1,3}|…)?|(?:please )?(?:log ?in|sign ?in)(?: to continue)?[.!]?|(?:please )?enable javascript(?: to (?:continue|view (?:this page|the content)))?[.!]?)$/i.test(plain)) return 'unusable';
  if (result.data?.metadata?.status_code && result.data.metadata.status_code >= 400) return 'failed';
  return result.diagnostics?.outcome ?? 'success';
}

export function scrapeCacheEligible(result: ScrapeClientResponse): boolean {
  return scrapeOutcome(result) === 'success';
}
