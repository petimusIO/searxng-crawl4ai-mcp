import { AsyncLocalStorage } from 'node:async_hooks';
import { Console } from 'node:console';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

type Status = 'success' | 'error' | 'timeout' | 'partial' | 'validation_error' | 'hit' | 'miss' | 'cached' | 'skipped';
interface TimingContext {
  ids: Record<string, string>;
  origin: number;
  wallOrigin: number;
  tool: string;
  cached: boolean;
  sourceIndex?: number;
}
// Request-local state only: concurrent SDK sessions and parallel pages never share IDs.
const timing = new AsyncLocalStorage<TimingContext>();
// Console's ignoreErrors also handles asynchronous stream write errors.
const timingLog = new Console({ stdout: process.stderr, stderr: process.stderr, ignoreErrors: true });

export function errorTimingStatus(error: unknown): Status {
  const value = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  return value && (value.code === 'ECONNABORTED' || value.code === 'ETIMEDOUT'
    || value.name === 'TimeoutError' || value.name === 'AbortError'
    || (typeof value.message === 'string' && /timed?\s*out|timeout/i.test(value.message))) ? 'timeout' : 'error';
}

export function resultTimingStatus(value: any): Status {
  if (value?.route === 'fourget-partial') return 'partial';
  if (value?.route === 'empty') return 'error';
  if (value?.success === false || (value?.status && value.status !== 'ok')) return 'error';
  return 'success';
}

function begin(stage: string, inclusive = false) {
  const context = timing.getStore();
  if (!context) return (_status: Status) => {};
  const start = performance.now();
  return (status: Status) => {
    // A broken/closed log destination must never fail a request. stderr is MCP
    // stdio-safe and captured by Docker even when Winston's MCP console is off.
    try {
      timingLog.error(JSON.stringify({
        event: 'search.timing', stage, status,
        durationMs: Math.max(0, performance.now() - start),
        startedAt: new Date(context.wallOrigin + start - context.origin).toISOString(),
        startOffsetMs: Math.max(0, start - context.origin),
        ...context.ids, tool: context.tool,
        ...(context.sourceIndex !== undefined ? { sourceIndex: context.sourceIndex } : {}),
        ...(inclusive ? { inclusive: true } : {}),
      }));
    } catch { /* best-effort observability */ }
  };
}

// Page identity is the selected-source ordinal, never a URL or completion order.
export function withSourceTiming<T>(sourceIndex: number, work: () => T): T {
  const context = timing.getStore();
  return context ? timing.run({ ...context, sourceIndex }, work) : work();
}

// The opaque ID links CRW's internal spans to this exact uncached page request.
// Keep it in a child context so sibling pages and parent spans cannot inherit it.
export function withCrwTiming<T>(work: (crwRequestId: string) => Promise<T>, status: (value: T) => Status = resultTimingStatus): Promise<T> {
  const crwRequestId = randomUUID();
  const context = timing.getStore();
  if (!context) return work(crwRequestId);
  return timing.run({ ...context, ids: { ...context.ids, crwRequestId } }, () =>
    timedAsync('mcp.crw.request', () => work(crwRequestId), status, true));
}

export function timedSync<T>(stage: string, work: () => T, inclusive = false, status: (result: T) => Status = () => 'success'): T {
  const finish = begin(stage, inclusive);
  try { const result = work(); finish(status(result)); return result; }
  catch (error) { finish(errorTimingStatus(error)); throw error; }
}

export async function timedAsync<T>(
  stage: string, work: () => Promise<T>,
  status: (result: T) => Status = resultTimingStatus,
  inclusive = false,
): Promise<T> {
  const finish = begin(stage, inclusive);
  try { const result = await work(); finish(status(result)); return result; }
  catch (error) { finish(errorTimingStatus(error)); throw error; }
}

export function skipTiming(stage: string, status: 'cached' | 'skipped' = 'skipped') {
  begin(stage)(status);
}

export function cachedTiming(stages: string[]) {
  const context = timing.getStore();
  if (context) context.cached = true;
  for (const stage of stages) skipTiming(stage, 'cached');
}

// Keep function signatures intact, and evaluate caller arguments (including
// ranking) before starting an inclusive packing span.
export function timedFunction<F extends (...args: any[]) => any>(stage: string, fn: F, inclusive = false): F {
  return ((...args: Parameters<F>) => timedSync(stage, () => fn(...args), inclusive)) as F;
}
export const timingStringify: typeof JSON.stringify = (...args: any[]) =>
  timedSync('mcp.serialization', () => (JSON.stringify as any)(...args));

export function responseTimingStatus(response: any): Status {
  if (timing.getStore()?.cached) return 'cached';
  try {
    const body = JSON.parse(response?.content?.[0]?.text || '{}');
    if (body.error === 'invalid_arguments') return 'validation_error';
    if (body.error || body.success === false) return 'error';
    if (body.fetch?.outcome) return body.fetch.outcome === 'degraded' ? 'partial' : 'error';
    if (body.engine_info?.route === 'fourget-partial') return 'partial';
    if (body.engine_info?.route === 'empty') return 'error';
  } catch { /* Do not change response validation or bytes. */ }
  return 'success';
}

export function withSearchTiming<T>(meta: unknown, tool: string, work: () => Promise<T>): Promise<T> {
  const ids: Record<string, string> = { operationId: randomUUID() };
  const input = (meta as Record<string, unknown> | undefined)?.['seek/timing'];
  if (input && typeof input === 'object') {
    for (const name of ['searchId', 'traceId', 'requestId', 'mcpCallId']) {
      const id = (input as Record<string, unknown>)[name];
      if (typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)) ids[name] = id;
    }
  }
  const context: TimingContext = {
    ids, origin: performance.now(), wallOrigin: Date.now(), cached: false,
    tool: ['websearch', 'webfetch'].includes(tool) ? tool : 'unknown',
  };
  return timing.run(context, () => timedAsync('mcp.request.total', work, responseTimingStatus, true));
}
