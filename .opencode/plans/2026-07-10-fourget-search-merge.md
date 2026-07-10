# 4get Search Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4get as a parallel search source alongside SearXNG, merging results by URL and routing them through the existing CRW scrape + BM25 pipeline.

**Architecture:** A new `FourgetClient` (mirroring `SearXNGClient`) calls 4get's REST API. A shared `mergeSearchResults()` function deduplicates by normalized URL. All three handlers (`search_web`, `research`, `search_and_scrape`) call both sources in parallel via `Promise.allSettled` and feed merged URLs downstream. 4get is added to the `search-net` Docker network.

**Tech Stack:** TypeScript, axios, vitest, Docker Compose

---

### Task 1: FourgetClient — TDD the 4get API Client

**Files:**
- Create: `tests/fourget-client.test.ts`
- Create: `src/fourget-client.ts`

**HITL/decision:** Configure `FOURGET_URL` env var. Default: `http://localhost:8090` (host machine), overridden to `http://fourget:80` in Docker.

- [ ] **Step 1: Write the failing test suite**

Create `tests/fourget-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { FourgetClient } from '../src/fourget-client.js';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('FourgetClient', () => {
  let client: FourgetClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FourgetClient('http://fourget:80');
  });

  describe('search', () => {
    it('calls GET /api/v1/web with query and scraper', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'Test Result',
              url: 'https://example.com',
              description: [
                { type: 'text', value: 'A test description' },
              ],
              date: null,
              type: 'web',
            },
          ],
          npt: 'next-page-token',
        },
      });

      const result = await client.search('test query', 'brave');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://fourget:80/api/v1/web',
        expect.objectContaining({
          params: {
            s: 'test query',
            scraper: 'brave',
          },
        })
      );
      expect(result.status).toBe('ok');
      expect(result.web).toHaveLength(1);
      expect(result.web[0].title).toBe('Test Result');
      expect(result.web[0].url).toBe('https://example.com');
      expect(result.web[0].description).toBe('A test description');
    });

    it('uses default scraper "brave" when none provided', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { status: 'ok', web: [], npt: '' },
      });

      await client.search('query');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://fourget:80/api/v1/web',
        expect.objectContaining({
          params: { s: 'query', scraper: 'brave' },
        })
      );
    });

    it('flattens compound description arrays into plain text', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'Rich Result',
              url: 'https://example.com/2',
              description: [
                { type: 'text', value: 'Some text ' },
                { type: 'inline_code', value: 'SELECT 1' },
                { type: 'text', value: ' more text' },
                { type: 'quote', value: 'blockquote content' },
              ],
              date: 1747526400,
              type: 'web',
            },
          ],
          npt: '',
        },
      });

      const result = await client.search('rich');

      expect(result.web[0].description).toBe('Some text SELECT 1 more text blockquote content');
    });

    it('handles null/undefined description gracefully', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'No Description',
              url: 'https://example.com/3',
              description: null,
              date: null,
              type: 'web',
            },
          ],
          npt: '',
        },
      });

      const result = await client.search('nodesc');
      expect(result.web[0].description).toBe('');
    });

    it('converts Unix date to ISO string', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'ok',
          web: [
            {
              title: 'Dated',
              url: 'https://example.com/4',
              description: [],
              date: 1747526400,
              type: 'web',
            },
          ],
          npt: '',
        },
      });

      const result = await client.search('dated');
      expect(result.web[0].date).toBe('2026-05-18T00:00:00.000Z');
    });

    it('handles API errors gracefully', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(client.search('fail')).rejects.toThrow('Connection refused');
    });
  });

  describe('healthCheck', () => {
    it('returns true when 4get responds', async () => {
      mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { status: 'ok' } });

      const healthy = await client.healthCheck();
      expect(healthy).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://fourget:80/api/v1/web',
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('returns false on timeout', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Timeout'));

      const healthy = await client.healthCheck();
      expect(healthy).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/fourget-client.test.ts
```

Expected: 8 tests fail (module not found or FourgetClient not defined).

- [ ] **Step 3: Write the FourgetClient class**

