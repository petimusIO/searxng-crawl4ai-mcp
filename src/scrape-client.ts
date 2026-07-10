import axios, { AxiosResponse } from 'axios';
import { logger } from './logger.js';

export interface ScrapeOptions {
  formats?: string[];
  wait_for?: number;
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
    };
  };
  error?: string;
}

export class ScrapeClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:3000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeClientResponse> {
    try {
      logger.info(`Scraping with CRW: ${url}`);

      const response: AxiosResponse<any> = await axios.post(
        `${this.baseUrl}/v1/scrape`,
        {
          url,
          formats: options.formats || ['markdown'],
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: (options.timeout || 30000) + 5000,
        }
      );

      return this.normalizeResponse(response.data, url);
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
        },
      },
      error: raw.error,
    };
  }
}
