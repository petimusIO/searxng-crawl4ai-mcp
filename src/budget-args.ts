import type { ContentMode } from './content-utils.js';
import { DEFAULT_MAX_TOKENS, validateMaxTokens } from './token-budget.js';

const CONTENT_MODES = new Set<ContentMode>(['full', 'relevant_only', 'snippet']);
const MAX_SECTION_IDS = 32;

export type ValidatedBudget = {
  max_tokens: number;
  content_mode: ContentMode;
};

export type ValidatedScrapeArgs = ValidatedBudget & {
  url?: string;
  document_id?: string;
  query?: string;
  section_ids?: string[];
  list_sections: boolean;
  section_offset?: number;
};

export type ArgValidation =
  | { ok: true; value: ValidatedScrapeArgs }
  | { ok: false; error: 'invalid_arguments'; message: string };

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(message: string): ArgValidation {
  return { ok: false, error: 'invalid_arguments', message };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveErrorBudget(args: Record<string, unknown> | undefined): number {
  const tokens = validateMaxTokens(args?.max_tokens);
  return tokens.ok ? tokens.max_tokens : DEFAULT_MAX_TOKENS;
}

export function validateContentMode(value: unknown, fallback: ContentMode): { ok: true; content_mode: ContentMode } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, content_mode: fallback };
  if (typeof value !== 'string' || !CONTENT_MODES.has(value as ContentMode)) {
    return { ok: false, message: 'content_mode must be "full", "relevant_only", or "snippet"' };
  }
  return { ok: true, content_mode: value as ContentMode };
}

export function validateResearchArgs(args: Record<string, unknown> | undefined): ArgValidation {
  const raw = args ?? {};
  const tokens = validateMaxTokens(raw.max_tokens);
  if (!tokens.ok) return invalid(tokens.error);
  const mode = validateContentMode(raw.content_mode, 'relevant_only');
  if (!mode.ok) return invalid(mode.message);
  return {
    ok: true,
    value: {
      max_tokens: tokens.max_tokens,
      content_mode: mode.content_mode,
      list_sections: false,
    },
  };
}

export function validateScrapeArgs(args: Record<string, unknown> | undefined): ArgValidation {
  const raw = args ?? {};
  const hasUrl = Object.prototype.hasOwnProperty.call(raw, 'url');
  const hasDocumentId = Object.prototype.hasOwnProperty.call(raw, 'document_id');
  const url = raw.url;
  const documentId = raw.document_id;

  if (hasUrl && hasDocumentId) return invalid('exactly one of url or document_id is required');
  if (!hasUrl && !hasDocumentId) return invalid('exactly one of url or document_id is required');
  if (hasUrl && (!isNonemptyString(url) || !isHttpUrl(url as string))) {
    return invalid('url must be an http or https URL');
  }
  if (hasDocumentId && !isNonemptyString(documentId)) return invalid('document_id must be a nonempty string');

  const hasFormats = Object.prototype.hasOwnProperty.call(raw, 'formats');
  const hasTimeout = Object.prototype.hasOwnProperty.call(raw, 'timeout');
  if (hasDocumentId && (hasFormats || hasTimeout)) {
    return invalid('formats and timeout apply only to url fetches');
  }
  if (hasTimeout && (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout < 0)) {
    return invalid('timeout must be a nonnegative number');
  }
  if (hasFormats && (!Array.isArray(raw.formats) || raw.formats.some((item) => typeof item !== 'string'))) {
    return invalid('formats must be an array of strings');
  }

  const tokens = validateMaxTokens(raw.max_tokens);
  if (!tokens.ok) return invalid(tokens.error);
  const mode = validateContentMode(raw.content_mode, 'relevant_only');
  if (!mode.ok) return invalid(mode.message);

  const hasQuery = Object.prototype.hasOwnProperty.call(raw, 'query');
  const hasSectionIds = Object.prototype.hasOwnProperty.call(raw, 'section_ids');
  const hasList = Object.prototype.hasOwnProperty.call(raw, 'list_sections');
  const hasOffset = Object.prototype.hasOwnProperty.call(raw, 'section_offset');

  if (hasQuery && typeof raw.query !== 'string') return invalid('query must be a string');
  const query = hasQuery ? String(raw.query) : undefined;

  let list_sections = false;
  if (hasList) {
    if (typeof raw.list_sections !== 'boolean') return invalid('list_sections must be a boolean');
    list_sections = raw.list_sections;
  }

  let section_ids: string[] | undefined;
  if (hasSectionIds) {
    if (!hasDocumentId) return invalid('section_ids requires document_id');
    if (!Array.isArray(raw.section_ids) || raw.section_ids.length === 0 || raw.section_ids.length > MAX_SECTION_IDS) {
      return invalid(`section_ids must be a nonempty list of at most ${MAX_SECTION_IDS} ids`);
    }
    if (raw.section_ids.some((id) => !isNonemptyString(id))) {
      return invalid('section_ids must be nonempty strings');
    }
    if (new Set(raw.section_ids as string[]).size !== raw.section_ids.length) {
      return invalid('section_ids must be unique');
    }
    if (hasQuery || list_sections) {
      return invalid('section_ids is mutually exclusive with query and list_sections');
    }
    section_ids = raw.section_ids as string[];
  }

  let section_offset: number | undefined;
  if (hasOffset) {
    if (!list_sections) return invalid('section_offset requires list_sections:true');
    if (typeof raw.section_offset !== 'number' || !Number.isInteger(raw.section_offset) || raw.section_offset < 0) {
      return invalid('section_offset must be a nonnegative integer');
    }
    section_offset = raw.section_offset;
  }

  if (list_sections && hasQuery) {
    return invalid('list_sections is mutually exclusive with query');
  }

  return {
    ok: true,
    value: {
      url: hasUrl ? url as string : undefined,
      document_id: hasDocumentId ? documentId as string : undefined,
      query,
      section_ids,
      list_sections,
      section_offset,
      max_tokens: tokens.max_tokens,
      content_mode: mode.content_mode,
    },
  };
}

