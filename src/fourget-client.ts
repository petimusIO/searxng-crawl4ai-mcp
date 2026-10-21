import axios from 'axios';
import { logger } from './logger.js';

export const DEFAULT_FOURGET_SCRAPER = 'ddg';
export const DEFAULT_FOURGET_NEWS_SCRAPER = 'ddg';

/** Raw 4get web result before processing */
interface FourgetRawDescriptionItem {
  type: string;
  value: string;
}

interface FourgetRawWebResult {
  title: string;
  url: string;
  description: FourgetRawDescriptionItem[] | string | null;
  date: number | null;   // Unix timestamp (seconds)
  type: string;
}

interface FourgetRawResponse {
  status: string;
  web?: FourgetRawWebResult[];
  answer?: any[];
  npt?: string;
}

/** Flattened description, processed for downstream consumption */
export interface FourgetWebResult {
  title: string;
  url: string;
  description: string;     // Flattened plain-text snippet
  date: string | null;     // ISO 8601 string or null
  type: string;
}

export interface FourgetSearchResponse {
  status: string;
  web: FourgetWebResult[];
  answer: any[];
  npt: string;
}

export interface FourgetImageSearchOptions {
  scraper?: string;
  nsfw?: string;
  timeoutMs?: number;
}

export interface FourgetImageSearchResponse {
  status: string;
  image: Array<{
    title?: string;
    url?: string;
    source?: Array<{ url?: string; width?: number; height?: number }>;
  }>;
}

/**
 * Flatten 4get's rich description array into a plain text string.
 * Live 4get may return a plain string; existing callers also send
 * `{ type, value }[]` or null.
 */
function flattenDescription(
  raw: FourgetRawDescriptionItem[] | string | null | undefined,
): string {
  if (typeof raw === 'string') return raw;
  if (!raw || !Array.isArray(raw)) return '';
  return raw
    .map((item) => item?.value ?? '')
    .join('');
}

/**
 * Convert Unix timestamp (seconds) to ISO 8601 string.
 * Returns null if the input is null/undefined/invalid.
 */
function unixToISO(ts: number | null | undefined): string | null {
  if (ts == null) return null;
  const date = new Date(ts * 1000);
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** News scrapers return untrusted rows; Startpage sometimes sends a year as a timestamp. */
function normalizeNewsRows(raw: unknown): FourgetWebResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!row || typeof row.title !== 'string' || typeof row.url !== 'string') return [];
    const title = row.title.trim();
    const url = row.url.trim();
    if (!title) return [];
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) return [];
    } catch {
      return [];
    }
    const description = typeof row.description === 'string' ? row.description
      : Array.isArray(row.description)
        ? row.description.map((item: unknown) => item && typeof item === 'object' && 'value' in item
          && typeof item.value === 'string' ? item.value : '').join('')
        : '';
    const ts = row.date;
    const validSeconds = typeof ts === 'number' && Number.isInteger(ts)
      && ts >= -62135596800 && ts <= 253402300799
      && !(ts >= 1000 && ts <= 9999);
    return [{ title, url, description, date: validSeconds ? unixToISO(ts) : null, type: 'news' }];
  });
}

export class FourgetClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8090') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async search(
    query: string,
    scraper: string = DEFAULT_FOURGET_SCRAPER,
    timeoutMs: number = 8000,
  ): Promise<FourgetSearchResponse> {
    try {
      logger.info(`Searching 4get: ${query} (scraper=${scraper})`);

      const response = await axios.get<FourgetRawResponse>(
        `${this.baseUrl}/api/v1/web`,
        {
          params: { s: query, scraper },
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'SearXNG-CRW-MCP/3.0',
          },
          timeout: timeoutMs,
        }
      );

      const data = response.data;

      const web: FourgetWebResult[] = (data.web || []).map((r) => ({
        title: r.title,
        url: r.url,
        description: flattenDescription(r.description),
        date: unixToISO(r.date),
        type: r.type,
      }));

      logger.info(`4get returned ${web.length} web results for "${query}"`);

      return {
        status: data.status,
        web,
        answer: data.answer || [],
        npt: data.npt || '',
      };
    } catch (error) {
      logger.error(`4get search error for "${query}":`, error);
      throw error;
    }
  }

  async searchNews(
    query: string,
    scraper: string = DEFAULT_FOURGET_NEWS_SCRAPER,
    timeoutMs: number = 1500,
  ): Promise<FourgetSearchResponse> {
    const response = await axios.get<{ status: string; news?: FourgetRawWebResult[]; npt?: string }>(
      `${this.baseUrl}/api/v1/news`,
      {
        params: { s: query, scraper, nsfw: 'no' },
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SearXNG-CRW-MCP/3.0',
        },
        timeout: timeoutMs,
      },
    );
    const data = response.data;
    return {
      status: data.status,
      web: normalizeNewsRows(data.news),
      answer: [],
      npt: data.npt || '',
    };
  }

  async searchImages(
    query: string,
    options: FourgetImageSearchOptions = {},
  ): Promise<FourgetImageSearchResponse> {
    const scraper = options.scraper || DEFAULT_FOURGET_SCRAPER;
    const timeoutMs = options.timeoutMs ?? 2500;

    try {
      logger.info(`Searching 4get images: ${query} (scraper=${scraper})`);

      const response = await axios.get<{ status?: string; image?: FourgetImageSearchResponse['image'] }>(
        `${this.baseUrl}/api/v1/images`,
        {
          params: {
            s: query,
            scraper,
            nsfw: 'no',
          },
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'SearXNG-CRW-MCP/3.0',
          },
          timeout: timeoutMs,
        },
      );

      return {
        status: response.data.status || 'ok',
        image: response.data.image || [],
      };
    } catch (error) {
      logger.error(`4get image search error for "${query}":`, error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/api/v1/web`, {
        params: { s: 'healthcheck', scraper: DEFAULT_FOURGET_SCRAPER },
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
