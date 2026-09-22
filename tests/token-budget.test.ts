import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  attachResponseBudget,
  countResponseTokens,
  serializeResponseText,
  validateMaxTokens,
} from '../src/token-budget.js';

describe('token budget counting', () => {
  it('counts the actual serialized MCP JSON text with o200k_base, not characters/4', () => {
    const payload = { query: 'fastify', results: [] };
    const text = serializeResponseText(payload);
    const used = countResponseTokens(text);

    expect(text).toBe(JSON.stringify(payload, null, 2));
    expect(used).toBeGreaterThan(0);
    expect(used).not.toBe(Math.ceil(text.length / 4));
    expect(countResponseTokens('hello world')).toBe(2);
  });

  it('treats special-token-like web text as ordinary tokens and never throws', () => {
    const nasty = 'see <|endoftext|> and <|im_start|> in a page';
    expect(() => countResponseTokens(nasty)).not.toThrow();
    expect(countResponseTokens(nasty)).toBeGreaterThan(countResponseTokens('see and in a page'));
  });

  it('fits budget.used to the final serialized text including the budget object itself', () => {
    const packed = attachResponseBudget({ query: 'fastify', results: [] }, 6000);

    expect(packed.budget).toEqual({
      tokenizer: 'o200k_base',
      limit: 6000,
      used: packed.budget.used,
      scope: 'response_text',
    });
    expect(packed.budget.used).toBe(countResponseTokens(serializeResponseText(packed)));
    expect(packed.budget.used).toBeGreaterThan(countResponseTokens(serializeResponseText({
      query: 'fastify',
      results: [],
    })));
  });

  it('defaults max_tokens to 6000 and accepts only integers 512..32000', () => {
    expect(validateMaxTokens(undefined)).toEqual({ ok: true, max_tokens: DEFAULT_MAX_TOKENS });
    expect(DEFAULT_MAX_TOKENS).toBe(6000);
    expect(MIN_MAX_TOKENS).toBe(512);
    expect(MAX_MAX_TOKENS).toBe(32000);
    expect(validateMaxTokens(512)).toEqual({ ok: true, max_tokens: 512 });
    expect(validateMaxTokens(32000)).toEqual({ ok: true, max_tokens: 32000 });
    expect(validateMaxTokens(511).ok).toBe(false);
    expect(validateMaxTokens(32001).ok).toBe(false);
    expect(validateMaxTokens(6000.5).ok).toBe(false);
    expect(validateMaxTokens('6000').ok).toBe(false);
    expect(validateMaxTokens(null).ok).toBe(false);
  });
});
