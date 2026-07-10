# Research Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `research` MCP tool with `depth` (quick/normal/deep) and `breadth` (single/multi) axes, replacing the confusing `search_and_scrape` tool.

**Architecture:** Two-phase delivery. Phase A adds `map()` and `crawl()` methods to `ScrapeClient` for CRW's `/v1/map` and `/v1/crawl` endpoints. Phase B builds the `handleResearch()` handler with quick/normal depth modes (deep deferred to Phase C), registers the `research` tool schema, and removes the old `search_and_scrape` tool.

**Tech Stack:** TypeScript, Vitest, axios (for CRW), MCP SDK 0.5.x, existing SearXNGClient/ScrapeClient/RedisCache/passage-extractor/url-normalizer

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/scrape-client.ts` | Modify | Add `map()`, `crawl()`, `crawlStatus()` methods + types |
| `src/index.ts` | Modify | Add `handleResearch()`, register `research` tool, remove `search_and_scrape` |
| `src/content-utils.ts` | Create | Extract `stripMarkdownFromData()` helper shared across handlers |
| `tests/scrape-client.test.ts` | Create | Unit tests for new ScrapeClient methods (mocked axios) |
| `tests/content-utils.test.ts` | Create | Unit tests for the extracted content utility |
| `tests/content-mode.test.ts` | Modify | Update to import from `src/content-utils.ts` instead of local function |

---

### Task 1: Add map() method to ScrapeClient

**Files:**
- Modify: `src/scrape-client.ts` (after line 70, before `healthCheck` returns)

**HITL**: No — AFK

- [ ] **Step 1: Add MapOptions and MapResponse interfaces**

Add after the existing `ScrapeOptions` interface (after line 9):

```typescript
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
```

- [ ] **Step 2: Add map() method to ScrapeClient class**

Add after the `healthCheck()` method (after line 70) but before `normalizeResponse`:

```typescript
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
```

- [ ] **Step 3: Write unit test for map()**

Create `tests/scrape-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ScrapeClient, MapOptions } from '../src/scrape-client.js';

vi.mock('axios');

const mockedAxios = vi.mocked(axios);

describe('ScrapeClient.map', () => {
  let client: ScrapeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ScrapeClient('http://localhost:8001');
  });

  it('calls POST /v1/map with url and default options', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          links: ['https://example.com', 'https://example.com/about'],
          droppedActionCount: 1,
          strippedTrackingCount: 2,
        },
      },
    });

    const result = await client.map('https://example.com');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/map',
      {
        url: 'https://example.com',
        maxDepth: 2,
        useSitemap: true,
        crawlFallback: true,
      },
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(result.success).toBe(true);
    expect(result.data.links).toHaveLength(2);
    expect(result.data.droppedActionCount).toBe(1);
  });

  it('uses custom maxDepth and timeout from options', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, data: { links: [], droppedActionCount: 0, strippedTrackingCount: 0 } },
    });

    await client.map('https://example.com', { maxDepth: 5, timeout: 60 });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/map',
      expect.objectContaining({ maxDepth: 5 }),
      expect.objectContaining({ timeout: 60000 }) // 60s to ms
    );
  });

  it('returns error object on axios failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await client.map('https://example.com');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
    expect(result.data.links).toEqual([]);
  });

  it('handles CRW response without data.data wrapper', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        links: ['https://example.com/page1'],
      },
    });

    const result = await client.map('https://example.com');

    expect(result.data.links).toEqual(['https://example.com/page1']);
  });
});
```

- [ ] **Step 4: Run tests to verify**

Run: `pnpm test -- tests/scrape-client.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/scrape-client.ts tests/scrape-client.test.ts
git commit -m "feat(scrape-client): add map() method for CRW /v1/map site discovery"
```

---

### Task 2: Add crawl() and crawlStatus() methods to ScrapeClient

**Files:**
- Modify: `src/scrape-client.ts` (after the new `map()` method)

**HITL**: No — AFK

- [ ] **Step 1: Add CrawlOptions, CrawlAcceptedResponse, CrawlStatusResponse interfaces**

Add after the `MapResponse` interface:

```typescript
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
```

- [ ] **Step 2: Add crawl() method — POST /v1/crawl**

Add after the `map()` method:

```typescript
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
```

- [ ] **Step 3: Add crawlStatus() method — GET /v1/crawl/{id} with safe JSON parsing**

Add after the `crawl()` method:

```typescript
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
```

- [ ] **Step 4: Add unit tests for crawl() and crawlStatus()**

Append to `tests/scrape-client.test.ts`:

```typescript
import { ScrapeClient, CrawlOptions, CrawlAcceptedResponse, CrawlStatusResponse } from '../src/scrape-client.js';

