import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('research scrape timeout policy', () => {
  it('defaults RESEARCH_SCRAPE_TIMEOUT_MS to 3000 and honors MCP_RESEARCH_SCRAPE_TIMEOUT_MS', () => {
    expect(indexSource).toContain(
      'const RESEARCH_SCRAPE_TIMEOUT_MS   = Number(process.env.MCP_RESEARCH_SCRAPE_TIMEOUT_MS) || 3000;'
    );
  });

  it('keeps scrape_url timeout as a caller-selectable 30000ms default', () => {
    expect(indexSource).toContain("name: 'scrape_url'");
    expect(indexSource).toMatch(
      /timeout:\s*\{\s*type:\s*'number',\s*description:\s*'Timeout in milliseconds',\s*default:\s*30000,/
    );
    expect(indexSource).toContain('timeout || 30000');
    expect(indexSource).toContain('timeout: number = 30000');
  });
});
