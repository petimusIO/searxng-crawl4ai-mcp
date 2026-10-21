import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

describe('webfetch timeout configuration', () => {
  it.each([
    ['4500', 4500],
    ['', 3000],
    ['invalid', 3000],
    ['-1', 3000],
    ['0', 3000],
    ['1.5', 3000],
    ['Infinity', 3000],
  ])('loads MCP_WEBFETCH_TIMEOUT_MS=%s from dotenv with schema/runtime parity', (configured, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'webfetch-timeout-'));
    writeFileSync(join(dir, '.env'), `MCP_WEBFETCH_TIMEOUT_MS=${configured}\n`);
    const env = { ...process.env };
    delete env.MCP_WEBFETCH_TIMEOUT_MS;
    delete env.DOTENV_CONFIG_PATH;
    const index = pathToFileURL(resolve('dist/index.js')).href;
    const fetchModule = pathToFileURL(resolve('dist/tools/webfetch.js')).href;
    const script = `
      const { SearXNGMCPServer } = await import(${JSON.stringify(index)});
      const { WebFetchTool } = await import(${JSON.stringify(fetchModule)});
      const host = Object.create(SearXNGMCPServer.prototype);
      const handlers = new Map();
      host.setupToolHandlers({ setRequestHandler: (schema, fn) => handlers.set(schema.shape.method.value, fn) });
      const list = await handlers.get('tools/list')({});
      const advertised = list.tools.find(tool => tool.name === 'webfetch').inputSchema.properties.timeout.default;
      const timeouts = [];
      const fetcher = new WebFetchTool({ get: async () => null, set: async () => {} });
      fetcher.getScrapeClient = () => ({ scrape: async (url, options) => {
        timeouts.push(options.timeout);
        return { success: false, url, error: 'blocked test fixture' };
      } });
      await fetcher.handle({ url: 'https://timeout-config.test/default' });
      await fetcher.handle({ url: 'https://timeout-config.test/explicit', timeout: 8000 });
      await fetcher.handle({ url: 'https://timeout-config.test/zero', timeout: 0 });
      console.log('TIMEOUT_CONFIG_RESULT ' + JSON.stringify({ advertised, timeouts }));
    `;
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split('\n').find(row => row.startsWith('TIMEOUT_CONFIG_RESULT '));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice('TIMEOUT_CONFIG_RESULT '.length))).toEqual({ advertised: expected, timeouts: [expected, 8000, expected] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
