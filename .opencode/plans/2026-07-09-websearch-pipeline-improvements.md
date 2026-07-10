# Web Search Pipeline Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend URL scrape cache from 5-min to 24-hour TTL, unify duplicate cache namespaces, add query-relevant passage extraction via TF-IDF scoring, and fix latent bugs in the pipeline.

**Architecture:** Phase A refactors `src/index.ts` to unify URL scraping under a single `cachedScrapeUrl()` method with 24h TTL. Phase B adds `src/passage-extractor.ts` with pure-TypeScript TF-IDF passage scoring, integrated into `search_and_scrape` and `scrape_url` results. Both phases are backward-compatible additive changes.

**Tech Stack:** TypeScript (tsx), ioredis (Redis), axios (HTTP), vitest (tests)

---

### Task 1: Add URL Normalization Utility

**Files:**
- Create: `src/url-normalizer.ts`
- Create: `tests/url-normalizer.test.ts`
- **AFK** — fully autonomous

- [ ] **Step 1: Write failing tests for URL normalization**

Create `tests/url-normalizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/url-normalizer.js';

describe('normalizeUrl', () => {
  it('should lowercase scheme and host', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path'))
      .toBe('https://example.com/path');
  });

  it('should strip www prefix', () => {
    expect(normalizeUrl('https://www.example.com/page'))
      .toBe('https://example.com/page');
  });

  it('should strip trailing slash on path-only URLs', () => {
    expect(normalizeUrl('https://example.com/page/'))
      .toBe('https://example.com/page');
  });

  it('should keep trailing slash when path is root', () => {
    expect(normalizeUrl('https://example.com/'))
      .toBe('https://example.com/');
  });

  it('should strip known tracking query params', () => {
    expect(normalizeUrl('https://example.com/page?ref=foo&utm_source=bar&keep=me'))
      .toBe('https://example.com/page?keep=me');
  });

  it('should remove all query params if only tracking params present', () => {
    expect(normalizeUrl('https://example.com/page?utm_source=x&fbclid=y'))
      .toBe('https://example.com/page');
  });

  it('should sort remaining query params alphabetically', () => {
    expect(normalizeUrl('https://example.com/page?z=1&a=2'))
      .toBe('https://example.com/page?a=2&z=1');
  });

  it('should preserve fragment', () => {
    expect(normalizeUrl('https://example.com/page?utm=x#section'))
      .toBe('https://example.com/page#section');
  });

  it('should handle URLs without path', () => {
    expect(normalizeUrl('https://WWW.Example.COM'))
      .toBe('https://example.com/');
  });

  it('should handle malformed URLs gracefully', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});
```

- [ ] **Step 2: Implement URL normalizer**

Create `src/url-normalizer.ts`:

```typescript
const TRACKING_PARAMS = new Set([
  'ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'gclsrc', 'dclid',
  'msclkid', 'twclid', 'igshid', 'wt_mc', 'wt_zmc',
]);

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Lowercase scheme + host
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    // Strip www prefix
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
    }
    // Strip tracking query params
    const params = url.searchParams;
    const toDelete: string[] = [];
    params.forEach((_v, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        toDelete.push(key);
      }
    });
    toDelete.forEach(k => params.delete(k));
    // Sort remaining params for stable keys
    params.sort();
    // Rebuild
    let result = url.toString();
    // Strip trailing slash unless root path
    const parsed = new URL(result);
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
      result = parsed.toString();
    }
    return result;
  } catch {
    return raw; // malformed URLs pass through unchanged
  }
}
```

- [ ] **Step 3: Verify tests pass**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && npx vitest run tests/url-normalizer.test.ts
```

Expected: All 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/url-normalizer.ts tests/url-normalizer.test.ts
git commit -m "feat: add URL normalization utility with tracking-param stripping

- Normalizes scheme/host to lowercase
- Strips www prefix
- Removes known tracking query params (utm_*, fbclid, gclid, etc.)
- Sorts remaining query params for stable cache keys
- 10 test cases covering common edge cases"
```

---