describe('ScrapeClient.crawl', () => {
  let client: ScrapeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ScrapeClient('http://localhost:8001');
  });

  it('calls POST /v1/crawl and returns job ID', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        id: 'crawl-job-123',
        url: 'http://localhost:3000/v1/crawl/crawl-job-123',
      },
    });

    const result = await client.crawl('https://example.com');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/crawl',
      { url: 'https://example.com' },
      expect.any(Object)
    );
    expect(result.success).toBe(true);
    expect(result.id).toBe('crawl-job-123');
  });

  it('passes maxPages, maxDepth, and scrapeOptions', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, id: 'job-1', url: '...' },
    });

    await client.crawl('https://example.com', {
      maxPages: 5,
      maxDepth: 2,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8001/v1/crawl',
      {
        url: 'https://example.com',
        maxPages: 5,
        maxDepth: 2,
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      },
      expect.any(Object)
    );
  });

  it('returns error on failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Timeout'));

    const result = await client.crawl('https://example.com');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Timeout');
  });
});

describe('ScrapeClient.crawlStatus', () => {
  let client: ScrapeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ScrapeClient('http://localhost:8001');
  });

  it('calls GET /v1/crawl/{id} and returns status', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'completed',
        total: 3,
        completed: 3,
        data: [
          {
            markdown: '# Page 1',
            metadata: {
              title: 'Page 1',
              description: null,
              sourceURL: 'https://example.com',
              language: 'en',
              statusCode: 200,
              renderedWith: 'http',
              elapsedMs: 15,
            },
          },
        ],
      },
    });

    const result = await client.crawlStatus('crawl-job-123');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://localhost:8001/v1/crawl/crawl-job-123',
      expect.any(Object)
    );
    expect(result.status).toBe('completed');
    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(1);
  });

  it('handles scraping status correctly', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'scraping',
        total: 10,
        completed: 4,
        data: [],
      },
    });

    const result = await client.crawlStatus('active-job');

    expect(result.status).toBe('scraping');
    expect(result.completed).toBe(4);
  });

  it('handles raw string response from CRW (non-JSON)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: 'Invalid URL: Cannot parse `id` with value `bad-uuid`: UUID parsing failed',
    });

    const result = await client.crawlStatus('bad-uuid');

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Invalid JSON response from CRW');
  });

  it('handles 400 status as failed crawl', async () => {
    const axiosError = new Error('Request failed with status code 400') as any;
    axiosError.response = { status: 400 };
    mockedAxios.get.mockRejectedValueOnce(axiosError);

    const result = await client.crawlStatus('nonexistent');

    expect(result.status).toBe('failed');
    expect(result.data).toEqual([]);
  });
});
```

- [ ] **Step 5: Run tests to verify**

Run: `pnpm test -- tests/scrape-client.test.ts`
Expected: 11 tests PASS (4 map + 7 crawl/crawlStatus)

- [ ] **Step 6: Commit**

```bash
git add src/scrape-client.ts tests/scrape-client.test.ts
git commit -m "feat(scrape-client): add crawl() and crawlStatus() for CRW async multi-page crawling"
```

---

### Task 3: Extract stripMarkdownFromData helper to shared module

**Files:**
- Create: `src/content-utils.ts`
- Modify: `src/index.ts` (import + use, lines 452-455 and 637-641)
- Modify: `tests/content-mode.test.ts` (import from source instead of local)

**HITL**: No — AFK

- [ ] **Step 1: Create src/content-utils.ts**

```typescript
export type ContentMode = 'full' | 'relevant_only' | 'snippet';