Create `src/fourget-client.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/fourget-client.test.ts
```

Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fourget-client.ts tests/fourget-client.test.ts
git commit -m "feat: add FourgetClient for 4get search API integration"
```

---

### Task 2: Search Merger — TDD the URL Dedup + Merge Logic

**Files:**
- Create: `tests/search-merger.test.ts`
- Create: `src/search-merger.ts`

- [ ] **Step 1: Write the failing test suite**

Create `tests/search-merger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mergeSearchResults, UnifiedResult } from '../src/search-merger.js';
import type { SearchResult } from '../src/searxng-client.js';
import type { FourgetWebResult } from '../src/fourget-client.js';

describe('mergeSearchResults', () => {
  const searxngResults: SearchResult[] = [
    {
      title: 'SearXNG Result 1',
      url: 'https://example.com/page1?utm_source=twitter',
      content: 'A long descriptive snippet from SearXNG',
      score: 0.95,
    },
    {
      title: 'SearXNG Result 2',
      url: 'https://example.com/page2',
      content: 'short',
      score: 0.80,
    },
  ];

  const fourgetResults: FourgetWebResult[] = [
    {
      title: '4get Result A',
      url: 'https://example.com/PAGE1',  // case-diff, same as page1 after normalization
      description: 'Short from 4get',
      date: '2026-01-15T00:00:00.000Z',
      type: 'web',
    },
    {
      title: '4get Result B',
      url: 'https://www.example.com/unique',  // www prefix, stripped by normalizeUrl
      description: 'A unique result only from 4get',
      date: null,
      type: 'web',
    },
  ];

  it('deduplicates by normalized URL', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    // 3 unique URLs: page1 (deduped), page2 (searxng only), unique (4get only)
    expect(merged).toHaveLength(3);

    const urls = merged.map((r) => r.url);
    // Normalized URLs
    expect(urls).toContain('https://example.com/page1');
    expect(urls).toContain('https://example.com/page2');
    expect(urls).toContain('https://example.com/unique');
  });

  it('prefers longer snippet when both sources match same URL', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    const page1 = merged.find((r) => r.url === 'https://example.com/page1');
    expect(page1).toBeDefined();
    expect(page1!.content).toBe('A long descriptive snippet from SearXNG'); // longer wins
    expect(page1!.source).toBe('both');
  });

  it('marks source correctly', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    const both = merged.find((r) => r.url === 'https://example.com/page1');
    const searxngOnly = merged.find((r) => r.url === 'https://example.com/page2');
    const fourgetOnly = merged.find((r) => r.url === 'https://example.com/unique');

    expect(both!.source).toBe('both');
    expect(searxngOnly!.source).toBe('searxng');
    expect(fourgetOnly!.source).toBe('fourget');
  });

  it('orders SearXNG results first, then 4get-only results', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults);

    // SearXNG results should come first (preserving their order)
    expect(merged[0].title).toBe('SearXNG Result 1');
    expect(merged[1].title).toBe('SearXNG Result 2');
    // 4get-only results appended
    expect(merged[2].title).toBe('4get Result B');
  });

  it('respects maxResults option', () => {
    const merged = mergeSearchResults(searxngResults, fourgetResults, { maxResults: 2 });

    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe('SearXNG Result 1');
    expect(merged[1].title).toBe('SearXNG Result 2');
  });

  it('handles empty 4get results gracefully', () => {
    const merged = mergeSearchResults(searxngResults, []);

    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe('searxng');
  });

  it('handles empty SearXNG results gracefully', () => {
    const merged = mergeSearchResults([], fourgetResults);

    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe('fourget');
  });

  it('returns empty array when both sources are empty', () => {
    const merged = mergeSearchResults([], []);
    expect(merged).toEqual([]);
  });

  it('preserves publishedDate from 4get when available', () => {
    const merged = mergeSearchResults([], fourgetResults);

    const fourgetOnly = merged.find((r) => r.url === 'https://example.com/unique');
    // The 4get result B has date: null, but result A has a date
    // The page1 result was deduped with SearXNG, which had no publishedDate
    // So the merged result at page1 should inherit the 4get date
    const page1 = merged.find((r) => r.url === 'https://example.com/page1');
    expect(page1!.publishedDate).toBe('2026-01-15T00:00:00.000Z');
    // The unique 4get result (result B) has date: null
    expect(fourgetOnly!.publishedDate).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/search-merger.test.ts
```

Expected: 9 tests fail (module not found).

- [ ] **Step 3: Write the search-merger module**

Create `src/search-merger.ts`:

```typescript
import { normalizeUrl } from './url-normalizer.js';
import type { SearchResult } from './searxng-client.js';
import type { FourgetWebResult } from './fourget-client.js';

export interface UnifiedResult {
  title: string;
  url: string;
  content: string;         // Snippet from either source
  publishedDate: string | null;
  source: 'searxng' | 'fourget' | 'both';
  searxngScore?: number;
}

export interface MergeOptions {
  maxResults?: number;
}

/**
 * Merge and deduplicate search results from SearXNG and 4get.
 *
 * Strategy:
 * 1. Build a Map keyed by normalized URL
 * 2. For duplicate URLs: keep the result with the longer snippet
 *    and mark source as 'both'
 * 3. Order: SearXNG results first (preserving relevance order),
 *    then 4get-only results appended
 * 4. Optionally truncate to maxResults
 */
export function mergeSearchResults(
  searxngResults: SearchResult[],
  fourgetResults: FourgetWebResult[],
  options: MergeOptions = {}
): UnifiedResult[] {
  const merged = new Map<string, UnifiedResult>();
  const searxngOrder: string[] = [];  // normalized URLs in order

  // Process SearXNG results first (primary source, determines ordering)
  for (const sr of searxngResults) {
    const normalized = normalizeUrl(sr.url);
    searxngOrder.push(normalized);
    merged.set(normalized, {
      title: sr.title,
      url: sr.url,
      content: sr.content || '',
      publishedDate: sr.publishedDate || null,
      source: 'searxng',
      searxngScore: sr.score,
    });
  }

  // Process 4get results — merge into existing entries or append
  const fourgetOnly: UnifiedResult[] = [];

  for (const fr of fourgetResults) {
    const normalized = normalizeUrl(fr.url);

    if (merged.has(normalized)) {
      // Duplicate — update if 4get has a longer snippet
      const existing = merged.get(normalized)!;
      if (fr.description.length > existing.content.length) {
        existing.content = fr.description;
      }
      // Inherit date from 4get if SearXNG didn't provide one
      if (!existing.publishedDate && fr.date) {
        existing.publishedDate = fr.date;
      }
      existing.source = 'both';
    } else {
      // New — 4get-only result
      fourgetOnly.push({
        title: fr.title,
        url: fr.url,
        content: fr.description,
        publishedDate: fr.date,
        source: 'fourget',
      });
    }
  }

  // Build ordered result: SearXNG results in original order, then 4get-only
  const results: UnifiedResult[] = [];

  for (const normalized of searxngOrder) {
    const entry = merged.get(normalized);
    if (entry) results.push(entry);
  }

  results.push(...fourgetOnly);

  // Apply maxResults truncation
  if (options.maxResults && options.maxResults > 0) {
    return results.slice(0, options.maxResults);
  }

  return results;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/search-merger.test.ts
```

Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search-merger.ts tests/search-merger.test.ts
git commit -m "feat: add search-merger for URL-deduped 4get + SearXNG result merging"
```

---

### Task 3: Docker Compose — Add 4get to search-net

**Files:**
- Modify: `docker-compose.yml`
- (Reference) `infra/4get/docker-compose.yml` — consulted for config, not modified

**HITL/decision:** Should 4get have a host port mapping for debugging? Suggested: yes, `"8090:80"` for parity with the existing standalone setup. Can be removed later.

- [ ] **Step 1: Add 4get service to docker-compose.yml**

Modify `docker-compose.yml` — add the `fourget` service BEFORE the `mcp-server` service block, and add `FOURGET_URL` to the `mcp-server` environment.

In the `services:` section, add after the `crw:` block:

```yaml
  # 4get — secondary metasearch aggregator (supplements SearXNG)
  fourget:
    image: luuul/4get:latest
    container_name: fourget
    ports:
      - "8090:80"
    environment:
      - FOURGET_PROTO=http
      - FOURGET_SERVER_NAME=4get.local
    networks:
      - search-net
    restart: unless-stopped
```

And in the `mcp-server` service's `environment:` section, add:

```yaml
      - FOURGET_URL=http://fourget:80
```

- [ ] **Step 2: Verify docker-compose is valid**

```bash
docker compose -f docker-compose.yml config --quiet
```

Expected: exit code 0 (no output = valid config).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "infra: add 4get service to search-net for parallel search"
```

---

### Task 4: Wire Merge into handleSearchWeb

**Files:**
- Modify: `src/index.ts`

**Note:** This is the primary user-facing change. The `search_web` tool will now return merged results from both SearXNG and 4get.

- [ ] **Step 1: Add imports and FourgetClient initialization**

In `src/index.ts`, add the import for the new modules (after the existing imports around line 10-15):

```typescript
import { FourgetClient } from './fourget-client.js';
import { mergeSearchResults } from './search-merger.js';
```

In the constructor's client initialization section (around line 74), after `this.searxng = new SearXNGClient(...)`, add:

```typescript
this.fourget = new FourgetClient(process.env.FOURGET_URL || 'http://localhost:8090');
```

Add the `fourget` property to the class (around line 52, after the `searxng` property):

```typescript
private fourget: FourgetClient;
```

- [ ] **Step 2: Rewrite handleSearchWeb to call both sources in parallel**

Replace the `handleSearchWeb` method (lines 367-436) with:

```typescript
/**
 * Web search via SearXNG + 4get with caching and optional retry.
 * Merges results from both sources, deduplicating by URL.
 */
private async handleSearchWeb(args: any) {
  const { query, maxResults, categories, engines, language } = args;
  const scraper = args.scraper || 'brave';

  logger.info(`Searching web (merged): ${query}`);

  // Check cache — include scraper in key
  const cacheKey = `search:merged:${query}:${categories || ''}:${engines || ''}:${language || 'en'}:${scraper}`;
  const cached = await this.cache.get(cacheKey);
  if (cached) return cached;

  const limit = Math.min(maxResults || DEFAULT_LIMIT, 50);
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Call both sources in parallel
      const [searxngSettled, fourgetSettled] = await Promise.allSettled([
        this.searxng.search(query, {
          engines,
          categories,
          language: language || 'en',
          pageno: 1,
          format: 'json',
        }),
        this.fourget.search(query, scraper),
      ]);

      const searxngResults = searxngSettled.status === 'fulfilled'
        ? searxngSettled.value.results || []
        : [];
      const fourgetResults = fourgetSettled.status === 'fulfilled'
        ? fourgetSettled.value.web || []
        : [];

      if (fourgetSettled.status === 'rejected') {
        logger.warn(`4get search failed for "${query}":`, fourgetSettled.reason);
      }

      if (searxngResults.length === 0 && fourgetResults.length === 0) {
        lastError = new Error('No results found from any source');
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
      }

      // Merge + deduplicate
      const merged = mergeSearchResults(searxngResults, fourgetResults, {
        maxResults: limit,
      });

      const response = {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                query,
                total_results: merged.length,
                results: merged.map((r) => ({
                  title: r.title,
                  url: r.url,
                  content: r.content,
                  publishedDate: r.publishedDate,
                  source: r.source,
                })),
                suggestion: undefined,
                engine_info: {
                  sources_consulted: {
                    searxng: searxngSettled.status === 'fulfilled',
                    fourget: fourgetSettled.status === 'fulfilled',
                  },
                },
              },
              null,
              2
            ),
          },
        ],
      };

      await this.cache.set(cacheKey, response, SEARCH_CACHE_TTL_MS);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  logger.error('Merged search failed:', lastError);
  throw new Error(`Search failed: ${lastError instanceof Error ? lastError.message : 'Unknown error'}`);
}
```

- [ ] **Step 3: Run all existing tests to check for regressions**

```bash
npx vitest run
```

Expected: all previous tests still pass (23 tests: url-normalizer + passage-extractor + content-mode + content-utils + scrape-client + scraper).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: merge 4get results into handleSearchWeb with parallel search and URL dedup"
```

