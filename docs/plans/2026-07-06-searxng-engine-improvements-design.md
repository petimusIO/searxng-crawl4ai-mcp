# Design: SearXNG Engine Configuration Improvements

**Date:** 2026-07-06
**Status:** Proposed

## Problem Statement

The SearXNG instance powering the MCP server has only 4 active engines (google, bing, duckduckgo, github, stackoverflow), limiting search result quality and diversity. The timeout defaults (1.0s request, 1.5s max) are dangerously tight and would cause most engines to silently timeout. The engine list must be expanded to cover all search categories with reliable, API-key-free engines.

## The Two-Config Divergence (Critical Issue)

Two settings files exist:

| File | Purpose | Status |
|---|---|---|
| `searxng-settings.yml` (root) | Deployed via `Dockerfile.searxng` -> `/etc/searxng/settings.yml` | **Authoritative** -- 7 engines, 1.0s timeout |
| `searxng/settings.yml` (subdir) | Unknown -- not referenced in any Dockerfile | **Stale/alternate** -- 12 engines, 10s timeout, env-var secrets |

The two files have diverged significantly in timeouts, secrets handling, proxy config, and engine list. The plan must consolidate back to the authoritative root file.

## Chosen Approach: Incremental Engine Expansion with Config Consolidation

**Approach:** Update the root `searxng-settings.yml` with:
1. Broader timeouts (from 1.0s/1.5s -> 5.0s/10.0s)
2. 24 new engines across 5 categories (total 29 active engines across 7 categories)
3. Per-engine timeouts for known-slow engines (arxiv, scholar, etc.)
4. Environment-variable secrets (adopt from secondary config)
5. Explicit `categories_as_tabs` declaration
6. Proxy support (adopt from secondary config)

**Justification:** The `searxng/settings.yml` secondary config clearly represents a more evolved but never-deployed configuration. Rather than starting from scratch, we merge the best of both: the deployed file's structure and the secondary's better defaults, plus researched additions.

### Why Not Alternatives

**Alternative A: Start from `searxng/settings.yml` and add engines**
Rejected -- it's missing `max_results`, `server.method`, and other settings present in the root. Would require backporting those. Simpler to go forward from the deployed file.

**Alternative B: Delete `searxng-settings.yml` and update Dockerfile to use `searxng/settings.yml`**
Rejected -- changes the build pipeline unnecessarily. The root file is the established convention.

**Alternative C: Keep both files in sync**
Rejected -- dual-writes are an anti-pattern. One source of truth.

## Architecture

### Engine Selection Criteria

Every engine selected meets ALL of:
1. **No API key required** -- purely public/free access
2. **Active in SearXNG defaults** (not `disabled: true` or `inactive: true`) -- meaning the SearXNG maintainers consider it working
3. **Fills a useful category** -- avoids engines that duplicate existing coverage without adding value
4. **Reliable community reputation** -- based on research of SearXNG community reports

### Engine Roster

#### General Web (5 engines)

| Engine | Action | Justification |
|---|---|---|
| `google` | Keep | Already working |
| `bing` | Keep | Already working, Microsoft backend, reliable |
| `duckduckgo` | Keep | Already working, privacy-focused |
| `startpage` | **Enable** (was `disabled: true`) | Google proxy, no API key, complements DDG/Bing |
| `brave` | **Add** | Best free general engine currently, active in defaults |

#### News (3 engines)

| Engine | Action | Justification |
|---|---|---|
| `google_news` | **Add** | Strong news coverage, surprisingly still working |
| `bing_news` | **Add** | Reliable Microsoft-backed news engine |
| `duckduckgo_news` | **Add** | Privacy-focused news aggregation |

#### IT / Technology (6 engines)

| Engine | Action | Justification |
|---|---|---|
| `github` | Keep | Already working |
| `stackoverflow` | Keep | Already working |
| `arch linux wiki` | **Add** | Active in defaults, excellent for Linux/system docs |
| `docker hub` | **Add** | Active, categories `[it, packages]`, container image search |
| `mdn` | **Add** | Active, MDN Web Docs -- essential for web dev |
| `pypi` | **Add** | Active, Python package search |

#### Science (4 engines)

| Engine | Action | Categories Override | Justification |
|---|---|---|---|
| `arxiv` | **Add** | `science` (default: `general`) | Active, academic papers. Recategorize to science tab |
| `wikidata` | **Add** | `science` (default: `general`) | Active, structured knowledge base |
| `pubmed` | **Add** | `science` (default: `general`) | Active, medical literature |
| `google_scholar` | **Add** | `science` (default: `general`) | Academic search -- but note: this one may be unstable |

#### Images (3 engines)

| Engine | Action | Justification |
|---|---|---|
| `bing_images` | **Add** | Active, reliable Microsoft backend |
| `duckduckgo_images` | **Add** | Active, privacy-focused |
| `brave.images` | **Add** | Active, complements the above two |

#### Videos (3 engines)

