import { describe, expect, it, vi } from 'vitest';
const work = vi.hoisted(() => ({ fullCounts: 0 }));
vi.mock('gpt-tokenizer/esm/encoding/o200k_base', async (load) => {
  const actual = await load<typeof import('gpt-tokenizer/esm/encoding/o200k_base')>();
  return {
    ...actual,
    countTokens: (...args: Parameters<typeof actual.countTokens>) => {
      if (typeof args[0] === 'string' && args[0].length > 1000) work.fullCounts++;
      return actual.countTokens(...args);
    },
  };
});
import { attachResponseBudget, countResponseTokens, serializeResponseText } from '../src/token-budget.js';

describe('budget metadata accounting work', () => {
  it('counts the body once instead of re-encoding it to settle budget.used', () => {
    work.fullCounts = 0;
    const packed = attachResponseBudget({ evidence: 'policy '.repeat(2000) }, 6000);
    const fullCounts = work.fullCounts;
    expect(packed.budget.used).toBe(countResponseTokens(serializeResponseText(packed)));
    expect(fullCounts).toBe(1);
  });

  it.each([8, 80, 950, 980, 999, 1000, 9900, 9999, 10000])('keeps exact size through numeric boundaries for %i words', (words) => {
    const packed = attachResponseBudget({ evidence: 'policy '.repeat(words) }, 32000);
    expect(packed.budget.used).toBe(countResponseTokens(serializeResponseText(packed)));
  });
});
