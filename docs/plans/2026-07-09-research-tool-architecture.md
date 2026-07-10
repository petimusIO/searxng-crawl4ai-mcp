# Research Tool Architecture — Design Document

**Date:** 2026-07-09
**Problem:** The `search_and_scrape` MCP tool's `mode: "quick"/"deep"` parameter conflates two independent concerns (content depth and source breadth), creating a confusing mental model that leaks implementation details (timeout, pool size) into the user-facing API. Furthermore, CRW's `/v1/map` and `/v1/crawl` endpoints for site-level discovery and multi-page crawling are entirely unwired, limiting research capability to single-page scrapes.

---

## Chosen Approach

Replace `search_and_scrape` with a new `research` tool that decomposes research strategy into two orthogonal axes: **depth** (how far into content) and **breadth** (how many sources).

```
BREADTH →
D     │ single (best source)          │ multi (all top sources)       │
E  ───┼───────────────────────────────┼───────────────────────────────┤
P  qui│ search snippets,              │ search snippets,              │
T  ck │ 1 best result                 │ top 5 results                 │
H  ───┼───────────────────────────────┼───────────────────────────────┤
↓  nor│ search → scrape top 3 URLs,   │ search → scrape top 5 URLs,   │
   mal│ BM25 per page                 │ BM25 per page                 │
   ───┼───────────────────────────────┼───────────────────────────────┤
   dee│ search → pick best URL →      │ search → map + crawl EACH    │
   p  │ map → crawl (depth limit) →   │ top 3 URL → BM25 aggregate   │
      │ BM25 aggregate across pages   │ across all crawled pages      │
```

### Justification

1. **Two-axis decomposition** — depth (how far into content) and breadth (how many sources) are genuinely independent concerns that users reason about separately. The current `mode: "quick"/"deep"` bundles them into an opaque toggle.

2. **Clean migration path** — `depth: "normal"` + `breadth: "multi"` replicates all current `search_and_scrape` functionality. `depth: "normal"` + `breadth: "single"` provides a common "just check the top result" use case with no equivalent today. `depth: "quick"` provides an ultra-fast search-only path currently only available via `search_web`.

3. **Future-proof** — The `deep` tier (Phase C) gates new CRW capabilities (map + crawl) behind the depth axis, keeping the parameter space from expanding in the future. If we later add LLM-based summarization or structured data extraction, they fit naturally as new depth values without breaking the API.

4. **Compose over duplicating** — The `research` tool delegates to the same internal primitives (`SearXNGClient.search()`, `cachedScrapeUrl()`, `extractRelevantPassages()`) as the tools it replaces. No new scraping logic — just new orchestration.

### Why Replace `search_and_scrape` Instead of Adding Alongside

Two tools that search-and-scrape with different parameter names is confusing. Having `research` alongside `search_and_scrape` would force callers to choose between two tools that overlap 80%. Replacing the old tool with a superset is cleaner. `search_web` and `scrape_url` remain available as the building-block primitives.

---

## Architecture

### Component Diagram

