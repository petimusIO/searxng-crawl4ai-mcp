import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { SearXNGMCPServer } from '../src/index.js';

class NodeEventSource {
  onopen: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  private listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  private abort = new AbortController();

  constructor(public url: string) {
    void this.connect();
  }

  addEventListener(type: string, listener: (ev: { data: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() {
    this.readyState = 2;
    this.abort.abort();
  }

  private emit(type: string, data: string) {
    const ev = { data };
    if (type === 'message') this.onmessage?.(ev);
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }

  private async connect() {
    try {
      const res = await fetch(this.url, {
        headers: { Accept: 'text/event-stream' },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      this.readyState = 1;
      this.onopen?.({});
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length) this.emit(event, dataLines.join('\n'));
          sep = buf.indexOf('\n\n');
        }
      }
    } catch (err) {
      this.readyState = 2;
      this.onerror?.(err);
    }
  }
}

(globalThis as { EventSource?: typeof NodeEventSource }).EventSource = NodeEventSource;

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolText(result: { content?: Array<{ text?: string }> }) {
  return JSON.parse(result.content?.[0]?.text || '{}') as { query?: string };
}

function stubTools(host: SearXNGMCPServer) {
  const target = host as unknown as {
    handleSearchImages: (args: { query: string }) => Promise<unknown>;
    handleResearch: (args: { query: string }) => Promise<unknown>;
    handleSearchWeb: (args: { query: string }) => Promise<unknown>;
    handleScrapeUrl: (args: { url?: string }) => Promise<unknown>;
  };
  target.handleSearchImages = async (args) => ({
    content: [{ type: 'text', text: JSON.stringify({ query: args.query, images: [{ title: 'img' }] }) }],
  });
  target.handleResearch = async (args) => {
    await delay(40);
    return {
      content: [{ type: 'text', text: JSON.stringify({ query: args.query, results: [{ title: 'research' }] }) }],
    };
  };
  target.handleSearchWeb = async (args) => ({
    content: [{ type: 'text', text: JSON.stringify({ query: args.query, results: [] }) }],
  });
  target.handleScrapeUrl = async () => ({
    content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
  });
}

async function httpPort(host: SearXNGMCPServer): Promise<number> {
  const httpServer = (host as unknown as { httpServer?: HttpServer }).httpServer;
  if (!httpServer) throw new Error('MCP HTTP server did not start');
  if (!httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', () => resolve());
      httpServer.once('error', reject);
    });
  }
  const addr = httpServer.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== 'number') throw new Error('MCP HTTP has no port');
  return addr.port;
}

async function connectClient(url: string, name: string) {
  const transport = new SSEClientTransport(new URL(url));
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await withTimeout(client.connect(transport), 4000, `${name} initialize`);
  return { client, transport };
}

describe('SSE transport isolation', () => {
  let host: SearXNGMCPServer | undefined;
  let clients: Client[] = [];

  beforeAll(() => {
    process.env.MCP_HTTP_PORT = '0';
    process.env.CACHE_ENABLED = 'false';
    process.env.MCP_MODE = '1';
    delete process.env.MCP_INTERNAL_TOKEN;
  });

  afterEach(async () => {
    await Promise.allSettled(
      clients.map((client) => withTimeout(client.close(), 1000, 'client close').catch(() => {})),
    );
    clients = [];
    const httpServer = host ? (host as unknown as { httpServer?: HttpServer }).httpServer : undefined;
    const cache = host ? (host as unknown as { cache?: { disconnect?: () => Promise<void> } }).cache : undefined;
    host = undefined;
    httpServer?.closeAllConnections?.();
    await withTimeout(
      new Promise<void>((resolve) => {
        if (!httpServer) return resolve();
        httpServer.close(() => resolve());
      }),
      1000,
      'http close',
    ).catch(() => {});
    await cache?.disconnect?.().catch(() => {});
  });

  async function startHost() {
    host = new SearXNGMCPServer();
    stubTools(host);
    const port = await httpPort(host);
    return `http://127.0.0.1:${port}/sse`;
  }

  it('initializes two SDK clients at once and multiplexes tools per connection', async () => {
    const url = await startHost();
    const [alpha, beta] = await Promise.all([
      connectClient(url, 'alpha'),
      connectClient(url, 'beta'),
    ]);
    clients.push(alpha.client, beta.client);

    const listed = await withTimeout(alpha.client.listTools(), 3000, 'tools/list');
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['search_images', 'research', 'search_web', 'scrape_url']),
    );

    const [images, research] = await Promise.all([
      withTimeout(alpha.client.callTool({ name: 'search_images', arguments: { query: 'saturn' } }), 3000, 'alpha images'),
      withTimeout(alpha.client.callTool({ name: 'research', arguments: { query: 'saturn' } }), 3000, 'alpha research'),
    ]);
    expect(toolText(images).query).toBe('saturn');
    expect(toolText(research).query).toBe('saturn');

    const [ownA, ownB] = await Promise.all([
      withTimeout(alpha.client.callTool({ name: 'search_images', arguments: { query: 'alpha' } }), 3000, 'alpha own'),
      withTimeout(beta.client.callTool({ name: 'search_images', arguments: { query: 'beta' } }), 3000, 'beta own'),
    ]);
    expect(toolText(ownA).query).toBe('alpha');
    expect(toolText(ownB).query).toBe('beta');
  }, 8000);

  it('keeps the other client usable after one SSE session closes', async () => {
    const url = await startHost();
    const [alpha, beta] = await Promise.all([
      connectClient(url, 'alpha-close'),
      connectClient(url, 'beta-stay'),
    ]);
    clients.push(beta.client);

    await withTimeout(alpha.client.close(), 2000, 'alpha close');
    const listed = await withTimeout(beta.client.listTools(), 3000, 'beta tools after peer close');
    expect(listed.tools.map((tool) => tool.name)).toContain('search_images');
    const still = await withTimeout(
      beta.client.callTool({ name: 'search_images', arguments: { query: 'still-here' } }),
      3000,
      'beta after peer close',
    );
    expect(toolText(still).query).toBe('still-here');
  }, 8000);
});
