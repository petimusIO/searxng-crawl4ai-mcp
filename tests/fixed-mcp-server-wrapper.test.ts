import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const wrapperUrl = new URL('../fixed-mcp-server.js', import.meta.url);
const wrapperPath = fileURLToPath(wrapperUrl);
const wrapperSource = readFileSync(wrapperUrl, 'utf8');

const WRAPPER_ENV = [
  "process.env.MCP_MODE = '1'",
  "process.env.SEARXNG_URL = 'http://localhost:8081'",
  "process.env.SPIDER_URL = 'http://localhost:8002'",
  "process.env.CRW_URL = 'http://localhost:8001'",
  "process.env.REDIS_URL = 'redis://localhost:6380'",
  "process.env.WEB_SEARCH_CRAWL_TIMEOUT_MS = '1000'",
  "process.env.WEB_SEARCH_CRAWL_BATCH_TIMEOUT_MS = '1500'",
];

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('fixed-mcp-server wrapper', () => {
  let client: Client | undefined;

  beforeAll(() => {
    // The actual wrapper loads dist, which is absent in a fresh checkout.
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    ], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 60000,
      stdio: 'pipe',
    });
  }, 65000);

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = undefined;
    }
  });

  it('keeps the existing local-dev env assignments', () => {
    for (const assignment of WRAPPER_ENV) {
      expect(wrapperSource).toContain(assignment);
    }
  });

  it('starts over stdio and answers tools/list', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [wrapperPath],
      env: {
        ...getDefaultEnvironment(),
        MCP_HTTP_PORT: '0',
        CACHE_ENABLED: 'false',
      },
      stderr: 'ignore',
    });
    client = new Client(
      { name: 'a1-wrapper-regression', version: '1.0.0' },
      { capabilities: {} },
    );

    await withTimeout(client.connect(transport), 5000, 'wrapper initialize');
    const listed = await withTimeout(client.listTools(), 5000, 'tools/list');
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(['search_web', 'research', 'scrape_url']));
  }, 12000);
});