```
                                   ┌──────────────────────────────────┐
                                   │       MCP Client (OpenCode)      │
                                   │  research("query", {depth,       │
                                   │    breadth, content_mode, ...})  │
                                   └─────────────┬────────────────────┘
                                                 │
                                   ┌─────────────┴────────────────────┐
                                   │     SearXNGMCPServer             │
                                   │  (src/index.ts)                  │
                                   │                                  │
                                   │  setupToolHandlers()             │
                                   │   ├─ search_web  (unchanged)    │
                                   │   ├─ scrape_url  (unchanged)    │
                                   │   └─ research    (NEW)          │
                                   │       └─ handleResearch()       │
                                   │            │                     │
                                   │       ┌────┴──────────────┐     │
                                   │       │  dispatch:         │     │
                                   │       │  depth=quick       │     │
                                   │       │  depth=normal      │     │
                                   │       │  depth=deep (ph.C) │     │
                                   │       └────┬──────────────┘     │
                                   └────────────┼────────────────────┘
                                                │
                      ┌─────────────┬───────────┼───────────┬─────────────┐
                      │             │           │           │             │
               ┌──────┴──────┐ ┌───┴────┐ ┌────┴─────┐ ┌───┴────┐ ┌──────┴──────┐
               │SearXNGClient│ │Scrape  │ │RedisCache│ │URL-    │ │Passage      │
               │ GET /search │ │Client  │ │          │ │Norm    │ │Extractor    │
               │             │ │        │ │ mcp:     │ │(normal-│ │(BM25)       │
               │ SearXNG     │ │scrape()│ │ cache:   │ │izeUrl) │ │extract-     │
               │ :8081       │ │map()   │ │ research:│ │        │ │Relevant-    │
               │             │ │crawl() │ │          │ │        │ │Passages)    │
               └─────────────┘ └───┬────┘ └──────────┘ └────────┘ └─────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
               ┌────┴────┐  ┌─────┴──────┐  ┌────┴────┐
               │ /v1/    │  │ /v1/       │  │ /v1/    │
               │ scrape  │  │ map        │  │ crawl   │
               └─────────┘  └────────────┘  └─────────┘
                              CRW :8001
```

### Data Flow: `depth: "normal"` + `breadth: "multi"`

```
1. Check cache: research:{query}:{depth}:{breadth}:{maxResults}:{categories}:{formats}:{content_mode}
   └─ HIT → return cached response

2. SearXNGClient.search(query, {categories, language, pageno: 1})
   → { results: [{title, url, content, ...}], ... }

3. Take top N results (5 for multi, 3 for single)

4. For each URL (15-wide worker pool):
   ┌─ cachedScrapeUrl(url, formats, timeout: 10000)
   │   ├─ normalizeUrl(url)
   │   ├─ check scrape_url:{normalized}:{formats} cache
   │   └─ CRW POST /v1/scrape → { markdown, metadata }
   │
   ├─ Filter: if wordCount < FIT_MIN_WORDS, skip (non-deep)
   │
   ├─ extractRelevantPassages(markdown, query, {topN, contextWindow, minScore})
   │   → [{text, score, surroundingParagraphs, ...}]
   │
   └─ Assemble result item:
       { url, title, snippet, success, data: { markdown?, metadata }, relevant_passages }

5. content_mode post-processing:
   ├─ "full": keep data.markdown
   ├─ "relevant_only": strip data.markdown
   └─ "snippet": strip data.markdown, force contextWindow=0 in BM25

6. Fill research_metadata: { pages_scraped, depth: "normal", breadth: "multi", ... }

7. Cache composite result → return
```

### Data Flow: `depth: "deep"` + `breadth: "single"` (Phase C)

```
1-2. Same as normal — search + cache check

3. Pick best search result by snippet length + score

4. CRW POST /v1/map { url: bestResult.url, maxDepth: 2 }
   → { links: ["/page1", "/page2", ...] }

5. CRW POST /v1/crawl { url: bestResult.url, maxPages: 10, maxDepth: 2 }
   → { id: "uuid" }

6. Poll GET /v1/crawl/{id} every 3s until status === "completed" or timeout (60s)
   → { status: "completed", data: [{ markdown, metadata }] }

7. Concatenate all page markdown → extractRelevantPassages(combined, query)
   → BM25 aggregate across site

8. Assemble result: { url, title, ... pages_crawled, relevant_passages, ... }

9. content_mode post-processing → cache → return
```

### Data Flow: `depth: "deep"` + `breadth: "multi"` (Phase C)

As above, but for each of the top 3 search results: map → crawl → aggregate. Combine all passages across all sites.

---

## API Contract

### Tool Schema