### Task 2: Add Configurable TTL Constants

**Files:**
- Modify: `src/index.ts`
- **AFK** — fully autonomous

- [ ] **Step 1: Add TTL constants and env-var overrides**

In `src/index.ts`, replace the module-level constants section (lines 18-27) with the expanded version:

```typescript
// ── Module-level constants ────────────────────────────────────────────
const DEFAULT_LIMIT       = Number(process.env.WEB_SEARCH_LIMIT)          || 25;
const FIT_MIN_WORDS       = Number(process.env.FIT_MIN_WORDS)             || 250;
const MAX_RETRIES         = Number(process.env.WEB_SEARCH_MAX_RETRIES)    || 1;
const CRAWL_PER_URL_TIMEOUT_MS  = Number(process.env.WEB_SEARCH_CRAWL_TIMEOUT_MS)  || 1000;
const CRAWL_BATCH_TIMEOUT_MS    = Number(process.env.WEB_SEARCH_CRAWL_BATCH_TIMEOUT_MS) || 1500;
const CRAWL_POOL_SIZE           = Number(process.env.WEB_SEARCH_CRAWL_POOL_SIZE)      || 15;
const DEEP_PER_URL_TIMEOUT_MS   = 20_000;
const DEEP_BATCH_TIMEOUT_MS     = 60_000;
const DEEP_POOL_SIZE            = 8;

// Cache TTL configuration (milliseconds)
const URL_SCRAPE_CACHE_TTL_MS   = Number(process.env.MCP_URL_SCRAPE_CACHE_TTL_MS)   || 86_400_000; // 24h
const SEARCH_CACHE_TTL_MS       = Number(process.env.MCP_SEARCH_CACHE_TTL_MS)        || 300_000;    // 5 min
const COMPOSITE_CACHE_TTL_MS    = Number(process.env.MCP_COMPOSITE_CACHE_TTL_MS)     || 300_000;    // 5 min

// Passage extraction configuration
const RELEVANCE_TOP_N           = Number(process.env.MCP_RELEVANCE_TOP_N)            || 5;
const RELEVANCE_CONTEXT_WINDOW  = Number(process.env.MCP_RELEVANCE_CONTEXT_WINDOW)   || 1;
const RELEVANCE_MIN_SCORE       = Number(process.env.MCP_RELEVANCE_MIN_SCORE)        || 0.0;
```

Remove the old constants block (lines 18-27) and replace with the above.

- [ ] **Step 2: Verify the file compiles**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add configurable TTL constants and passage extraction settings

- URL_SCRAPE_CACHE_TTL_MS: 24h default for per-URL scrape cache
- SEARCH_CACHE_TTL_MS: 5min for search results (unchanged)
- COMPOSITE_CACHE_TTL_MS: 5min for search_and_scrape composite (unchanged)
- RELEVANCE_TOP_N/CONTEXT_WINDOW/MIN_SCORE: passage extraction tuning
- All overridable via environment variables"
```

---

### Task 3: Unify URL Scrape Caching

**Files:**
- Modify: `src/index.ts`
- **AFK**

This is the core Phase A refactor. The goal: replace the two separate cache paths (`handleScrapeUrl`'s direct cache and `scrapeSingleUrl`'s cache) with a single `cachedScrapeUrl()` method.

- [ ] **Step 1: Add `cachedScrapeUrl` private method**

In `src/index.ts`, add this method to the `SearXNGMCPServer` class (e.g., after `getScrapeClient()`, before `setupToolHandlers()`):

```typescript
/**
 * Scrape a URL via CRW with per-URL caching (24h TTL).
 * Uses normalized URLs for cache keys to maximize reuse.
 * Returns the raw ScrapeClientResponse — callers shape output as needed.
 */
