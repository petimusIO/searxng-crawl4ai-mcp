import { timedSync, timingStringify } from './search-timing.js';
import { attachResponseBudget, compactUntrustedText, countResponseTokens, DEFAULT_MAX_TOKENS, isStableErrorCode, prepareSafeErrorPayload } from './token-budget.js';

export function mcpJson(payload: Record<string, unknown>, maxTokens: number = DEFAULT_MAX_TOKENS) {
  return timedSync('mcp.pack', () => {
    const isError = typeof payload.error === 'string';
    const safe = isError ? prepareSafeErrorPayload(payload) : { ...payload };
    if (typeof safe.query === 'string') {
      safe.query = compactUntrustedText(safe.query);
    }
    let packed = attachResponseBudget(safe, maxTokens);
    let text = timingStringify(packed, null, 2);
    if (countResponseTokens(text) > maxTokens) {
      packed = attachResponseBudget(prepareSafeErrorPayload(safe), maxTokens);
      text = timingStringify(packed, null, 2);
    }
    if (countResponseTokens(text) > maxTokens) {
      const code = typeof safe.error === 'string' && isStableErrorCode(safe.error)
        ? safe.error
        : (isError ? 'upstream_error' : 'budget_too_small');
      packed = attachResponseBudget({
        error: code,
        ...(typeof safe.required_tokens === 'number' ? { required_tokens: safe.required_tokens } : {}),
      }, maxTokens);
      text = timingStringify(packed, null, 2);
    }
    return { content: [{ type: 'text', text }] };
  }, true);
}