```typescript
{
  name: 'research',
  description: 'Search the web and perform research at configurable depth and breadth. '
    + 'Depth: "quick" (search snippets only, fastest), "normal" (search + scrape top results with BM25 extraction, default), '
    + '"deep" (search → map site → crawl pages → aggregate BM25). '
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
        description: 'Research depth: "quick" (search snippets only), "normal" (search + scrape, default), "deep" (site crawling)',
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
        description: 'Max search results to process (default: 3 for single, 5 for multi)',
      },
      max_pages: {
        type: 'number',
        description: 'Max total pages to crawl (deep mode only, default: 10)',
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
        description: 'Response content mode (default: "full")',
        default: 'full',
      },
    },
    required: ['query'],
  },
}
```

### Response Shape

```typescript
interface ResearchResponse {
  query: string;

  // Search metadata
  number_of_results: number;
  unresponsive_engines: string[];

  // Research execution metadata
  research_metadata: {
    depth: 'quick' | 'normal' | 'deep';
    breadth: 'single' | 'multi';
    pages_scraped: number;
    pages_crawled?: number;      // deep mode only
    crawl_duration_ms?: number;  // deep mode only
    errors: Array<{ url: string; error: string }>;
  };

  // Results
  results: Array<{
    url: string;
    title: string;
    snippet: string;          // search snippet (always present)
    source_type: 'snippet' | 'scraped' | 'crawled';
    success: boolean;
    data?: {
      markdown?: string;      // stripped when content_mode != "full"
      metadata: {
        title: string;
        description: string;
        language: string;
        word_count: number;
        source_url: string;
      };
    };
    relevant_passages: Array<{
      text: string;
      score: number;
      context?: string[];
    }>;
  }>;
}
```

### Per-Mode Behavior Summary

| Depth | Breadth | Search? | Scrape? | Map? | Crawl? | BM25? | URLs scraped | URLs crawled |
|-------|---------|---------|---------|------|--------|-------|-------------|-------------|
| quick | single | Y (best 1) | N | N | N | N | 0 | 0 |
| quick | multi | Y (top 5) | N | N | N | N | 0 | 0 |
| normal | single | Y | Y (top 3) | N | N | Y | 3 | 0 |
| normal | multi | Y | Y (top 5) | N | N | Y | 5 | 0 |
| deep | single | Y (best 1) | N | Y (1x) | Y (1x) | Y (aggregate) | 0 | <=10 |
| deep | multi | Y (best 3) | N | Y (3x) | Y (3x) | Y (aggregate) | 0 | <=30 |

---

## Caching Strategy

### Cache Key Construction

```
research:{query}:{depth}:{breadth}:{maxResults}:{categories}:{formatKey}:{contentMode}
```

- `formatKey` = `(formats || ['markdown']).join(',')`
- `contentMode` = `content_mode || 'full'`
- All other values are empty-string if undefined
- TTL: `COMPOSITE_CACHE_TTL_MS` (300s / 5 min by default)

### What Is Cached

