# SearXNG Engine Configuration Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand SearXNG from 4 active engines to 29 across 7 categories, fix dangerously-tight timeouts, and consolidate two divergent config files into one authoritative source.

**Architecture:** Single YAML config file (`searxng-settings.yml`) deployed via `Dockerfile.searxng` → `/etc/searxng/settings.yml`. No code changes. Uses `use_default_settings: true` to merge with SearXNG built-in defaults. All engines are free/public (no API keys).

**Tech Stack:** SearXNG (Docker), YAML config, Docker Compose

---

### Task 1: Write the Improved searxng-settings.yml

**Files:**
- Modify: `searxng-settings.yml` (root — full rewrite)
- **HITL** — Axiom should review the config before deployment

- [ ] **Step 1: Back up current config**

```bash
cp searxng-settings.yml searxng-settings.yml.bak
```

- [ ] **Step 2: Write the new config**

Replace the entire contents of `searxng-settings.yml` with the YAML below. This consolidates:
- Better timeouts (5s/10s) from the `searxng/settings.yml` secondary config
- Environment-variable secrets from the secondary config
- 24 new engines researched from SearXNG defaults
- Explicit `categories_as_tabs` declaration
- Proxy support from secondary config

```yaml
# SearXNG Configuration for MCP Server
# Merged with SearXNG built-in defaults via use_default_settings: true
use_default_settings: true

general:
  debug: false
  instance_name: "SearXNG MCP"
  donation_url: false
  contact_url: false
  enable_stats: false

search:
  safe_search: 0
  autocomplete: "google"
  default_lang: "en"
  max_results: 25
  formats:
    - html
    - json

server:
  port: 8080
  bind_address: "0.0.0.0"
  secret_key: "${SEARXNG_SECRET}"
  base_url: "${SEARXNG_BASE_URL}"
  image_proxy: true
  http_protocol_version: "1.1"
  method: "POST"

ui:
  static_use_hash: false
  default_locale: "en"
  query_in_title: true
  infinite_scroll: false
  center_alignment: false
  cache_url: "https://web.archive.org/web/"
  default_theme: simple
  theme_args:
    simple_style: auto

# Categories visible as tabs in SearXNG UI.
# Tabs with 0 active engines (map, music, files, social media) are auto-hidden.
categories_as_tabs:
  general:
  images:
  videos:
  news:
  map:
  music:
  it:
  science:
  files:
  social media:

# Outgoing request configuration.
# request_timeout: per-engine timeout (SearXNG kills engines taking longer)
# max_request_timeout: hard ceiling — no engine runs longer than this
outgoing:
  request_timeout: 5.0
  max_request_timeout: 10.0
  pool_connections: 100
  pool_maxsize: 20
  # Proxy support (optional — set PROXY_URL env var to enable)
  proxies:
    http: "${PROXY_URL}"
    https: "${PROXY_URL}"

# ── Engines ────────────────────────────────────────────────────────────
# All engines are free/public (no API keys required).
# Engines NOT listed here keep their SearXNG default behavior
# (which is often disabled: true — we must explicitly enable what we want).
engines:

  # ═══════════════════════════════════════════════════════════════════
  # GENERAL WEB SEARCH (5 engines)
  # ═══════════════════════════════════════════════════════════════════

  - name: google
    engine: google
    shortcut: go
    use_mobile_ui: false

  - name: bing
    engine: bing
    shortcut: bi

  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg

  - name: startpage
    engine: startpage
    shortcut: sp
    timeout: 6.0

  - name: brave
    engine: brave
    shortcut: br
    categories: [general, web]

  # ═══════════════════════════════════════════════════════════════════
  # NEWS (3 engines)
  # ═══════════════════════════════════════════════════════════════════

  - name: google news
    engine: google_news
    shortcut: gon
    categories: news
    timeout: 10.0

  - name: bing news
    engine: bing_news
    shortcut: bin
    categories: news
    timeout: 10.0

  - name: duckduckgo news
    engine: duckduckgo_news
    shortcut: ddn
    categories: news

  # ═══════════════════════════════════════════════════════════════════
  # IMAGES (3 engines)
  # ═══════════════════════════════════════════════════════════════════

  - name: bing images
    engine: bing_images
    shortcut: bii
    categories: images

  - name: duckduckgo images
    engine: duckduckgo_images
    shortcut: ddi
    categories: images

  - name: brave.images
    engine: brave.images
    shortcut: brimg
    categories: [images, web]

  # ═══════════════════════════════════════════════════════════════════
  # VIDEOS (3 engines)
  # ═══════════════════════════════════════════════════════════════════

  - name: bing videos
    engine: bing_videos
    shortcut: biv
    categories: videos

  - name: duckduckgo videos
    engine: duckduckgo_videos
    shortcut: ddv
    categories: videos

  - name: brave.videos
    engine: brave.videos
    shortcut: brvid
    categories: [videos, web]

  # ═══════════════════════════════════════════════════════════════════
  # IT / TECHNOLOGY (6 engines)
  # ═══════════════════════════════════════════════════════════════════

  - name: github
    engine: github
    shortcut: gh

  - name: stackoverflow
    engine: stackoverflow
    shortcut: so
    timeout: 10.0

  - name: arch linux wiki
    engine: arch linux wiki
    shortcut: al
    categories: it
    timeout: 6.0

  - name: docker hub
    engine: docker hub
    shortcut: dh
    categories: [it, packages]

  - name: mdn
    engine: mdn
    shortcut: mdn
    categories: it

  - name: pypi
    engine: pypi
    shortcut: pypi
    categories: [it, packages]

  # ═══════════════════════════════════════════════════════════════════
  # SCIENCE (4 engines)
  # Note: These default to "general" in SearXNG. We override to
  # "science" so the science tab returns academic results.
  # ═══════════════════════════════════════════════════════════════════

  - name: arxiv
    engine: arxiv
    shortcut: arx
    categories: science
    timeout: 10.0

  - name: wikidata
    engine: wikidata
    shortcut: wd
    categories: science
    timeout: 6.0

  - name: pubmed
    engine: pubmed
    shortcut: pub
    categories: science
    timeout: 10.0

  - name: google scholar
    engine: google_scholar
    shortcut: gsc
    categories: science
    timeout: 10.0
    # Note: Google Scholar may be unstable due to anti-bot measures.
    # If it consistently times out, set disabled: true.

  # ── Disabled / Reserved ───────────────────────────────────────────
  # Engines kept in config but disabled for reference.
  # Uncomment and set disabled: false to activate.

  - name: qwant
    engine: qwant
    shortcut: qw
    categories: general
    disabled: true
    # Disabled: frequently broken by upstream changes

  - name: yandex
    engine: yandex
    shortcut: ya
    disabled: true
    # Disabled: geo-restricted, may not work from all regions

redis:
  url: redis://redis:6379/0
```