/**
 * Strip the `markdown` field from a data object when content mode is "relevant_only" or "snippet".
 * In "full" mode or when mode is undefined, returns the data unchanged.
 * Always returns a partial copy — never mutates the input.
 */
export function stripMarkdownFromData<T extends { markdown?: string }>(
  data: T | undefined,
  contentMode: ContentMode | undefined
): T | undefined {
  if (!data) return data;
  if (!contentMode || contentMode === 'full') return data;
  const { markdown: _, ...rest } = data;
  return rest as T;
}
```

- [ ] **Step 2: Write unit tests**

Create `tests/content-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { stripMarkdownFromData, ContentMode } from '../src/content-utils.js';

describe('stripMarkdownFromData', () => {
  const fullData = {
    markdown: '# Hello\n\nThis is a long article.',
    metadata: { title: 'Test', description: 'A test', language: 'en', word_count: 50 },
  };

  it('returns full data when mode is undefined (default)', () => {
    const result = stripMarkdownFromData(fullData, undefined);
    expect(result).toEqual(fullData);
    expect(result).toHaveProperty('markdown');
  });

  it('returns full data when mode is "full"', () => {
    const result = stripMarkdownFromData(fullData, 'full');
    expect(result).toEqual(fullData);
    expect(result).toHaveProperty('markdown');
  });

  it('strips markdown when mode is "relevant_only"', () => {
    const result = stripMarkdownFromData(fullData, 'relevant_only');
    expect(result).not.toHaveProperty('markdown');
    expect(result).toHaveProperty('metadata');
  });

  it('strips markdown when mode is "snippet"', () => {
    const result = stripMarkdownFromData(fullData, 'snippet');
    expect(result).not.toHaveProperty('markdown');
    expect(result).toHaveProperty('metadata');
  });

  it('handles undefined data gracefully', () => {
    const result = stripMarkdownFromData(undefined, 'relevant_only');
    expect(result).toBeUndefined();
  });

  it('does not mutate the original object', () => {
    const copy = { ...fullData };
    stripMarkdownFromData(fullData, 'relevant_only');
    expect(fullData).toEqual(copy);
    expect(fullData).toHaveProperty('markdown');
  });
});
```

- [ ] **Step 3: Run new tests — should pass**

Run: `pnpm test -- tests/content-utils.test.ts`
Expected: 6 tests PASS

- [ ] **Step 4: Update src/index.ts to use the shared helper**

Add this import near the top (after line 17, alongside the other imports):

```typescript
import { stripMarkdownFromData, ContentMode } from './content-utils.js';
```

Replace the inline destructuring in `handleScrapeUrl` (line 452-455):

```typescript
// BEFORE (in handleScrapeUrl):
    if (content_mode && content_mode !== 'full' && responseData.data) {
      const { markdown: _, ...rest } = responseData.data;
      responseData.data = rest;
    }

// REPLACE WITH:
    if (responseData.data) {
      responseData.data = stripMarkdownFromData(responseData.data, content_mode);
    }
```

Replace the inline destructuring in `handleSearchAndScrape` (line 637-641):

```typescript
// BEFORE (in handleSearchAndScrape):
                  let resultData = r.data;
                  if (contentMode !== 'full' && resultData) {
                    const { markdown: _, ...rest } = resultData;
                    resultData = rest;
                  }

// REPLACE WITH:
                  const resultData = stripMarkdownFromData(r.data, contentMode as ContentMode);
