# Content Mode Parameter — Design Document

**Date:** 2026-07-09
**Problem:** The `scrape_url` and `search_and_scrape` MCP tools always return full markdown + relevant_passages. For token-constrained callers, we need an optional content-filtering mode that strips the full markdown from the serialized response.

---

## Chosen Approach

Add an optional `content_mode` parameter to both `scrape_url` and `search_and_scrape` tools with three values:

| Value | Behavior | Passage extraction |
|---|---|---|
| `"full"` (default) | Return full markdown + relevant_passages (backward compatible) | Defaults (env-configured) |
| `"relevant_only"` | Strip `data.markdown` from response; keep `relevant_passages` | Defaults (env-configured) |
| `"snippet"` | Same as `relevant_only` but force `contextWindow: 0` | contextWindow forced to 0 |

**Justification:** This is the simplest additive change — a single parameter that controls response serialization. The full markdown is always cached in Redis (via `cachedScrapeUrl`), so different modes can be served from the same cache entry. Only the serialized response changes.

### Why `content_mode` instead of `mode`

The `search_and_scrape` tool **already has** a `mode` parameter with values `["quick", "deep"]` that controls scraping depth/performance. Reusing `mode` would create a semantic collision (is `"snippet"` a scraping depth? no). Using `content_mode` keeps the concepts orthogonal and backward-compatible.

---

## Alternatives Considered

### A: Co-opt existing `mode` parameter
Add `"full"`, `"relevant_only"`, `"snippet"` alongside `"quick"`, `"deep"` in the same `mode` enum.

**Rejected:** Semantically confusing. `mode: "quick"` and `mode: "snippet"` answer different questions (how to scrape vs what to return). Tool descriptions would become muddled.

### B: Rename existing `mode` → `depth` and use `mode` for content filtering
**Rejected:** Breaking change for any client using `mode: "quick"` / `mode: "deep"`. The cost of migration outweighs the naming purity.

### C: Use `formats` parameter to control content
Add special format strings like `"relevant_only"` to the existing `formats` array.

**Rejected:** The `formats` parameter controls CRW output formats (markdown, html, etc.) — mixing content-filtering modes into format strings is a category error.

---

## Architecture

```
Caller
  │  { content_mode: "relevant_only" }
  ▼
handleScrapeUrl / handleSearchAndScrape
  │
  ├─ cachedScrapeUrl()          ← always returns FULL ScrapeClientResponse
  │   └─ Redis cache            ← stores full markdown (unchanged)
  │
  ├─ extractRelevantPassages()  ← runs with mode-appropriate contextWindow
  │
  └─ serializeResponse()        ← strips data.markdown if content_mode ≠ "full"
     │
     ▼
  MCP Tool Response (JSON)
```

**Key invariant:** `cachedScrapeUrl()` always returns the full `ScrapeClientResponse`. The content mode only affects what gets serialized into the tool response.

### Response shape comparison

```jsonc
// content_mode: "full" (default)
{
  "data": {
    "markdown": "# Full Article\n\nLorem ipsum...",  // PRESENT
    "metadata": { "title": "..." }
  },
  "relevant_passages": { "passages": [...] }
}

// content_mode: "relevant_only"
{
  "data": {
    "metadata": { "title": "..." }   // markdown STRIPPED
  },
  "relevant_passages": { "passages": [...] }
}
```

---

## Key Decisions

1. **Parameter name `content_mode`**: Avoids collision with existing `mode` (`quick`/`deep`). Requires Zai's approval — alternatives: `output_mode`, `detail`, `content_filter`.

2. **Cache key inclusion**: For `search_and_scrape`, the composite response cache must include `content_mode` in its key. For `scrape_url`, no cache key change needed — per-URL cache stores full data unconditionally.

3. **`snippet` mode in `scrape_url`**: Currently `handleScrapeUrl` already uses `contextWindow: 0`. So `snippet` and `relevant_only` produce identical output for `scrape_url` — documented, correct behavior.

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Cache poisoning: stripped response cached and served to full caller | Medium | Include `content_mode` in composite cache key for `search_and_scrape` |
| Naming confusion if Zai prefers different parameter name | Low | Flag as decision point; trivial to rename before implementation |
| `data` is undefined (failed scrape) | Low | Guard with optional chaining/null check |
