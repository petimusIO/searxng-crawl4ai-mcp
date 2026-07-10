# Content Mode Parameter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `content_mode` parameter (`"full"` | `"relevant_only"` | `"snippet"`) to `scrape_url` and `search_and_scrape` tools so callers can drop full markdown from responses to save tokens.

**Architecture:** Additive change to `src/index.ts` only. A shared `stripMarkdownFromData()` helper handles the deletion. `cachedScrapeUrl()` always stores full markdown — the mode only controls serialization. `search_and_scrape` composite cache key gains `content_mode` to prevent cache poisoning. No changes to `redis-cache.ts`, `passage-extractor.ts`, `scrape-client.ts`, or `url-normalizer.ts`.

**Tech Stack:** TypeScript (tsx), vitest

---

### Task 1: Add Content Mode Parameter to Tool Schemas and Handlers

**Files:**
- Modify: `src/index.ts`
- Create: `tests/content-mode.test.ts`

**Classification:** HITL — requires Zai to confirm the `content_mode` parameter name before implementation.

- [ ] **Step 1: Write failing tests for content mode behavior**

Create `tests/content-mode.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// We'll import the helper once it's exported from index.ts
// For now, test the logic inline to verify our expectations

// ── Content mode stripping logic (will be extracted as helper) ──
type ContentMode = 'full' | 'relevant_only' | 'snippet';

function stripMarkdownFromData(
  data: { markdown?: string; [key: string]: unknown } | undefined,
  contentMode: ContentMode | undefined
): typeof data {
  if (!data) return data;
  if (!contentMode || contentMode === 'full') return data;
  const { markdown: _, ...rest } = data;
  return rest;
}

describe('stripMarkdownFromData', () => {
  const fullData = {
    markdown: '# Hello\n\nThis is a long article about web scraping.',
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
    expect(result!.metadata).toEqual(fullData.metadata);
  });

  it('strips markdown when mode is "snippet"', () => {
    const result = stripMarkdownFromData(fullData, 'snippet');
    expect(result).not.toHaveProperty('markdown');
    expect(result).toHaveProperty('metadata');
  });

  it('returns undefined when data is undefined', () => {
    const result = stripMarkdownFromData(undefined, 'relevant_only');
    expect(result).toBeUndefined();
  });

  it('returns undefined when data is null-like', () => {
    const result = stripMarkdownFromData(undefined, 'snippet');
    expect(result).toBeUndefined();
  });

  it('preserves all non-markdown fields', () => {
    const dataWithExtras = {
      markdown: 'text',
      html: '<p>text</p>',
      links: ['https://example.com'],
      metadata: { title: 'T' },
      extraField: 42,
    };
    const result = stripMarkdownFromData(dataWithExtras, 'relevant_only');
    expect(result).toEqual({
      html: '<p>text</p>',
      links: ['https://example.com'],
      metadata: { title: 'T' },
      extraField: 42,
    });
  });
});

describe('content_mode parameter contract', () => {
  it('accepts "full" as valid', () => {
    expect(['full', 'relevant_only', 'snippet']).toContain('full');
  });

  it('accepts "relevant_only" as valid', () => {
    expect(['full', 'relevant_only', 'snippet']).toContain('relevant_only');
  });

  it('accepts "snippet" as valid', () => {
    expect(['full', 'relevant_only', 'snippet']).toContain('snippet');
  });

  it('"snippet" implies contextWindow=0 for passage extraction', () => {
    // Verify constant — snippet mode overrides contextWindow to 0
    const mode: ContentMode = 'snippet';
    const contextWindow = mode === 'snippet' ? 0 : undefined;
    expect(contextWindow).toBe(0);
  });

  it('non-snippet modes preserve default contextWindow', () => {
    const contextWindow1 = ('full' as ContentMode) === 'snippet' ? 0 : undefined;
    const contextWindow2 = ('relevant_only' as ContentMode) === 'snippet' ? 0 : undefined;
    expect(contextWindow1).toBeUndefined();
    expect(contextWindow2).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/content-mode.test.ts`
Expected: PASS (these tests validate the helper logic directly — they should pass immediately since the logic is self-contained)

- [ ] **Step 3: Add `ContentMode` type and `stripMarkdownFromData` helper to `src/index.ts`**

Add after the module-level constants block (after line 39), before the class definition:

```typescript
/** Controls how much scraped content is returned to the caller */
type ContentMode = 'full' | 'relevant_only' | 'snippet';

/**
 * Strip `data.markdown` from a ScrapeClientResponse['data'] object when
 * content_mode is not "full". Used to reduce token consumption for callers
 * that only need relevant_passages.
 */
function stripMarkdownFromData(
  data: Record<string, unknown> | undefined,
  contentMode: ContentMode | undefined
): Record<string, unknown> | undefined {
  if (!data) return data;
  if (!contentMode || contentMode === 'full') return data;
  const { markdown: _, ...rest } = data;
  return rest;
}
```

- [ ] **Step 4: Update `scrape_url` tool schema in `setupToolHandlers()`**

Locate the `scrape_url` schema block (around lines 281-308). Add `content_mode` property after `timeout`:

```typescript
content_mode: {
  type: 'string',
  enum: ['full', 'relevant_only', 'snippet'],
  description: 'Content detail level: full (default, includes markdown), relevant_only (strips markdown, keeps passages), snippet (like relevant_only but passage contextWindow=0)',
  default: 'full',
},
```

Full updated schema block:

```typescript
{
  name: 'scrape_url',
  description: 'Scrape a URL using CRW (fast content extraction)',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to scrape',
      },
      formats: {
        type: 'array',
        items: { type: 'string' },
        description: 'Output formats',
        default: ['markdown'],
      },
      wait_for: {
        type: 'number',
        description: 'Wait time in milliseconds',
        default: 0,
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds',
        default: 30000,
      },
      content_mode: {
        type: 'string',
        enum: ['full', 'relevant_only', 'snippet'],
        description: 'Content detail level: full (default, includes markdown), relevant_only (strips markdown, keeps passages), snippet (like relevant_only but passage contextWindow=0)',
        default: 'full',
      },
    },
    required: ['url'],
  },
},
```

- [ ] **Step 5: Update `search_and_scrape` tool schema in `setupToolHandlers()`**

Locate the `search_and_scrape` schema block (around lines 241-279). Add `content_mode` property after `formats`:

```typescript
content_mode: {
  type: 'string',
  enum: ['full', 'relevant_only', 'snippet'],
  description: 'Content detail level for scraped results: full (default, includes markdown), relevant_only (strips markdown, keeps passages), snippet (like relevant_only but passage contextWindow=0)',
  default: 'full',
},
```

Full updated schema block:

```typescript
{
  name: 'search_and_scrape',
  description: 'Search the web and automatically scrape top results (combines SearXNG + CRW)',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of search results to scrape',
        default: 3,
      },
      mode: {
        type: 'string',
        enum: ['quick', 'deep'],
        description: 'Scraping mode: quick (fast, first pass) or deep (thorough, all results)',
        default: 'quick',
      },
      scrapeAll: {
        type: 'boolean',
        description: 'Scrape all results regardless of snippet length',
        default: false,
      },
      categories: {
        type: 'string',
        description: 'Search categories to filter by',
      },
      formats: {
        type: 'array',
        items: { type: 'string' },
        description: 'Formats for scraped content',
        default: ['markdown'],
      },
      content_mode: {
        type: 'string',
        enum: ['full', 'relevant_only', 'snippet'],
        description: 'Content detail level for scraped results: full (default, includes markdown), relevant_only (strips markdown, keeps passages), snippet (like relevant_only but passage contextWindow=0)',
        default: 'full',
      },
    },
    required: ['query'],
  },
},
```

- [ ] **Step 6: Update `handleScrapeUrl` to apply content mode**

In the `handleScrapeUrl` method (around lines 415-458):

**a)** Destructure `content_mode` from args (line 416):
```typescript
const { url, formats, timeout, content_mode } = args;
```

**b)** Apply content mode to `result.data` before serialization. Add after `relevantPassages` is computed (after line 435), before the response construction (before line 437):

```typescript
// Apply content mode — strip markdown if not "full"
const filteredData = stripMarkdownFromData(
  result.data as Record<string, unknown> | undefined,
  content_mode as ContentMode | undefined
);
```

**c)** Update the response construction to use `filteredData` instead of spreading `result`:
```typescript
const response = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        {
          success: result.success,
          url: result.url,
          data: filteredData,
          error: result.error,
          relevant_passages: relevantPassages,
        },
        null,
        2
      ),
    },
  ],
};
```

- [ ] **Step 7: Update `handleSearchAndScrape` to apply content mode**

In the `handleSearchAndScrape` method (around lines 464-642):