```

- [ ] **Step 5: Run all tests to verify nothing is broken**

Run: `pnpm test`
Expected: All 29 tests passing (23 existing + 6 new)

- [ ] **Step 6: Commit**

```bash
git add src/content-utils.ts tests/content-utils.test.ts src/index.ts
git commit -m "refactor: extract stripMarkdownFromData helper to src/content-utils.ts"
```

---

### Task 4: Implement handleResearch handler — quick and normal depth

**Files:**
- Modify: `src/index.ts` (add `handleResearch()` method)

**HITL**: No — AFK  
**Prerequisite**: Task 3 (content-utils.ts exists)

- [ ] **Step 1: Add configuration constants for research tool**

Add after the existing constants (after line 39, before the class definition):

```typescript
// Research tool defaults
const RESEARCH_MAX_RESULTS_SINGLE  = 3;
const RESEARCH_MAX_RESULTS_MULTI   = 5;
const RESEARCH_SCRAPE_TIMEOUT_MS   = 10000;
const RESEARCH_QUICK_POOL_SIZE     = CRAWL_POOL_SIZE;      // 15
const RESEARCH_NORMAL_POOL_SIZE    = CRAWL_POOL_SIZE;       // 15
const RESEARCH_CACHE_PREFIX        = 'research';
```

- [ ] **Step 2: Add handleResearch() method to SearXNGMCPServer class**

Insert after the `handleSearchAndScrape` method (after line 672, before `scrapeSingleUrl`):

```typescript
  /**
   * Research tool: search the web with configurable depth and breadth.
   *
   * Depth:  "quick" (search snippets only), "normal" (search + scrape + BM25, default),
   *         "deep" (search → map → crawl → aggregate BM25, future)
   * Breadth: "single" (best result, default), "multi" (all top results)
   */
  private async handleResearch(args: any) {
    const { query, depth, breadth, max_results, max_pages, categories, formats, content_mode } = args;
    const contentMode = (content_mode || 'full') as ContentMode;
    const researchDepth = depth || 'normal';
    const researchBreadth = breadth || 'single';

    // Validate depth — deep is not yet implemented
    if (researchDepth === 'deep') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            error: 'Deep research mode (site crawling) is not yet implemented. Use depth: "quick" or depth: "normal".',
            research_metadata: { depth: 'deep', breadth: researchBreadth, pages_scraped: 0, errors: [] },
            results: [],
          }, null, 2),
        }],
      };
    }

    const startTime = Date.now();
    const formatKey = (formats || ['markdown']).join(',');

    // Composite cache key
    const cacheKey = `${RESEARCH_CACHE_PREFIX}:${query}:${researchDepth}:${researchBreadth}:${max_results || ''}:${categories || ''}:${formatKey}:${contentMode}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      // 1. Search with retry
      let searchResults: Awaited<ReturnType<SearXNGClient['search']>> | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          searchResults = await this.searxng.search(query, {
            categories,
            language: 'en',
            format: 'json',
          });
          if (searchResults.results && searchResults.results.length > 0) break;
        } catch (e) {
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 500));
          } else {
            throw e;
          }
        }
      }

      if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
        const response = {
          content: [{ type: 'text', text: JSON.stringify({
            query,
            number_of_results: 0,
            unresponsive_engines: [] as string[],
            research_metadata: {
              depth: researchDepth,
              breadth: researchBreadth,
              pages_scraped: 0,
              errors: [],
            },
            results: [],
          }, null, 2) }],
        };
        return response;
      }

      // 2. Determine result count
      const defaultMaxResults = researchBreadth === 'single' ? RESEARCH_MAX_RESULTS_SINGLE : RESEARCH_MAX_RESULTS_MULTI;
      const resultLimit = Math.min(max_results || defaultMaxResults, 10);
      const topResults = searchResults.results.slice(0, resultLimit);

      // 3. Dispatch by depth
      if (researchDepth === 'quick') {
        return this.handleQuickResearch(query, researchBreadth, topResults, contentMode,
          searchResults.number_of_results, searchResults.unresponsive_engines, startTime);
      }

      // depth === 'normal' — scrape + BM25
      return this.handleNormalResearch(query, researchBreadth, topResults, contentMode, formats, 
        searchResults.number_of_results, searchResults.unresponsive_engines, startTime, cacheKey);
    } catch (error) {
      logger.error('Research workflow failed:', error);
      throw new Error(`Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Quick research: search snippets only, no scraping.
   */
  private handleQuickResearch(
    query: string,
    breadth: string,
    topResults: Array<{ url: string; title: string; content: string }>,
    contentMode: ContentMode,
    numberOfResults: number,
    unresponsiveEngines: string[],
    startTime: number,
  ) {
    const resultCount = breadth === 'single' ? 1 : Math.min(topResults.length, 5);
    const results = topResults.slice(0, resultCount).map((r, i) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
      source_type: 'snippet' as const,
      success: true,
      relevance_rank: i + 1,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        query,
        number_of_results: numberOfResults,
        unresponsive_engines: unresponsiveEngines,
        research_metadata: {
          depth: 'quick' as const,
          breadth: breadth,
          pages_scraped: 0,
          errors: [],
        },
        results,
        elapsed_ms: Date.now() - startTime,
      }, null, 2) }],
    };
  }

  /**
   * Normal research: search → scrape top URLs → BM25 per page.
   * This replaces the old search_and_scrape workflow.
   */
  private async handleNormalResearch(
    query: string,
    breadth: string,
    topResults: Array<{ url: string; title: string; content: string; score?: number }>,
    contentMode: ContentMode,
    formats: string[] | undefined,
    numberOfResults: number,
    unresponsiveEngines: string[],
    startTime: number,
    cacheKey: string,
  ) {
    // Determine how many URLs to scrape
    const urlsToScrapeCount = breadth === 'multi' 
      ? Math.min(topResults.length, 5)
      : Math.min(topResults.length, 3);

    const urlsToScrape = topResults.slice(0, urlsToScrapeCount).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.content,
    }));

    logger.info(`Research (normal): scraping ${urlsToScrape.length} URLs`);

    // Worker pool: scrape all URLs with concurrency limit
    const poolSize = RESEARCH_NORMAL_POOL_SIZE;
    const scrapedResults: Array<{
      url: string;
      title: string;
      snippet: string;
      source_type: 'scraped' | 'snippet';
      success: boolean;
      data?: any;
      relevant_passages?: any;
      error?: string;
    }> = [];

    const errors: Array<{ url: string; error: string }> = [];

    for (let i = 0; i < urlsToScrape.length; i += poolSize) {
      const batch = urlsToScrape.slice(i, i + poolSize);
      const batchResults = await Promise.allSettled(
        batch.map((entry) => this.scrapeSingleUrl(entry.url, RESEARCH_SCRAPE_TIMEOUT_MS, false, formats))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        const entry = batch[j];

        if (settled.status === 'fulfilled') {
          const scrapeData = settled.value.data;

          // Content-fit filter: skip results with too few words
          const wordCount = scrapeData?.metadata?.word_count || 0;
          if (wordCount < FIT_MIN_WORDS) {
            continue;
          }

          // BM25 extraction
          let relevantPassages: any = undefined;
          if (scrapeData?.markdown) {
            const ctxWindow = contentMode === 'snippet' ? 0 : RELEVANCE_CONTEXT_WINDOW;
            relevantPassages = extractRelevantPassages(
              scrapeData.markdown,
              query,
              {
                topN: RELEVANCE_TOP_N,
                contextWindow: ctxWindow,
                minScore: RELEVANCE_MIN_SCORE,
              }
            );
          }

          // Apply content mode stripping
          const resultData = contentMode !== 'full'
            ? stripMarkdownFromData(scrapeData, contentMode)
            : scrapeData;

          scrapedResults.push({
            url: entry.url,
            title: entry.title,
            snippet: entry.snippet,
            source_type: 'scraped',
            success: settled.value.success,
            data: resultData,
            relevant_passages: relevantPassages,
          });
        } else {
          const errMsg = settled.reason?.message || 'Scrape failed';
          errors.push({ url: entry.url, error: errMsg });
          scrapedResults.push({
            url: entry.url,
            title: entry.title,
            snippet: entry.snippet,
            source_type: 'snippet',
            success: false,
            error: errMsg,
          });
        }
      }
    }

    const response = {
      content: [{ type: 'text', text: JSON.stringify({
        query,
        number_of_results: numberOfResults,
        unresponsive_engines: unresponsiveEngines,
        research_metadata: {
          depth: 'normal' as const,
          breadth,
          pages_scraped: scrapedResults.filter((r) => r.success).length,
          errors,
        },
        results: scrapedResults,
        elapsed_ms: Date.now() - startTime,
      }, null, 2) }],
    };

    await this.cache.set(cacheKey, response);
    return response;
  }
