# Design: Web Search Pipeline Improvements

**Date:** 2026-07-09
**Status:** Proposed

## Problem Statement

The MCP server's web search/scrape pipeline has three structural weaknesses: (1) URL scrape caching is too short (5 minutes) making cross-session reuse impossible, (2) full scraped markdown is returned for every URL without relevance filtering, wasting LLM tokens, and (3) there is no persistent storage layer for long-term content retrieval.

---

## Phase A: URL-Level Persistent Cache

### Problem Detail

Two separate cache namespaces exist for the same underlying CRW scrape:

| Handler | Cache Key Pattern | TTL | Stores |
|---------|------------------|-----|--------|
| `handleScrapeUrl` | `scrape:${url}:${formats}` | 5 min | MCP response wrapper |
| `scrapeSingleUrl` | `scrape_single:${url}:${formats}` | 5 min | Raw `ScrapeClientResponse` |

These are **different cache keys for the same URL content**. A URL scraped via `scrape_url` cannot be reused by `search_and_scrape` and vice versa. Additionally, the composite cache key in `handleSearchAndScrape` omits `formats` — a latent bug.

### Chosen Approach: Unify URL-scrape caching into a single method

Create a private `cachedScrapeUrl(url, formats, timeout?, isDeep?)` method that:
1. Uses a single cache key format: `scrape_url:${normalizedUrl}:${formats}`
2. Stores the raw `ScrapeClientResponse` (not the MCP wrapper)
3. Uses a configurable TTL defaulting to 24 hours (`86_400_000` ms)
4. Is called by both `handleScrapeUrl` and `scrapeSingleUrl`

**Why:**
- Eliminates the two-namespace duplication
- 24h TTL enables cross-session reuse; Redis is persistent (`--save 30 1`)
- Raw response storage allows any downstream handler to shape output as needed
- Fixes the missing `formats` in composite cache key

### Architecture

```
Before:
  handleScrapeUrl --> cache.set("scrape:...", MCP-wrapper)   --> redis
  scrapeSingleUrl --> cache.set("scrape_single:...", raw)    --> redis
  (no reuse between them)

After:
  handleScrapeUrl --> cachedScrapeUrl(url, formats) --> cache.set("scrape_url:...", raw, 24h) --> redis
  scrapeSingleUrl -/
  (single cache entry, single method, shared TTL)
```

### URL Normalization

```
Input:  "https://www.example.com/page?ref=foo&utm_source=bar#section"
Steps:  1. Lowercase scheme + host
        2. Strip trailing slash on path-only URLs
        3. Strip known tracking query params (ref, utm_source, utm_medium,
           utm_campaign, fbclid, gclid, mc_cid, mc_eid, _ga, _gl)
        4. If remaining query params, sort alphabetically for stable ordering
Output: "https://example.com/page#section"
```

Normalization is heuristic — it won't catch every equivalent URL, but eliminates the most common fragmentation patterns.

### Configurable TTL

| Env Var | Default | Purpose |
|---------|---------|---------|
| `MCP_URL_SCRAPE_CACHE_TTL_MS` | `86_400_000` (24h) | Per-URL scrape result cache |
| `MCP_SEARCH_CACHE_TTL_MS` | `300_000` (5 min) | Search result cache |
| `MCP_COMPOSITE_CACHE_TTL_MS` | `300_000` (5 min) | search_and_scrape composite cache |

---

## Phase B: Query-Relevant Passage Extraction

### Problem Detail

After CRW scrapes a page, the entire markdown is returned to the LLM. For a 5,000-word article where only 200 words are relevant to the query, >95% of tokens are noise.

### Chosen Approach: TF-IDF Per-Paragraph Scoring

**Pipeline:**

1. **Chunk** — Split markdown into paragraphs by `\n\n`. Filter empty paragraphs.
2. **Preprocess** — Lowercase, strip punctuation, tokenize on whitespace per paragraph. Build corpus vocabulary.
3. **Score** — For each paragraph: score = sum(TF(term, para) * IDF(term)) over all query terms
4. **Select** — Sort by score descending. Take top N (default 5). Include +/-1 surrounding paragraph for context.
5. **Output** — Add `relevant_passages` field alongside existing `data.markdown`

**Why TF-IDF:**

| Approach | Quality | Speed | Dependencies |
|----------|---------|-------|-------------|
| Pure keyword overlap | Low | Very fast | 0 |
| **TF-IDF per-paragraph** | **Medium** | **Fast** | **0** |
| BM25 | Medium-High | Fast | 0 |
| LLM-based selection | High | Slow/costly | API call |
| Embedding + similarity | High | Slow | pgvector/Pinecone |

- **Zero dependencies** — pure TypeScript, ~80 lines
- **Millisecond runtime** on typical pages (200 paragraphs * 2000 terms)
- **Good enough** — statistical weighting significantly outperforms keyword overlap
- **Extensible** — can serve as pre-filter for Phase C embeddings