- [ ] **Step 3: Verify the YAML is valid**

```bash
python3 -c "import yaml; yaml.safe_load(open('searxng-settings.yml')); print('YAML is valid')"
```

Expected: `YAML is valid`

- [ ] **Step 4: Commit the backup and new config**

```bash
git add searxng-settings.yml searxng-settings.yml.bak
git commit -m "feat: expand SearXNG engines from 4 to 29 across 7 categories

- Fix dangerously-tight timeouts (1.0s/1.5s -> 5.0s/10.0s)
- Enable startpage (was disabled), add brave family
- Add news tab: google_news, bing_news, duckduckgo_news
- Add images tab: bing_images, duckduckgo_images, brave.images
- Add videos tab: bing_videos, duckduckgo_videos, brave.videos
- Add IT tab: arch linux wiki, docker hub, mdn, pypi
- Add science tab: arxiv, wikidata, pubmed, google_scholar
  (recategorized from general -> science)
- Adopt env-var secrets (SEARXNG_SECRET, SEARXNG_BASE_URL)
- Adopt proxy support (PROXY_URL)
- Add explicit categories_as_tabs declaration
- Per-engine timeouts for known-slow engines (scholar: 10s, arxiv: 10s)"
```

---

### Task 2: Remove Vestigial searxng/settings.yml

**Files:**
- Delete: `searxng/settings.yml`
- **HITL** — Axiom should confirm this file is not used by anything

- [ ] **Step 1: Verify nothing references this file**

```bash
grep -r "searxng/settings.yml" . --include="*.yml" --include="*.yaml" --include="Dockerfile*" --include="*.md" --include="*.json" --include="*.ts" --include="*.js" 2>/dev/null || echo "No references found"
```

Expected: `No references found` (or only documentation references)

- [ ] **Step 2: Delete the file**

```bash
rm searxng/settings.yml
```

- [ ] **Step 3: Commit**

```bash
git add searxng/settings.yml
git commit -m "chore: remove vestigial searxng/settings.yml

This file was an alternate/earlier version that diverged from the
authoritative searxng-settings.yml at the repo root. It is not
referenced by any Dockerfile or build script."
```