```

- [ ] **Step 5: Run build to check for type errors**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(research): add handleResearch handler with quick and normal depth modes"
```

---

### Task 5: Register research tool, remove search_and_scrape

**Files:**
- Modify: `src/index.ts` (tool schema + switch statement)

**HITL**: No — AFK  
**Prerequisite**: Task 4

- [ ] **Step 1: Replace search_and_scrape tool schema with research tool schema**

In `setupToolHandlers()` at the `ListToolsRequestSchema` handler (line 206-323), replace the `search_and_scrape` block (lines 240-284) with the `research` tool schema:

```typescript
          {
            name: 'research',
            description:
              'Search the web and perform research at configurable depth and breadth. '
              + 'Depth: "quick" (search snippets only, fastest), "normal" (search + scrape top results with BM25 extraction, default), '
              + '"deep" (search → map site → crawl pages → aggregate BM25, future). '
              + 'Breadth: "single" (focus on best result, default), "multi" (all top results).',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query',
                },
                depth: {
                  type: 'string',
                  enum: ['quick', 'normal', 'deep'],
                  description: 'Research depth: "quick" (search snippets only), "normal" (search + scrape, default), "deep" (site crawling, future)',
                  default: 'normal',
                },
                breadth: {
                  type: 'string',
                  enum: ['single', 'multi'],
                  description: 'Source breadth: "single" (one best result, default), "multi" (all top results)',
                  default: 'single',
                },
                max_results: {
                  type: 'number',
                  description: 'Maximum number of search results to process (default: 3 for single, 5 for multi)',
                },
                max_pages: {
                  type: 'number',
                  description: 'Maximum total pages to crawl (deep mode only, default: 10)',
                },
                categories: {
                  type: 'string',
                  description: 'Search categories to filter by (e.g. "news", "science")',
                },
                formats: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Output formats for scraped content (default: ["markdown"])',
                },
                content_mode: {
                  type: 'string',
                  enum: ['full', 'relevant_only', 'snippet'],
                  description: 'Response content mode: "full" (everything), "relevant_only" (no full markdown), "snippet" (compact, no context)',
                  default: 'full',
                },
              },
              required: ['query'],
            },
          },
```

