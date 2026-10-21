import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

describe('CLI configuration bootstrap', () => {
  it('loads dotenv before the extracted tool modules read their provider policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'two-tool-bootstrap-'));
    writeFileSync(join(dir, '.env'), 'MCP_FOURGET_MIN_RESULTS=1\n');
    const env = { ...process.env };
    delete env.MCP_FOURGET_MIN_RESULTS;
    delete env.DOTENV_CONFIG_PATH;
    const index = pathToFileURL(resolve('dist/index.js')).href;
    const search = pathToFileURL(resolve('dist/tools/websearch.js')).href;
    try {
      const script = `
        await import(${JSON.stringify(index)});
        const { WebSearchTool } = await import(${JSON.stringify(search)});
        let fallbacks = 0;
        const searxng = { search: async () => { fallbacks++; return { results: [] }; } };
        const fourget = { search: async () => ({ status: 'ok', web: [{ title: 'Configured primary', url: 'https://primary.example/page', description: 'Real primary-shaped fixture', date: null, type: 'web' }], answer: [], npt: '' }) };
        const cache = { get: async () => null, set: async () => {} };
        const result = await new WebSearchTool(searxng, fourget, cache).handle({ query: 'startup config' });
        console.log('STARTUP_RESULT ' + JSON.stringify({ configured: process.env.MCP_FOURGET_MIN_RESULTS, fallbacks, route: JSON.parse(result.content[0].text).engine_info.route }));
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split('\n').find((row) => row.startsWith('STARTUP_RESULT '));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice('STARTUP_RESULT '.length))).toEqual({ configured: '1', fallbacks: 0, route: 'fourget' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