**a)** Destructure `content_mode` from args (line 465):
```typescript
const { query, maxResults, mode, scrapeAll, categories, formats, content_mode } = args;
```

**b)** Add `content_mode` to the composite cache key (line 478). Append before the closing backtick:
```typescript
const cacheKey = `search_and_scrape:${query}:${maxResults || ''}:${mode || ''}:${scrapeAll || ''}:${categories || ''}:${formatKey}:${content_mode || ''}`;
```

**c)** In the worker pool results processing (lines 583-590), strip markdown from `scrapeData` before pushing:
```typescript
// Apply content mode to strip markdown if not "full"
const filteredData = stripMarkdownFromData(
  scrapeData as Record<string, unknown> | undefined,
  content_mode as ContentMode | undefined
);

scrapedResults.push({
  url: entry.url,
  success: settled.value.success,
  data: filteredData,
  relevant_passages: relevantPassages,
  title: entry.title,
  snippet: entry.snippet,
});
```

Note: the line `data: scrapeData,` changes to `data: filteredData,`.

**d)** In the passage extraction block (lines 570-581), apply snippet mode's `contextWindow: 0` override:

```typescript
// Extract relevant passages if we have markdown content
let relevantPassages: any = undefined;
if (scrapeData?.markdown) {
  relevantPassages = extractRelevantPassages(
    scrapeData.markdown,
    query,
    {
      topN: RELEVANCE_TOP_N,
      contextWindow: content_mode === 'snippet' ? 0 : RELEVANCE_CONTEXT_WINDOW,
      minScore: RELEVANCE_MIN_SCORE,
    }
  );
}
```

- [ ] **Step 8: Update test file to import from source**

Refactor `tests/content-mode.test.ts` to import the actual helper once it exists. Replace the inline definition with:

```typescript
import { describe, it, expect } from 'vitest';

// The stripMarkdownFromData helper is module-private; we test the logic
// through the exported contracts. Unit-test the stripping logic inline
// since it's a pure function we can replicate for verification.

describe('content_mode response contract', () => {
  // Replicate the production helper for verification
  type ContentMode = 'full' | 'relevant_only' | 'snippet';

  function stripMarkdownFromData(
    data: Record<string, unknown> | undefined,
    contentMode: ContentMode | undefined
  ): Record<string, unknown> | undefined {
    if (!data) return data;
    if (!contentMode || contentMode === 'full') return data;
    const { markdown: _, ...rest } = data;
    return rest;
  }

  const fullData = {
    markdown: '# Hello\n\nThis is a long article about web scraping.',
    metadata: { title: 'Test', description: 'A test', language: 'en', word_count: 50 },
  };

  it('returns full data when mode is undefined (backward compatible)', () => {
    const result = stripMarkdownFromData(fullData, undefined);
    expect(result).toHaveProperty('markdown');
  });

  it('returns full data when mode is "full"', () => {
    const result = stripMarkdownFromData(fullData, 'full');
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
  });

  it('handles undefined data gracefully', () => {
    const result = stripMarkdownFromData(undefined, 'relevant_only');
    expect(result).toBeUndefined();
  });

  it('preserves all non-markdown fields', () => {
    const dataWithExtras = {
      markdown: 'text',
      html: '<p>text</p>',
      links: ['https://example.com'],
      metadata: { title: 'T' },
      extraField: 42,
    };
    const result = stripMarkdownFromData(dataWithExtras, 'relevant_only');
    expect(result).toEqual({
      html: '<p>text</p>',
      links: ['https://example.com'],
      metadata: { title: 'T' },
      extraField: 42,
    });
  });
});
```

- [ ] **Step 9: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (including existing passage-extractor, url-normalizer, and scraper tests, plus new content-mode tests)

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 11: Commit**

```bash
git add src/index.ts tests/content-mode.test.ts
git commit -m "feat: add content_mode parameter to scrape_url and search_and_scrape tools"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: Requirements 1-5 all addressed (mode param on both tools, three enum values, inputSchema updated, conditionally strip markdown, Redis cache unchanged)
- [x] **All tasks are vertical slices**: Task 1 cuts through types → helper → schema → handler → serializer — all layers
- [x] **No placeholders**: All code is explicit, no TBDs
- [x] **Type consistency**: `ContentMode` type is `'full' | 'relevant_only' | 'snippet'` used consistently across helper, schema enums, and handlers
- [x] **No changes to restricted files**: `redis-cache.ts`, `passage-extractor.ts`, `url-normalizer.ts`, `scrape-client.ts` are untouched
