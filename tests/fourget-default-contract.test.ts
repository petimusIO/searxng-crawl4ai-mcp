import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('4get default scraper contract', () => {
  it('does not default any server path to blocked Brave', () => {
    expect(indexSource).not.toContain("args.scraper || 'brave'");
    expect(indexSource).not.toContain('Default: "brave"');
  });

  it('does not advertise unsupported Bing as a 4get scraper', () => {
    expect(indexSource).not.toContain('"brave", "google", "bing"');
  });

  it('uses the shared DDG default in every server path', () => {
    expect(indexSource.match(/DEFAULT_FOURGET_SCRAPER/g)).toHaveLength(6);
  });
});
