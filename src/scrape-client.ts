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