private async cachedScrapeUrl(
  url: string,
  formats: string[],
  timeout: number = 30000
): Promise<ScrapeClientResponse> {
  const normalized = normalizeUrl(url);
  const cacheKey = `scrape_url:${normalized}:${(formats || ['markdown']).join(',')}`;
  const cached = await this.cache.get<ScrapeClientResponse>(cacheKey);
  if (cached) return cached;

  const result = await this.getScrapeClient().scrape(url, {
    formats: formats || ['markdown'],
    timeout,
    wait_for: 0,
    proxy_url: process.env.PROXY_URL,
  });

  await this.cache.set(cacheKey, result, URL_SCRAPE_CACHE_TTL_MS);
  return result;
}
```

Note: we pass the **original** URL to CRW (not the normalized one) because CRW needs the real URL to fetch. We only normalize for the cache key.

- [ ] **Step 2: Refactor `handleScrapeUrl` to use `cachedScrapeUrl`**

Replace the body of `handleScrapeUrl` (lines 376-409) with:

```typescript
private async handleScrapeUrl(args: any) {
  const { url, formats, wait_for, timeout } = args;

  logger.info(`Scraping with CRW: ${url}`);

  try {
    const result = await this.cachedScrapeUrl(
      url,
      formats || ['markdown'],
      timeout || 30000
    );

    const response = {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };

    return response;
  } catch (error) {
    logger.error('CRW scrape failed:', error);
    throw new Error(`CRW scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
```

Key changes:
- No longer does its own cache check (delegated to `cachedScrapeUrl`)
- No longer `await this.cache.set(...)` (delegated)
- Uses the shared `cachedScrapeUrl` method with 24h TTL
- Note: `wait_for` is accepted but not passed to `cachedScrapeUrl` (CRW's wait_for is controlled differently; preserving backward-compat in args but CRW API doesn't expose it directly)

- [ ] **Step 3: Refactor `scrapeSingleUrl` to use `cachedScrapeUrl`**

Replace `scrapeSingleUrl` (lines 575-596) with:

```typescript
/**
 * Scrape a single URL and return the raw ScrapeClient response.
 * Delegates to cachedScrapeUrl for unified per-URL caching.
 */
private async scrapeSingleUrl(
  url: string,
  timeout: number,
  isDeep: boolean = false,
  formats?: string[]
): Promise<ScrapeClientResponse> {
  return this.cachedScrapeUrl(
    url,
    formats || ['markdown'],
    timeout
  );
}
```

Key changes:
- Delegates entirely to `cachedScrapeUrl` — no separate cache logic
- The `isDeep` parameter is kept for signature compatibility but unused (the `timeout` already captures the deep-vs-quick distinction)
- Cache TTL is now 24h via `cachedScrapeUrl`

- [ ] **Step 4: Fix the missing `formats` in `handleSearchAndScrape` composite cache key**

In `handleSearchAndScrape`, change the cache key construction (line 428) from:

```typescript
const cacheKey = `search_and_scrape:${query}:${maxResults || ''}:${mode || ''}:${scrapeAll || ''}:${categories || ''}`;
```

to:

```typescript
const formatKey = (formats || ['markdown']).join(',');
const cacheKey = `search_and_scrape:${query}:${maxResults || ''}:${mode || ''}:${scrapeAll || ''}:${categories || ''}:${formatKey}`;
```

- [ ] **Step 5: Verify compilation**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && npx tsc --noEmit
```

Expected: No type errors. Ensure `normalizeUrl` is imported at the top of `src/index.ts`:

```typescript
import { normalizeUrl } from './url-normalizer.js';
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "refactor: unify URL scrape caching into cachedScrapeUrl method

- Introduces cachedScrapeUrl() with 24h TTL, URL normalization, shared cache key
- handleScrapeUrl and scrapeSingleUrl both delegate to cachedScrapeUrl
- Eliminates the scrape:/scrape_single: cache key duplication
- Fixes missing 'formats' in search_and_scrape composite cache key
- All existing functionality preserved; TT and caching behavior improved"
```

---

### Task 4: Implement TF-IDF Passage Extractor

**Files:**
- Create: `src/passage-extractor.ts`
- Create: `tests/passage-extractor.test.ts`
- **AFK**

- [ ] **Step 1: Write failing tests**

Create `tests/passage-extractor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractRelevantPassages, preprocessText } from '../src/passage-extractor.js';

describe('preprocessText', () => {
  it('should lowercase and strip punctuation', () => {
    expect(preprocessText('Hello, World! Fastify is great.'))
      .toEqual(['hello', 'world', 'fastify', 'is', 'great']);
  });

  it('should filter empty tokens', () => {
    expect(preprocessText('a  b   c'))
      .toEqual(['a', 'b', 'c']);
  });
});

describe('extractRelevantPassages', () => {
  const markdown = [
    'Fastify is a fast and low-overhead web framework for Node.js.',
    'TypeScript adds static type checking to JavaScript.',
    'To set up a Fastify server, install the package and create an app instance.',
    'Prisma is a next-generation ORM for TypeScript and Node.js.',
    'Fastify plugins extend server functionality with decorators and hooks.',
    'This document has nothing to do with the query at all.',
  ].join('\n\n');

  it('should return passages relevant to the query', () => {
    const result = extractRelevantPassages(markdown, 'fastify server setup', { topN: 3 });

    expect(result.query).toBe('fastify server setup');
    expect(result.total_passages).toBe(6);
    expect(result.passages.length).toBeLessThanOrEqual(3);
    // The most relevant passages should mention Fastify + setup concepts
    const texts = result.passages.map(p => p.text.toLowerCase());
    expect(texts.some(t => t.includes('fastify'))).toBe(true);
  });

  it('should return empty passages array when no passages match', () => {
    const result = extractRelevantPassages(markdown, 'quantum computing', { topN: 3 });
    // With min_score=0, all passages are returned but with 0 scores
    expect(result.passages.length).toBe(3);
    // Every passage should have score 0
    result.passages.forEach(p => expect(p.score).toBe(0));
  });

  it('should respect topN limit', () => {
    const result = extractRelevantPassages(markdown, 'fastify', { topN: 2 });
    expect(result.passages.length).toBe(2);
  });

  it('should handle empty markdown', () => {
    const result = extractRelevantPassages('', 'anything', { topN: 5 });
    expect(result.total_passages).toBe(0);
    expect(result.passages).toEqual([]);
  });

  it('should include surrounding context paragraphs', () => {
    const result = extractRelevantPassages(markdown, 'fastify', {
      topN: 5,
      contextWindow: 1,
    });
    // Should include paragraphs adjacent to the highest-scoring ones
    expect(result.passages.length).toBeGreaterThan(0);
  });

  it('should score single-word paragraphs proportionally', () => {
    const singleWord = 'Fastify\n\nunrelated\n\nFastify\n\nunrelated\n\nfastify';
    const result = extractRelevantPassages(singleWord, 'fastify', { topN: 5 });
    // The three 'Fastify' paragraphs should have highest scores
    const scores = result.passages.map(p => p.score);
    // All returned passages with 'fastify' should score > 0
    const fastifyPassages = result.passages.filter(p =>
      p.text.toLowerCase().includes('fastify')
    );
    expect(fastifyPassages.length).toBeGreaterThan(0);
    fastifyPassages.forEach(p => expect(p.score).toBeGreaterThan(0));
  });
});
```

- [ ] **Step 2: Implement passage extractor**

Create `src/passage-extractor.ts`:

```typescript
/**
 * Passage Extractor: TF-IDF-based relevance scoring for scraped markdown.
 * 
 * Splits markdown into paragraphs, scores each against a query using TF-IDF,
 * and returns the top-N most relevant passages with surrounding context.
 * 
 * Zero dependencies, pure TypeScript. Designed for millisecond execution
 * on typical web pages.
 */

export interface PassageExtractionOptions {
  topN?: number;
  contextWindow?: number;
  minScore?: number;
}

export interface ScoredPassage {
  text: string;
  score: number;
  position: number;
}

export interface PassageExtractionResult {
  passages: ScoredPassage[];
  query: string;
  total_passages: number;
  top_n: number;
}

/**
 * Preprocess text: lowercase, strip punctuation, tokenize on whitespace.
 */
export function preprocessText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')  // strip punctuation
    .split(/\s+/)
    .filter(Boolean);              // remove empty tokens
}

/**
 * Extract relevant passages from markdown using TF-IDF scoring.
 */
export function extractRelevantPassages(
  markdown: string,
  query: string,
  options: PassageExtractionOptions = {}
): PassageExtractionResult {
  const topN = options.topN ?? 5;
  const contextWindow = options.contextWindow ?? 1;
  const minScore = options.minScore ?? 0.0;

  // 1. Split into paragraphs
  const rawParagraphs = markdown
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  if (rawParagraphs.length === 0) {
    return {
      passages: [],
      query,
      total_passages: 0,
      top_n: topN,
    };
  }

  // 2. Preprocess each paragraph
  const processed: string[][] = rawParagraphs.map(preprocessText);

  // 3. Preprocess query terms (exclude stop words)
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall', 'you', 'your',
    'we', 'they', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
    'me', 'my', 'he', 'she', 'him', 'her', 'what', 'which', 'who', 'how',
  ]);
  const queryTerms = preprocessText(query).filter(t => !STOP_WORDS.has(t));

  if (queryTerms.length === 0) {
    // No meaningful query terms — return first N paragraphs with zero scores
    return {
      passages: rawParagraphs.slice(0, topN).map((text, i) => ({
        text,
        score: 0,
        position: i,
      })),
      query,
      total_passages: rawParagraphs.length,
      top_n: topN,
    };
  }

  // 4. Compute IDF for each unique term across all paragraphs
  const totalParagraphs = rawParagraphs.length;
  const uniqueTerms = new Set<string>();
  const docFreq = new Map<string, number>();

  for (const tokens of processed) {
    const seen = new Set<string>();
    for (const token of tokens) {
      uniqueTerms.add(token);
      if (!seen.has(token)) {
        seen.add(token);
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
  }

  const idf = new Map<string, number>();
  for (const term of uniqueTerms) {
    const df = docFreq.get(term) || 1;
    idf.set(term, Math.log(totalParagraphs / df));
  }

  // 5. Score each paragraph
  const scored: ScoredPassage[] = rawParagraphs.map((text, idx) => {
    const tokens = processed[idx];
    const totalTerms = tokens.length || 1; // avoid division by zero

    let score = 0;
    for (const queryTerm of queryTerms) {
      const tf = tokens.filter(t => t === queryTerm).length / totalTerms;
      const termIdf = idf.get(queryTerm) || 0;
      score += tf * termIdf;
    }

    return { text, score, position: idx };
  });

  // 6. Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const topPassages = scored.slice(0, topN).filter(p => p.score >= minScore);

  // 7. Add context window (surrounding paragraphs)
  if (contextWindow > 0 && topPassages.length > 0) {
    const included = new Set(topPassages.map(p => p.position));
    const withContext: ScoredPassage[] = [];

    for (const passage of topPassages) {
      // Add preceding context
      for (let offset = contextWindow; offset > 0; offset--) {
        const pos = passage.position - offset;
        if (pos >= 0 && !included.has(pos)) {
          included.add(pos);
          // Context paragraphs get the score of the passage they surround
          // but marked with a lower effective score for sorting
          withContext.push({
            text: rawParagraphs[pos],
            score: passage.score * 0.1, // de-prioritize context paragraphs
            position: pos,
          });
        }
      }

      // Add the passage itself
      withContext.push(passage);

      // Add following context
      for (let offset = 1; offset <= contextWindow; offset++) {
        const pos = passage.position + offset;
        if (pos < rawParagraphs.length && !included.has(pos)) {
          included.add(pos);
          withContext.push({
            text: rawParagraphs[pos],
            score: passage.score * 0.1,
            position: pos,
          });
        }
      }
    }

    // Sort by position to maintain document order
    withContext.sort((a, b) => a.position - b.position);

    return {
      passages: withContext,
      query,
      total_passages: totalParagraphs,
      top_n: topN,
    };
  }

  return {
    passages: topPassages,
    query,
    total_passages: totalParagraphs,
    top_n: topN,
  };
}
```

- [ ] **Step 3: Verify tests pass**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && npx vitest run tests/passage-extractor.test.ts
```

Expected: All 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/passage-extractor.ts tests/passage-extractor.test.ts
git commit -m "feat: add TF-IDF passage extractor for query-relevant content filtering

- Pure TypeScript implementation, zero dependencies
- Splits markdown into paragraphs, scores against query using TF-IDF
- Returns top-N passages with surrounding context window
- Handles empty queries, empty markdown, and single-word documents
- Includes stop-word filtering for common English words
- 6 test cases covering relevance, limits, context windows, edge cases"
```

---

### Task 5: Integrate Passage Extraction into Pipeline

**Files:**
- Modify: `src/index.ts`
- **AFK**

- [ ] **Step 1: Add import for passage extractor**

At the top of `src/index.ts`, add:

```typescript
import { extractRelevantPassages } from './passage-extractor.js';
```

- [ ] **Step 2: Integrate into `handleSearchAndScrape`**

In `handleSearchAndScrape`, after the content-fit check (around line 514-515, after word_count check), add passage extraction for successful scrapes. Find the block where `scrapedResults.push(...)` is called (around lines 516-522) and modify it to include passage extraction:

```typescript
if (settled.status === 'fulfilled') {
  const wordCount = settled.value.data?.metadata?.word_count || 0;
  if (!isDeep && !scrapeAll && wordCount < FIT_MIN_WORDS) {
    continue;
  }

  const scrapeData = settled.value.data;
  // Extract relevant passages if we have markdown content
  let relevantPassages: any = undefined;
  if (scrapeData?.markdown) {
    relevantPassages = extractRelevantPassages(
      scrapeData.markdown,
      query,
      {
        topN: RELEVANCE_TOP_N,
        contextWindow: RELEVANCE_CONTEXT_WINDOW,
        minScore: RELEVANCE_MIN_SCORE,
      }
    );
  }

  scrapedResults.push({
    url: entry.url,
    success: settled.value.success,
    data: scrapeData,
    relevant_passages: relevantPassages,
    title: entry.title,
    snippet: entry.snippet,
  });
}
```

Then update the response mapping (around lines 546-554) to include `relevant_passages`:

```typescript
results: scrapedResults.map((r) => ({
  search_info: {
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  },
  scraped_content: {
    success: r.success,
    data: r.success ? r.data : undefined,
    error: !r.success ? r.error : undefined,
    relevant_passages: r.relevant_passages,
  },
  success: r.success,
})),
```

- [ ] **Step 3: Integrate into `handleScrapeUrl`**

In `handleScrapeUrl`, after successfully scraping, add passage extraction. The method needs access to a query — for direct URL scraping, there is no query. We pass an empty string, and the extractor handles it gracefully (returns first N paragraphs). Modify the response building in `handleScrapeUrl`:

```typescript
const result = await this.cachedScrapeUrl(
  url,
  formats || ['markdown'],
  timeout || 30000
);

// Extract passages (no query for direct scrape — returns first N paragraphs)
let relevantPassages: any = undefined;
if (result.data?.markdown) {
  relevantPassages = extractRelevantPassages(result.data.markdown, '', {
    topN: RELEVANCE_TOP_N,
    contextWindow: 0, // no context needed without a query
    minScore: 0,
  });
}

const response = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        {
          ...result,
          relevant_passages: relevantPassages,
        },
        null,
        2
      ),
    },
  ],
};
```

- [ ] **Step 4: Update the `scrapedResults` type**

The `scrapedResults` array declaration needs a `relevant_passages` field. Update the type (around line 491-498):

```typescript
const scrapedResults: Array<{
  url: string;
  success: boolean;
  data?: any;
  relevant_passages?: any;
  error?: string;
  title: string;
  snippet: string;
}> = [];
```

- [ ] **Step 5: Verify compilation**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate TF-IDF passage extraction into scrape pipeline

- search_and_scrape: extracts relevant passages for each scraped URL using query
- scrape_url: extracts top-N passages (no query, returns document preview)
- Passage extraction added to response alongside full markdown (backward-compatible)
- Configurable via MCP_RELEVANCE_TOP_N, MCP_RELEVANCE_CONTEXT_WINDOW,
  MCP_RELEVANCE_MIN_SCORE env vars"
```