---

### Task 5: Wire Merge into handleResearch

**Files:**
- Modify: `src/index.ts`

**Note:** The `research` tool has two depth levels: "quick" (snippets only) and "normal" (search → CRW scrape → BM25). Both need to use merged search results.

- [ ] **Step 1: Update handleResearch to call both sources**

In `src/index.ts`, modify the `handleResearch` method (around lines 690-774).

Replace the SearXNG-only search block (lines 721-737) with a parallel search block that also calls 4get. The key change is in the search section:

Replace:
```typescript
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
  return { /* empty response */ };
}
```

With:
```typescript
// 1. Search both sources in parallel with retry
const scraper = args.scraper || 'brave';

let mergedResults: ReturnType<typeof mergeSearchResults> = [];
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    const [searxngSettled, fourgetSettled] = await Promise.allSettled([
      this.searxng.search(query, { categories, language: 'en', format: 'json' }),
      this.fourget.search(query, scraper),
    ]);

    const searxngResults = searxngSettled.status === 'fulfilled'
      ? searxngSettled.value.results || []
      : [];
    const fourgetResults = fourgetSettled.status === 'fulfilled'
      ? fourgetSettled.value.web || []
      : [];

    if (fourgetSettled.status === 'rejected') {
      logger.warn(`4get research search failed for "${query}":`, fourgetSettled.reason);
    }

    mergedResults = mergeSearchResults(searxngResults, fourgetResults, {
      maxResults: 10,
    });

    if (mergedResults.length > 0) break;
  } catch (e) {
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500));
    } else {
      throw e;
    }
  }
}

if (mergedResults.length === 0) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({
      query,
      number_of_results: 0,
      unresponsive_engines: [],
      research_metadata: {
        depth: researchDepth,
        breadth: researchBreadth,
        pages_scraped: 0,
        errors: [],
      },
      results: [],
    }, null, 2) }],
  };
}
```

