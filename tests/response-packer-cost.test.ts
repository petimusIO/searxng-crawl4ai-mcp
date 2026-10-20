import { describe, expect, it, vi } from 'vitest';
const counts = vi.hoisted(() => ({ attachments: 0 }));
vi.mock('../src/token-budget.js', async (load) => {
  const actual = await load<typeof import('../src/token-budget.js')>();
  return {
    ...actual,
    attachResponseBudget: (...args: Parameters<typeof actual.attachResponseBudget>) => {
      counts.attachments++;
      return actual.attachResponseBudget(...args);
    },
  };
});
import { packBudgetedResponse } from '../src/response-packer.js';
import { countResponseTokens } from '../src/token-budget.js';

describe('bounded omitted-section accounting', () => {
  it('does not stabilize a hypothetical budget for every individually small rejected section', () => {
    const sections = Array.from({ length: 80 }, (_, i) => ({
      id: `s${i}`,
      heading: `Policy ${i}`,
      text: `## Policy ${i}\n\nKeep the entire policy requirement and its exception ${i}.`,
      source_offset: { start: i * 100, end: i * 100 + 80 },
    }));
    counts.attachments = 0;
    const packed = packBudgetedResponse({
      query: 'policy', contentMode: 'relevant_only', maxTokens: 1500,
      envelope: { query: 'policy' },
      sources: [{
        url: 'https://fixture.invalid/policy', title: 'Policy', success: true,
        sections, ranked: sections.map((s, position) => ({ id: s.id, position, score: 1 })),
      }],
    });
    const result = packed.payload.results as any[];
    expect(result[0].sections.omitted).toBeGreaterThan(50);
    expect(result[0].sections.omitted_preview.every((x: any) => x.status === 'section_omitted')).toBe(true);
    expect(countResponseTokens(packed.text)).toBeLessThanOrEqual(1500);
    expect(counts.attachments).toBeLessThanOrEqual(5);
  });
});