- **Full composite response** — the complete `ResearchResponse` object is cached at this key
- **Per-URL scrape results** — `cachedScrapeUrl()` uses its own `scrape_url:` prefix with 24h TTL. This means different `research` calls with overlapping URL sets share per-URL cache entries.
- **Deep crawl results** (Phase C) — crawl results are NOT cached at the per-URL level (they're site-level, not page-level). The composite cache covers the crawl result instead. Crawl job IDs are ephemeral.

### Content Mode Interaction

As established in the `content_mode` design (2026-07-09): full markdown is always returned from `cachedScrapeUrl()` and stored in the scrape URL cache. `content_mode` controls only the serialization of the composite research response, not what gets scraped. Including `contentMode` in the composite cache key prevents cache poisoning across modes.

---

## ScrapeClient Additions

Two new methods on `ScrapeClient`:

```typescript
// Map a site — discover all pages
async map(url: string, options?: MapOptions): Promise<MapResponse>

// Start a crawl — returns job ID for polling
async crawl(url: string, options?: CrawlOptions): Promise<CrawlAcceptedResponse>

// Poll crawl status — returns progress or results
async crawlStatus(jobId: string): Promise<CrawlStatusResponse>
```

**Type definitions:**

```typescript
interface MapOptions {
  maxDepth?: number;        // default: 2
  useSitemap?: boolean;     // default: true
  crawlFallback?: boolean;  // default: true
  timeout?: number;         // default: 120 (seconds)
}

interface MapResponse {
  success: boolean;
  data: {
    links: string[];
    droppedActionCount: number;
    strippedTrackingCount: number;
  };
}

interface CrawlOptions {
  maxPages?: number;          // default: 100
  maxDepth?: number;          // default: 2
  scrapeOptions?: {
    formats?: string[];
    onlyMainContent?: boolean;
  };
}

interface CrawlAcceptedResponse {
  success: boolean;
  id: string;
  url: string;  // polling URL (relative)
}

interface CrawlStatusResponse {
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
}
```

**Error handling note:** CRW returns raw strings (not JSON) for invalid crawl job UUIDs. Both `crawlStatus()` calls must wrap `JSON.parse()` in try/catch and normalize the error into a structured format.

---

## Key Decisions

### 1. Why `research` instead of `search_research` or `deep_search`

The requirements specify the tool name `research`. This is clean, terse, and communicates the intent better than `search_and_scrape`. The domain already has `search_web` for the search-only tool, so `research` for search-orchestration is differentiated.

### 2. Why `depth` and `breadth` as separate parameters

The previous `mode: "quick"/"deep"` confounded depth with breadth. Separating them gives six coherent modes from two parameters instead of a single blob. This is the principle of orthogonal composition — two independent concerns should be two independent parameters.

### 3. Why `breadth: "single"` is the default

The most common research pattern is "look up the best answer." Callers who want multiple sources explicitly opt in with `breadth: "multi"`. This mirrors search engine behavior: most users click the first result.

### 4. Why `depth: "normal"` is the default

Quick mode returns no scraped content — just search snippets. Normal mode is the "I want actual content" default. Deep mode is expensive (multiple CRW calls, polling) and should be opt-in.

### 5. Why `search_and_scrape` is removed, not deprecated

A deprecation period with two overlapping tools (one deprecated) adds confusion. The project has a small user base and breaking changes are cheap. The new `research` tool with `depth: "normal"` + `breadth: "multi"` is a drop-in replacement — callers just update the tool name and restructure parameters.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CRW crawl jobs accumulate if polling fails | Low | Low — memory pressure on CRW | Max polling duration (60s), research_metadata includes crawl_timeout flag |
| Map returns 10,000+ links on large sites | Medium | Medium — response size blowout | Cap `maxDepth: 2` default, respect `max_pages` parameter |
| Different content_mode values return different results despite same cache key | Low | High — cache poisoning | content_mode included in composite cache key (already done for search_and_scrape) |
| CRW returns non-JSON errors for invalid crawl UUIDs | Medium | Low — handler crash | try/catch JSON.parse, return structured error |
| Removing search_and_scrape breaks existing callers | Medium | Medium | Clear migration path: rename tool, split mode into depth+breadth |
| Deep mode times out (crawl takes >60s) | Medium | Medium — partial results | Return partial results with errors field; don't block indefinitely |

---

## Implementation Phasing

### Phase A: ScrapeClient additions (~2 tasks)
Add `map()`, `crawl()`, `crawlStatus()` methods to `ScrapeClient`. Types only. No handler changes. Test via curl against local CRW.

### Phase B: Research tool handler + replacement (~5 tasks)
Handle `depth: "quick"` and `depth: "normal"` modes. Register `research` tool, remove `search_and_scrape`. All six quick/normal combinations work. Backward compatibility via `depth: "normal"` + `breadth: "multi"`.

### Phase C: Deep mode (~3 tasks, future)
Add `handleDeepResearch()` — map → crawl → poll → BM25 aggregate. Wire into handler dispatch. CRW crawl polling with timeout.