### Output Schema

Added to each scraped result in `search_and_scrape` and `scrape_url`:

```typescript
relevant_passages?: {
  passages: Array<{
    text: string;          // paragraph text
    score: number;         // TF-IDF relevance score
    position: number;      // paragraph index in document
  }>;
  query: string;           // the query used for scoring
  total_passages: number;  // total paragraphs in document
  top_n: number;           // configurable limit
}
```

### Backward Compatibility

The `relevant_passages` field is **additive only**. Existing `data.markdown` is preserved unchanged. Consumers that don't know about `relevant_passages` ignore it. New consumers can opt into using it for context-efficient prompts.

### Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `MCP_RELEVANCE_TOP_N` | `5` | Number of top passages to return |
| `MCP_RELEVANCE_CONTEXT_WINDOW` | `1` | Surrounding paragraphs on each side |
| `MCP_RELEVANCE_MIN_SCORE` | `0.0` | Minimum score threshold |

---

## Phase C: pgvector Persistence — Future Sketch

### Goal

Store scraped content chunks with embeddings for long-term semantic search. When a new query arrives, match against previously scraped pages before dispatching a fresh scrape.

### Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE scraped_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  title TEXT,
  description TEXT,
  word_count INT,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE scraped_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID REFERENCES scraped_pages(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_id, chunk_index)
);

CREATE INDEX ON scraped_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### Pipeline

```
Search Query
    |
    v
+---------------------+
| 1. Embed query      | <-- local model (nomic-embed-text / all-MiniLM-L6-v2)
+---------+-----------+
          v
+---------------------+
| 2. pgvector search  | <-- cosine similarity, cutoff 0.7, limit 20
+---------+-----------+
          v
+---------------------+
| 3. Freshness check  | <-- >7 days stale -> re-scrape; >0.85 sim -> return cached
+---------+-----------+
          v
+---------------------+
| 4. Fallback: CRW    | <-- not in DB or stale -> scrape + embed + insert
+---------------------+
```

Phase C requires: pgvector extension, embedding model (local or API), Postgres connection in the MCP server. Not in the current implementation plan.

---

## Key Decisions

1. **Unify URL cache under `cachedScrapeUrl`.** Two-namespace pattern is accidental complexity from incremental development. One method eliminates duplication and enables cross-handler reuse.

2. **Store raw `ScrapeClientResponse`, not MCP wrapper.** Raw response is the reusable unit. Each handler shapes output as needed.

3. **24-hour scrape cache TTL default.** Long enough for cross-session reuse in development workflows. Short enough for reasonable content freshness. Overridable via env var.

4. **TF-IDF over BM25.** BM25's document-length normalization and saturation function matter for ranking across thousands of documents. For within-page paragraph ranking against a short query, the additional complexity doesn't justify the marginal gain.

5. **Paragraph-level chunking.** Paragraphs are natural semantic boundaries. Sentence-level produces too many tiny chunks. Fixed-window cuts mid-thought.

6. **Additive output.** `relevant_passages` is additional, not replacing. Full markdown stays. Lowest-risk path; consumers opt in gradually.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **URL normalization changes cache behavior** | Medium | Low | Applied consistently on read + write. Old 5-min entries expire naturally. `normalizeUrl()` has unit tests. |
| **24h cache serves stale content** | Low | Medium | Overridable via env var. Phase C will add freshness checks. |
| **TF-IDF poor relevance for common-term queries** | Medium | Low-Medium | `MCP_RELEVANCE_MIN_SCORE` can filter. Full markdown always available as fallback. |
| **Redis memory growth with 24h cache** | Low-Medium | Low | Typical scrape: 5-50KB. 1000 URLs = ~50MB. Redis has persistence and can set `maxmemory-policy allkeys-lru`. |
| **Large pages (100k+ words)** | Low | Low | TF-IDF is O(N*V). 200 paragraphs * 2000 terms = ~400k ops, sub-millisecond. CRW already extracts clean markdown. |

## Attic Check Summary

| Layer | Finding | Reuse? |
|-------|---------|--------|
| **Codebase** | `RedisCache.set()` already accepts optional `ttlMs` parameter — no API change needed for TTL extension | 100% reuse |
| **Codebase** | `scrapeSingleUrl()` already provides per-URL caching — just needs TTL bump and key unification | Refactor, not rebuild |
| **Codebase** | No existing text processing/TF-IDF code — this is net-new | New module needed |
| **Ecosystem** | Node.js has no lightweight TF-IDF package worth the dependency weight | Implement inline |
| **Infrastructure** | Redis already has persistent volume (`redis_data`) and `--save 30 1` | No infra changes |
| **MCP server** | Response shape is flexible JSON — additive fields don't break existing consumers | Backward-compatible |