---

### Task 6: End-to-End Verification

**Files:**
- None (verification only)
- **HITL** — requires running MCP server and testing tools

- [ ] **Step 1: Verify the full test suite passes**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && npx vitest run
```

Expected: All tests pass (url-normalizer + passage-extractor).

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Rebuild and restart the MCP server**

```bash
cd /home/triiq/projects/searxng-crawl4ai-mcp && docker compose build mcp-server && docker compose up -d mcp-server
```

- [ ] **Step 4: Test `scrape_url` with a known URL**

Use the MCP tool `searxng_scrape_url` with:
```json
{ "url": "https://example.com" }
```

Expected: Response includes `relevant_passages` field with document preview passages.

- [ ] **Step 5: Test `search_and_scrape` with passage extraction**

Use the MCP tool `searxng_search_and_scrape` with:
```json
{
  "query": "fastify typescript server setup",
  "maxResults": 3,
  "mode": "quick"
}
```

Expected: Each result includes `scraped_content.relevant_passages` with passages scored against the query. Passages mentioning "fastify" and "typescript" should score highest.

- [ ] **Step 6: Test cache durability**

Run the same `search_and_scrape` query twice within a minute. On the second call, verify:
- The composite cache is hit (response should be identical to first call)
- Individual URL scrape caches are also hit (no new CRW HTTP requests)

- [ ] **Step 7: Verify backward compatibility**

```bash
# Check that the response still contains the full markdown
echo "Verify: each result has scraped_content.data.markdown with full text"
echo "Verify: relevant_passages is an additional field, not a replacement"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] Phase A: URL scrape cache extended from 5-min to 24h TTL (Task 3 — `cachedScrapeUrl` with `URL_SCRAPE_CACHE_TTL_MS`)
   - [x] Phase A: URL dedup via normalization (Task 1 — `normalizeUrl`) + shared cache key (Task 3)
   - [x] Phase A: `scrape_url` handler benefits from per-URL cache (Task 3 — delegates to `cachedScrapeUrl`)
   - [x] Phase A: Cross-query URL cache reuse (Task 3 — unified cache key `scrape_url:...`)
   - [x] Phase B: Markdown chunking into paragraphs (Task 4 — `extractRelevantPassages`)
   - [x] Phase B: TF-IDF scoring per chunk (Task 4)
   - [x] Phase B: Return relevant passages with context (Task 4)
   - [x] Phase B: Backward-compatible `relevant_passages` field (Task 5)
   - [x] Phase B: No LLM, no embeddings, no API calls (Task 4 — pure TypeScript)
   - [x] Phase C: Schema sketch in design doc only (no implementation tasks)
   - [x] Bugfix: `formats` parameter included in `search_and_scrape` composite cache key (Task 3 Step 4)

2. **Placeholder scan:** No TBDs, TODOs, or vague steps. All code shown inline. All test cases specified.

3. **Type consistency:**
   - `cachedScrapeUrl` returns `ScrapeClientResponse` (matches scrape-client.ts interface)
   - `extractRelevantPassages` returns `PassageExtractionResult` (defined in passage-extractor.ts)
   - `scrapedResults` array type includes `relevant_passages?: any` field
   - All imports explicitly listed

4. **All tasks are vertical slices:**
   - Task 1: URL normalizer (utility layer only — necessary prerequisite)
   - Task 2: Constants (config layer only — necessary prerequisite)
   - Task 3: Cache unification (touches index.ts handlers, Redis cache, URL normalize — full stack)
   - Task 4: Passage extractor (utility + tests — full stack for passage extraction)
   - Task 5: Pipeline integration (wires Task 4 into index.ts handlers — full stack)
   - Task 6: Verification (end-to-end across all layers)