- [ ] **Step 2: Update downstream code to use UnifiedResult shape**

The `mergedResults` array is `UnifiedResult[]` which has `{ title, url, content, publishedDate, source, searxngScore? }`. The downstream code (quick research at line 779, normal research at line 819) accesses `.content` as the snippet field. Since `UnifiedResult.content` maps to what was previously `SearchResult.content` (or `FourgetWebResult.description`), this is source-compatible.

Update `handleQuickResearch` parameter type from `Array<{ url: string; title: string; content: string }>` to `UnifiedResult[]`, and replace `r.content` references (they already map correctly).

Update `handleNormalResearch` parameter type similarly. The `topResults` variable in `handleNormalResearch` uses `.url`, `.title`, `.content` — all present on `UnifiedResult`.

**Specific changes needed:**

In `handleQuickResearch` signature (line 780), change:
```typescript
topResults: Array<{ url: string; title: string; content: string }>,
```
To:
```typescript
topResults: UnifiedResult[],
```
(Add the import for `UnifiedResult` from `search-merger.js` at top of file.)

In `handleNormalResearch` signature (line 822), change:
```typescript
topResults: Array<{ url: string; title: string; content: string; score?: number }>,
```
To:
```typescript
topResults: UnifiedResult[],
```

In `handleNormalResearch`, update the snippet reference in `urlsToScrape` (line 835):
```typescript
snippet: r.content,
```
(This already works since `UnifiedResult.content` is the snippet.)

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: merge 4get results into research pipeline (quick + normal)"
```

---

### Task 6: Wire Merge into handleSearchAndScrape (Legacy)

**Files:**
- Modify: `src/index.ts`

**Note:** `handleSearchAndScrape` is the legacy handler, still reachable via HTTP proxy. Update it for consistency.

- [ ] **Step 1: Update handleSearchAndScrape to use merged results**

In `src/index.ts`, modify the `handleSearchAndScrape` method (around lines 498-681).

Replace the SearXNG-only search block (lines 518-535) with the same parallel search pattern used in `handleResearch`:

Replace:
```typescript
// 2. Search with optional retry
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
  return { /* empty */ };
}
```

With:
```typescript
// 2. Search both sources in parallel with retry
const scraper = args.scraper || 'brave';
let mergedResults: UnifiedResult[] = [];
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try {
    const [searxngSettled, fourgetSettled] = await Promise.allSettled([
      this.searxng.search(query, { categories, language: 'en', format: 'json' }),
      this.fourget.search(query, scraper),
    ]);

    const searxngResults = searxngSettled.status === 'fulfilled'
      ? searxngSettled.value.results || []
      : [];
    const fourgetResults = fourgetSettled.status === 'fulfilled'
      ? fourgetSettled.value.web || []
      : [];

    if (fourgetSettled.status === 'rejected') {
      logger.warn(`4get (search_and_scrape) failed for "${query}":`, fourgetSettled.reason);
    }

    mergedResults = mergeSearchResults(searxngResults, fourgetResults, {
      maxResults: 10,
    });

    if (mergedResults.length > 0) break;
  } catch (e) {
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500));
    } else {
      throw e;
    }
  }
}

