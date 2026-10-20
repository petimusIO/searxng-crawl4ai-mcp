import { countTokens } from 'gpt-tokenizer/esm/encoding/o200k_base';

export const DEFAULT_MAX_TOKENS = 6000;
export const MIN_MAX_TOKENS = 512;
export const MAX_MAX_TOKENS = 32000;
export const TOKENIZER_NAME = 'o200k_base' as const;
export const BUDGET_SCOPE = 'response_text' as const;

export interface ResponseBudget {
  tokenizer: typeof TOKENIZER_NAME;
  limit: number;
  used: number;
  scope: typeof BUDGET_SCOPE;
}

export type MaxTokensValidation =
  | { ok: true; max_tokens: number }
  | { ok: false; error: string };

const ordinaryText = {
  allowedSpecial: new Set<string>(),
  disallowedSpecial: new Set<string>(),
};

export function serializeResponseText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function countResponseTokens(text: string): number {
  return countTokens(text, ordinaryText);
}

export function attachResponseBudget<T extends object>(
  payload: T,
  limit: number,
): T & { budget: ResponseBudget } {
  const packed = {
    ...payload,
    budget: {
      tokenizer: TOKENIZER_NAME,
      limit,
      used: 0,
      scope: BUDGET_SCOPE,
    },
  };
  const base = countResponseTokens(serializeResponseText(packed));
  let used = base;
  // o200k_base isolates decimal number runs from JSON punctuation/whitespace.
  // Only this numeric field changes, so settle its cost without re-encoding
  // every evidence section. The final wire guards still count the whole reply.
  const zeroCost = countResponseTokens('0');
  for (let i = 0; i < 8; i++) {
    const next = base - zeroCost + countResponseTokens(String(used));
    if (next === used) {
      packed.budget.used = used;
      return packed;
    }
    used = next;
  }
  throw new Error('Failed to stabilize response budget');
}

const UNTRUSTED_ERROR_KEYS = ['document_id', 'query', 'message', 'title', 'guidance'] as const;
const UNTRUSTED_CHAR_LIMIT = 80;
const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]{0,39}$/i;
const SHORT_ERROR_LIMIT = 200;

export function compactUntrustedText(value: string, maxChars = UNTRUSTED_CHAR_LIMIT): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

export function isStableErrorCode(value: string): boolean {
  return STABLE_ERROR_CODE.test(value);
}

export function boundUpstreamError(error: unknown): { error: string; diagnostic?: string } {
  const raw = typeof error === 'string' ? error.trim() : '';
  if (!raw) return { error: 'scrape_failed' };
  if (isStableErrorCode(raw)) return { error: raw };
  if (raw.length <= SHORT_ERROR_LIMIT && !/[\r\n]/.test(raw)) return { error: raw };
  return {
    error: 'upstream_error',
    diagnostic: compactUntrustedText(raw),
  };
}

export function prepareSafeErrorPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  if (typeof next.error === 'string') {
    const bounded = boundUpstreamError(next.error);
    next.error = bounded.error;
    if (bounded.diagnostic) next.diagnostic = bounded.diagnostic;
  }
  if (typeof next.diagnostic === 'string') {
    next.diagnostic = compactUntrustedText(next.diagnostic);
  }
  for (const key of UNTRUSTED_ERROR_KEYS) {
    if (typeof next[key] === 'string') {
      next[key] = compactUntrustedText(next[key] as string);
    }
  }
  if (Array.isArray(next.unknown)) {
    next.unknown = (next.unknown as unknown[]).slice(0, 4).map((item) => (
      typeof item === 'string' ? compactUntrustedText(item, 40) : item
    ));
  }
  return next;
}

export function validateMaxTokens(value: unknown): MaxTokensValidation {
  if (value === undefined) {
    return { ok: true, max_tokens: DEFAULT_MAX_TOKENS };
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: 'max_tokens must be an integer' };
  }
  if (value < MIN_MAX_TOKENS || value > MAX_MAX_TOKENS) {
    return { ok: false, error: `max_tokens must be between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}` };
  }
  return { ok: true, max_tokens: value };
}