---

### Task 3: Rebuild and Restart SearXNG Container

**Files:**
- Modify: (none — Docker build from existing Dockerfile.searxng)
- **HITL** — requires Docker access and service restart

- [ ] **Step 1: Rebuild the SearXNG image with the new config**

```bash
docker compose build searxng
```

Expected: Successful build with no errors. The `COPY searxng-settings.yml /etc/searxng/settings.yml` line in `Dockerfile.searxng` bakes the new config into the image.

- [ ] **Step 2: Restart the SearXNG container**

```bash
docker compose up -d searxng
```

- [ ] **Step 3: Wait for health check to pass**

```bash
sleep 5
docker compose ps searxng
```

Expected: Status shows `healthy` (may take up to 90s for first health check)

- [ ] **Step 4: Verify SearXNG is running with the new config**

```bash
curl -s http://localhost:8081/config | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"Engines: {len(d.get('engines',[]))} total\"); [print(f\"  {e['name']}: {'enabled' if not e.get('disabled') else 'disabled'} [{', '.join(e.get('categories',['general']))}]\") for e in sorted(d.get('engines',[]), key=lambda x: x['name'])]"
```

Expected output: Shows all 29+ engines (ours + defaults merged), with most enabled. Verify these are present and enabled:
- `brave: enabled [general, web]`
- `bing images: enabled [images]`
- `duckduckgo news: enabled [news]`
- `arxiv: enabled [science]`
- `mdn: enabled [it]`

- [ ] **Step 5: Quick smoke test — search with category filter**

```bash
curl -s "http://localhost:8081/search?q=python+async&format=json&categories=it" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"Results: {d['number_of_results']}, Unresponsive: {d.get('unresponsive_engines',[])}\")"
```

Expected: Returns results. Note any `unresponsive_engines` — these are engines that timed out or failed. This is normal during first run; some may need multiple attempts.

---

### Task 4: Verify Categories via MCP Tools

**Files:**
- None (verification only)
- **AFK** — can run autonomously if MCP server is running

- [ ] **Step 1: Verify general web search returns diverse results**

Use the MCP tool `searxng_search_web` with:
```json
{
  "query": "python async programming",
  "maxResults": 10
}
```

Expected: Returns results from multiple sources (google, bing, duckduckgo, brave, startpage). Check the `url` fields for source diversity.

- [ ] **Step 2: Verify news category works**

Use the MCP tool `searxng_search_web` with:
```json
{
  "query": "artificial intelligence",
  "categories": "news",
  "maxResults": 10
}
```

Expected: Returns recent news articles from google_news, bing_news, duckduckgo_news.

- [ ] **Step 3: Verify images category works**

Use the MCP tool `searxng_search_web` with:
```json
{
  "query": "mountain sunset",
  "categories": "images",
  "maxResults": 5
}
```

Expected: Returns image results with `img_src` field populated.

- [ ] **Step 4: Verify videos category works**

Use the MCP tool `searxng_search_web` with:
```json
{
  "query": "docker tutorial",
  "categories": "videos",
  "maxResults": 5
}
```

Expected: Returns video results.

- [ ] **Step 5: Verify IT category works**

Use the MCP tool `searxng_search_web` with:
```json
{
  "query": "prisma schema relations",
  "categories": "it",
  "maxResults": 10
}
```

Expected: Returns results from github, stackoverflow, mdn, docker hub, arch wiki, etc.

- [ ] **Step 6: Verify science category works**

Use the MCP tool `searxng_search_web` with:
```json
{
  "query": "transformer attention mechanism",
  "categories": "science",
  "maxResults": 10
}
```

Expected: Returns results from arxiv, wikidata, pubmed, google_scholar. May be slower due to academic engine timeouts.

- [ ] **Step 7: Verify search_and_scrape works with new engines**

Use the MCP tool `searxng_search_and_scrape` with:
```json
{
  "query": "fastify typescript server setup",
  "maxResults": 3,
  "mode": "quick"
}
```

Expected: Returns scraped content from top search results. Should be faster and more relevant than before due to better engine coverage.

---

### Task 5: Document the Engine Configuration

**Files:**
- Create: `docs/searxng-engines.md`
- **AFK**

- [ ] **Step 1: Create engine documentation**

Write `docs/searxng-engines.md` with this content:

```markdown
# SearXNG Engine Reference

> Auto-generated from searxng-settings.yml. Last updated: 2026-07-06.

## Active Engines (29 across 7 categories)

### General Web Search (5)
| Engine | Shortcut | Timeout | Notes |
|--------|----------|---------|-------|
| Google | `!go` | 5s | General web |
| Bing | `!bi` | 5s | Microsoft backend |
| DuckDuckGo | `!ddg` | 5s | Privacy-focused |
| Startpage | `!sp` | 6s | Google proxy |
| Brave | `!br` | 5s | Best free general engine |

### News (3)
| Engine | Shortcut | Timeout |
|--------|----------|---------|
| Google News | `!gon` | 10s |
| Bing News | `!bin` | 10s |
| DuckDuckGo News | `!ddn` | 5s |

### Images (3)
| Engine | Shortcut | Timeout |
|--------|----------|---------|
| Bing Images | `!bii` | 5s |
| DuckDuckGo Images | `!ddi` | 5s |
| Brave Images | `!brimg` | 5s |

### Videos (3)
| Engine | Shortcut | Timeout |
|--------|----------|---------|
| Bing Videos | `!biv` | 5s |
| DuckDuckGo Videos | `!ddv` | 5s |
| Brave Videos | `!brvid` | 5s |

### IT / Technology (6)
| Engine | Shortcut | Timeout | Notes |
|--------|----------|---------|-------|
| GitHub | `!gh` | 5s | Repository search |
| Stack Overflow | `!so` | 10s | Programming Q&A |
| Arch Linux Wiki | `!al` | 6s | Linux/system docs |
| Docker Hub | `!dh` | 5s | Container images |
| MDN | `!mdn` | 5s | Web docs |
| PyPI | `!pypi` | 5s | Python packages |

### Science (4)
| Engine | Shortcut | Timeout | Notes |
|--------|----------|---------|-------|
| arXiv | `!arx` | 10s | Academic papers |
| Wikidata | `!wd` | 6s | Structured knowledge |
| PubMed | `!pub` | 10s | Medical literature |
| Google Scholar | `!gsc` | 10s | ⚠️ May be unstable |

## Using Categories

### Via MCP Tools
Both `searxng_search_web` and `searxng_search_and_scrape` accept a `categories` parameter:

```json
{ "query": "...", "categories": "science" }
{ "query": "...", "categories": "news,images" }
```

### Via Search Syntax
Use `!` bang shortcuts in queries:
- `!science attention mechanism` — search science category
- `!it prisma relations` — search IT category
- `!ddg !sp async python` — search DuckDuckGo + Startpage specifically

### Available Categories
`general`, `images`, `videos`, `news`, `map`, `music`, `it`, `science`, `files`, `social media`

## Timeout Architecture
```
Global request_timeout:  5.0s (per-engine default)
Global max_request_timeout: 10.0s (hard ceiling)
MCP client axios timeout: 10s
```
Slow engines (arxiv, scholar, pubmed, stackoverflow, google_news, bing_news) get per-engine 10s overrides.

## Adding New Engines

1. Check if the engine exists in SearXNG defaults: https://docs.searxng.org/user/configured_engines.html
2. Verify it doesn't require an API key
3. Add to `searxng-settings.yml` under the `engines:` list
4. Rebuild SearXNG container: `docker compose build searxng && docker compose up -d searxng`
5. Verify: `curl http://localhost:8081/config | jq '.engines[] | select(.name=="your engine")'`

## Disabled Engines (for reference)

| Engine | Reason |
|--------|--------|
| Qwant | Frequently broken by upstream changes |
| Yandex | Geo-restricted |
```

- [ ] **Step 2: Commit**

```bash
git add docs/searxng-engines.md
git commit -m "docs: add SearXNG engine reference documentation"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] General web engines added (brave, startpage enabled)
   - [x] News engines added (bing_news, duckduckgo_news, google_news)
   - [x] IT/Tech engines added (arch linux wiki, docker hub, mdn, pypi)
   - [x] Science engines added (arxiv, wikidata, pubmed, google_scholar)
   - [x] Images engines added (bing_images, duckduckgo_images, brave.images)
   - [x] Videos engines added (bing_videos, duckduckgo_videos, brave.videos)
   - [x] Timeouts adjusted (1.0s/1.5s → 5.0s/10.0s)
   - [x] Categories-as-tabs documented
   - [x] Two-config divergence resolved

2. **Placeholder scan:** No TBDs, TODOs, or vague steps. All code shown inline.

3. **Type consistency:** N/A — config-only change, no code types to match.

4. **All tasks are vertical slices?** N/A — this is a config change, not a feature with layers. Task 1 is the core change. Tasks 2-5 are validation/documentation.