- [ ] **Step 2: Replace switch case for search_and_scrape with research**

In the `CallToolRequestSchema` handler switch statement (lines 330-339), replace:

```typescript
          case 'search_and_scrape':
            return await this.handleSearchAndScrape(args);
```

with:

```typescript
          case 'research':
            return await this.handleResearch(args);
```

- [ ] **Step 3: Mark handleSearchAndScrape for removal**

The old `handleSearchAndScrape` method (lines 484-672) is now dead code. Since we're replacing it fully, we keep it in this commit for safety (a future cleanup commit can remove it). Alternatively, we can remove it now. For safety in case of revert, leave it in place — it will be unused but compiles.

No code change needed for this step — just verification.

- [ ] **Step 4: Build and typecheck**

Run: `pnpm build`
Expected: Build succeeds, no errors

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: All 29 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(research): register research tool, remove search_and_scrape from MCP schema"
```

---

### Task 6: Integration verification — build, lint, test

**Files:**
- (verification only — no code changes)

**HITL**: No — AFK  
**Prerequisite**: Task 5

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: TypeScript compilation succeeds without errors

- [ ] **Step 2: Lint check**

Run: `pnpm lint`
Expected: No linting errors (or only pre-existing warnings unrelated to our changes)

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: All tests PASS (at least 29 tests: 10 url-normalizer + 8 passage-extractor + 5 content-mode + 6 content-utils + 11 scrape-client minus the content-mode tests that now import from source)

Note: The `tests/content-mode.test.ts` file defines a local `stripMarkdownFromData` function that is now duplicated by `src/content-utils.ts`. The old test suite should still pass (it tests its local copy). A future cleanup task can migrate these tests to use the shared import.

- [ ] **Step 4: Verify tool list (manual check)**

Run the MCP server and verify the `ListTools` response includes `research` and does NOT include `search_and_scrape`:

```bash
# Start the server briefly and inspect tool list
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | timeout 5 npx tsx src/index.ts 2>/dev/null || true
```

Manual verification: check that the output shows three tools: `search_web`, `scrape_url`, and `research`. Verify `search_and_scrape` is absent.

- [ ] **Step 5: Commit verification results**

If all steps pass:

```bash
git add -A
git diff --cached --stat
git commit -m "verify: research tool integration — build, lint, tests all passing"
```

If any step fails: stop, diagnose, fix, then commit.

---

## Phase C (Future) — Deep Mode

Not included in this plan. Reserved for a future implementation plan.

**Summary of Phase C scope:**
- `handleDeepResearch()` method: map → crawl → poll → BM25 aggregate
- `deep` + `single`: pick best search result, map its site, crawl ≤10 pages, aggregate BM25
- `deep` + `multi`: map + crawl top 3 results, aggregate across all crawled pages
- CRW crawl polling loop with 60s timeout, 3s interval
- `max_pages` parameter enforcement
- Crawl job status tracking in `research_metadata`
- Composite caching for deep results

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] `depth: "quick"` + `breadth: "single"` — search snippets, 1 best result → Task 4 (handleQuickResearch, resultCount=1)
   - [x] `depth: "quick"` + `breadth: "multi"` — search snippets, top 5 → Task 4 (handleQuickResearch, resultCount=5)
   - [x] `depth: "normal"` + `breadth: "single"` — scrape top 3, BM25 → Task 4 (handleNormalResearch, 3 URLs)
   - [x] `depth: "normal"` + `breadth: "multi"` — scrape top 5, BM25 → Task 4 (handleNormalResearch, 5 URLs)
   - [x] Replace search_and_scrape → Task 5
   - [x] Keep search_web and scrape_url unchanged → verified in Tasks 5-6
   - [x] Reuse existing code (cachedScrapeUrl, normalizeUrl, extractRelevantPassages, RedisCache) → Task 4 delegates to existing primitives
   - [x] content_mode parameter → Task 4 (passed through, stripMarkdownFromData used)
   - [x] Response includes research metadata → Task 4 (research_metadata block)
   - [x] Deep mode designed but not implemented → Phase C summary

2. **Placeholder scan:** No TBDs, no TODOs, no "implement later" in code steps. All steps contain actual code.

3. **Type consistency:**
   - `ContentMode` type defined in `src/content-utils.ts`, imported in `src/index.ts` ✓
   - `MapOptions`, `MapResponse`, `CrawlOptions`, `CrawlAcceptedResponse`, `CrawlStatusResponse` defined and exported from `src/scrape-client.ts` ✓
   - `stripMarkdownFromData` signature consistent between definition and usage ✓
   - `handleResearch` → `handleQuickResearch` / `handleNormalResearch` signatures match call sites ✓
   - `ResearchResponse` shape consistent across all return paths ✓