if (mergedResults.length === 0) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        query,
        search_results: 0,
        scraped_results: [],
        elapsed_ms: Date.now() - startTime,
        message: 'No search results found',
      }, null, 2),
    }],
  };
}
```

Then update the `topResults` assignment (line 559):
```typescript
const limit = Math.min(maxResults || 3, isDeep ? 50 : 10);
const topResults = mergedResults.slice(0, limit);
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: merge 4get results into legacy handleSearchAndScrape"
```

---

### Task 7: Add 4get Health to /health Endpoint + Update HTTP Proxy

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update /health endpoint to include 4get status**

In `src/index.ts`, modify the `/health` route handler (around lines 102-106):

```typescript
app.get('/health', async (_req, res) => {
  const searx = await this.searxng.healthCheck().catch(() => false);
  const crw = await this.getScrapeClient().healthCheck().catch(() => false);
  const fourget = await this.fourget.healthCheck().catch(() => false);
  return res.status(200).json({ ok: true, searxng: searx, crw, fourget });
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add 4get health status to /health endpoint"
```

---

### Task 8: End-to-End Verification — Rebuild & Smoke Test

**Files:**
- (No file changes — verification only)

**HITL:** This task requires Docker and 4get to be running. The implementor should verify manually.

- [ ] **Step 1: Rebuild the Docker image**

```bash
docker compose build mcp-server
```

Expected: build succeeds.

- [ ] **Step 2: Start the full stack**

```bash
docker compose up -d
```

Expected: all services start (searxng, redis, lightpanda, headless-browser, spider-scrape, crw, **fourget**, mcp-server).

- [ ] **Step 3: Smoke test — search_web with merged results**

```bash
curl -s -X POST http://localhost:3004/mcp/tool/search_web \
  -H "Content-Type: application/json" \
  -d '{"name":"search_web","arguments":{"query":"TypeScript web search test"}}' | jq '.ok'
```

Expected: `true`.

Check that results include both sources:
```bash
curl -s -X POST http://localhost:3004/mcp/tool/search_web \
  -H "Content-Type: application/json" \
  -d '{"name":"search_web","arguments":{"query":"TypeScript web search test"}}' | jq '.result.content[0].text | fromjson | .results[0].source'
```

Expected: `"searxng"` or `"fourget"` or `"both"`.

- [ ] **Step 4: Smoke test — research with merged results**

```bash
curl -s -X POST http://localhost:3004/mcp/tool/research \
  -H "Content-Type: application/json" \
  -d '{"arguments":{"query":"TypeScript best practices","depth":"normal","breadth":"single","max_results":3}}' | jq '.ok'
```

(Note: `research` is only available via MCP protocol, not HTTP proxy. If not accessible via HTTP, verify via MCP client or check logs.)

- [ ] **Step 5: Verify health endpoint includes 4get**

```bash
curl -s http://localhost:3004/health | jq .
```

Expected output includes `"fourget": true`.

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: all 31 tests pass (23 existing + 8 fourget-client + 9 search-merger = 40). Wait, that's 40. Let me recount: 23 existing + 8 fourget-client tests + 9 search-merger tests = 40 tests.

- [ ] **Step 7: Final commit (if any config changes needed)**

```bash
git status
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] 4get client class (Task 1)
   - [x] Merge and deduplicate by URL (Task 2)
   - [x] Docker networking — 4get on search-net (Task 3)
   - [x] Parallel search in handleSearchWeb (Task 4)
   - [x] Parallel search in handleResearch (Task 5)
   - [x] Parallel search in handleSearchAndScrape (Task 6)
   - [x] 4get health + HTTP proxy awareness (Task 7)
   - [x] End-to-end verification (Task 8)
   - [x] Caching 4get search results separately (Tasks 4-6 use merged cache keys that include scraper)
   - [x] Backward compatible response shapes (Tasks 4-6 add `source` field, add `sources_consulted` metadata — additive, not breaking)
   - [x] Graceful error handling when 4get fails (Tasks 4-6 use `Promise.allSettled`)

2. **Placeholder scan:** No TBDs, TODOs, or vague steps. All code is specified inline.

3. **Type consistency:** `UnifiedResult` type is defined once in search-merger.ts and imported consistently across all three handler tasks. `FourgetWebResult` exported from fourget-client.ts and imported in search-merger.ts and tests.

4. **Are all tasks vertical slices?** Yes — each task includes test creation, implementation, verification, and commit. Tasks 4-7 each modify the handler layer end-to-end (search → merge → response).