| Engine | Action | Justification |
|---|---|---|
| `bing_videos` | **Add** | Active, reliable |
| `duckduckgo_videos` | **Add** | Active |
| `brave.videos` | **Add** | Active |

### Engines Explicitly NOT Added

| Engine | Reason |
|---|---|
| `qwant` (general/images/news/videos) | Frequently broken by upstream changes, disabled in defaults |
| `mojeek` family | Small index, disabled in defaults |
| `yandex` family | Geo-restricted, disabled in defaults |
| `karmasearch` | Already `disabled: true` in current config, unknown reliability |
| `google` / `google_images` / `google_videos` | Marked `inactive` in defaults (anti-bot measures) |
| `swisscows`, `presearch`, `dogpile`, `luxxle`, `heexy`, `tiger` | All disabled and/or inactive in defaults |

### Data Flow

```
MCP Client (Claude / OpenCode)
  |  search_web({ query: "foo", categories: "science" })
  v
MCP Server (src/index.ts)
  |  SearXNGClient.search(query, { categories: "science" })
  |  HTTP GET http://searxng:8080/search?q=foo&format=json&categories=science
  v
SearXNG Container (searxng/searxng:latest)
  |  Reads /etc/searxng/settings.yml (our config)
  |  Merges with built-in searx/settings.yml defaults
  |  Dispatches to all active engines in category "science"
  |  Aggregates results, deduplicates, returns JSON
  v
MCP Server
  |  Caches result (300s TTL)
  |  Returns structured SearchResult[]
  v
MCP Client
```

### Timeout Architecture

```
                    MCP Client (no timeout enforced by MCP)
                           |
                    MCP Server axios timeout: 10s  <-- CEILING
                           |
                    SearXNG max_request_timeout: 10s
                           |
              +------------+------------+
              |            |            |
        google: 5s    arxiv: 10s   ddg: 6s   <-- per-engine overrides
```

**Why 5s global, 10s max:** Most engines return in 1-3 seconds. A 5s global timeout catches hung engines early, while the 10s `max_request_timeout` allows slow-but-valuable engines (arxiv, pubmed, scholar) to complete. This stays under the MCP client's 10s axios timeout.

### categories_as_tabs Configuration

```yaml
categories_as_tabs:
  general:
  images:
  videos:
  news:
  map:          # 0 engines -- tab hidden in UI
  music:        # 0 engines -- tab hidden in UI
  it:
  science:
  files:        # 0 engines -- tab hidden in UI
  social media: # 0 engines -- tab hidden in UI
```

Explicitly declaring this ensures tabs match our engine coverage. Empty tabs (`map`, `music`, `files`, `social media`) are automatically hidden by SearXNG's UI. The declaration is included for clarity and forward-compatibility (adding engines to these categories later won't require re-declaring tabs).

## Key Decisions

1. **Recategorize science engines:** `arxiv`, `wikidata`, `pubmed`, `google_scholar` default to `general` category in SearXNG. We override to `science` so users searching the science tab get academic results.

2. **Per-engine timeouts for slow engines:** Academic engines (arxiv, pubmed, semantic scholar) are known to be slow (5-10s). Without explicit overrides, they'd be prematurely killed by the global `request_timeout`.

3. **Enable startpage (was disabled):** The current config explicitly disables startpage despite it being a reliable Google proxy. `timeout: 6.0` is retained.

4. **Proxy configuration:** The secondary config uses `${PROXY_URL}`. We adopt this pattern but keep it as an environment variable -- no proxy by default.

5. **`searxng/settings.yml` disposition:** After consolidation, this file becomes vestigial. The plan recommends removing it to prevent future confusion, but this is flagged as a decision point for Axiom.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Brave engines break or rate-limit** | Low-Medium | Medium | Startpage and DuckDuckGo serve as fallback general engines |
| **Per-engine timeout cascade**: if 5 engines each take 10s, total search exceeds MCP client 10s | Low | Low | `max_request_timeout: 10` is a hard ceiling on SearXNG-side. All engines run in parallel, not sequentially. |
| **Google Scholar unstable** | Medium | Low | Marked with comment in config; can be disabled without affecting other engines |
| **Docker Hub rate-limiting** | Low | Low-Medium | Docker Hub has a public rate limit; SearXNG may get 429s. Monitor `unresponsive_engines` in response. |

## Terminology

No domain conflicts. This is an infrastructure config change -- no new domain concepts introduced.

## Attic Check Summary

| Layer | Finding | Reuse? |
|---|---|---|
| **Codebase** | Two divergent settings files; `searxng/settings.yml` has unused better defaults | Merge into root, not rebuild |
| **MCP server** | Already supports `categories` parameter; already has caching (300s TTL) | No code changes needed |
| **Ecosystem** | SearXNG's built-in defaults provide ~80 active engines; all our additions come from there | 100% reuse -- just enabling what's already supported |
| **Dockerfile** | Copies `searxng-settings.yml` -> `/etc/searxng/settings.yml` | No change needed |
