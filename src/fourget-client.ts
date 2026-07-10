import axios from 'axios';
import { logger } from './logger.js';

/** Raw 4get web result before processing */
interface FourgetRawDescriptionItem {
  type: string;
  value: string;
}

interface FourgetRawWebResult {
  title: string;
  url: string;
  description: FourgetRawDescriptionItem[] | null;
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

/**
 * Flatten 4get's rich description array into a plain text string.
 * Each item is `{ type: string, value: string }` — we concatenate all values.
 */
function flattenDescription(raw: FourgetRawDescriptionItem[] | null | undefined): string {
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

export class FourgetClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8090') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async search(query: string, scraper: string = 'brave'): Promise<FourgetSearchResponse> {
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
          timeout: 8000,
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

  async healthCheck(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/api/v1/web`, {
        params: { s: 'healthcheck', scraper: 'brave' },
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
