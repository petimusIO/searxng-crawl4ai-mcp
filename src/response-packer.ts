import type { ContentMode } from './content-utils.js';
import type { DocumentSection, RankedSection } from './passage-extractor.js';
import {
  attachResponseBudget,
  BUDGET_SCOPE,
  countResponseTokens,
  MAX_MAX_TOKENS,
  serializeResponseText,
  TOKENIZER_NAME,
} from './token-budget.js';

const FRAGMENT_GLUE_TOKENS = 8;
const COUNT_CHANGE_TOKENS = 2;

const HEADING_PREVIEW_LIMIT = 80;

export interface PackableSource {
  url: string;
  title: string;
  snippet?: string;
  success: boolean;
  error?: string;
  source_type?: 'scraped' | 'snippet';
  document_id?: string;
  read_more_unavailable?: boolean;
  saved_at?: number;
  expires_at?: number;
  fetch?: { status_code?: number; rendered_with?: string; elapsed_ms?: number };
  data?: Record<string, unknown>;
  markdown?: string;
  sections: DocumentSection[];
  ranked: RankedSection[];
}

export interface PackRequest {
  query: string;
  contentMode: ContentMode;
  maxTokens: number;
  sources: PackableSource[];
  envelope: Record<string, unknown>;
  requestedSectionIds?: string[];
  deferFinalize?: boolean;
}

export interface PackedResponse {
  payload: Record<string, unknown>;
  text: string;
}

interface OmittedPreview {
  id: string;
  heading?: string;
  heading_truncated?: boolean;
  status?: 'section_omitted' | 'section_too_large' | 'section_exceeds_max_budget' | 'duplicate';
  required_tokens?: number;
}

function stripMarkdown(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return data;
  const { markdown: _markdown, ...rest } = data;
  return rest;
}

function headingPreview(heading: string | undefined): { heading?: string; heading_truncated?: boolean } {
  if (!heading) return {};
  if (heading.length <= HEADING_PREVIEW_LIMIT) return { heading };
  return {
    heading: `${heading.slice(0, HEADING_PREVIEW_LIMIT - 1)}…`,
    heading_truncated: true,
  };
}

function sectionById(source: PackableSource): Map<string, DocumentSection> {
  return new Map(source.sections.map((section) => [section.id, section]));
}

function scoreById(source: PackableSource): Map<string, RankedSection> {
  return new Map(source.ranked.map((section) => [section.id, section]));
}

function toPassage(section: DocumentSection, ranked: RankedSection | undefined) {
  return {
    text: section.text,
    score: ranked?.score ?? 0,
    position: ranked?.position ?? (Number(section.id.slice(1)) || 0),
    heading: section.heading,
    section_id: section.id,
    source_offset: section.source_offset,
    ...(section.definitions && section.definitions.length > 0 ? { definitions: section.definitions } : {}),
  };
}

function matchStatus(source: PackableSource, query: string): 'hits' | 'zero_match' | undefined {
  if (!query.trim()) return undefined;
  return source.ranked.some((section) => section.score > 0) ? 'hits' : 'zero_match';
}

function isRequiredStatus(status: OmittedPreview['status']): boolean {
  return status === 'section_too_large' || status === 'section_exceeds_max_budget';
}

function isMandatoryOutcome(item: OmittedPreview, requestedIds?: Set<string>): boolean {
  return isRequiredStatus(item.status) || Boolean(requestedIds?.has(item.id));
}

function createPlanner(limit: number) {
  const objectTokens = new WeakMap<object, number>();
  const textTokens = new Map<string, number>();
  const reserve = countResponseTokens(serializeResponseText({
    budget: {
      tokenizer: TOKENIZER_NAME,
      limit,
      used: limit,
      scope: BUDGET_SCOPE,
    },
  }));
  let estimate = 0;

  const tokensOf = (value: unknown): number => {
    if (value && typeof value === 'object') {
      const cached = objectTokens.get(value);
      if (cached !== undefined) return cached;
      const counted = countResponseTokens(serializeResponseText(value));
      objectTokens.set(value, counted);
      return counted;
    }
    if (typeof value === 'string') {
      const cached = textTokens.get(value);
      if (cached !== undefined) return cached;
      const counted = countResponseTokens(serializeResponseText(value));
      textTokens.set(value, counted);
      return counted;
    }
    return countResponseTokens(serializeResponseText(value));
  };

  return {
    tokensOf,
    resetExact(payload: object) {
      estimate = countResponseTokens(serializeResponseText(payload)) + reserve;
    },
    add(value: unknown, extra = FRAGMENT_GLUE_TOKENS) {
      estimate += tokensOf(value) + extra;
    },
    remove(value: unknown, extra = FRAGMENT_GLUE_TOKENS) {
      estimate -= tokensOf(value) + extra;
    },
    addCost(n: number) {
      estimate += n;
    },
    fits() {
      return estimate <= limit;
    },
    get estimate() {
      return estimate;
    },
  };
}

type Planner = ReturnType<typeof createPlanner>;

function worstCaseOutcome(section: DocumentSection): OmittedPreview {
  return {
    id: section.id,
    ...headingPreview(section.heading),
    status: 'section_exceeds_max_budget',
    required_tokens: 999999,
  };
}

function sourceShell(source: PackableSource, contentMode: ContentMode, includeMarkdown: boolean, query: string) {
  const data = includeMarkdown && contentMode === 'full'
    ? source.data
    : stripMarkdown(source.data);

  return {
    url: source.url,
    title: source.title,
    snippet: source.snippet,
    source_type: source.source_type,
    success: source.success,
    ...(source.error ? { error: source.error } : {}),
    ...(source.document_id ? { document_id: source.document_id } : {}),
    ...(source.read_more_unavailable ? { read_more_unavailable: true } : {}),
    ...(source.saved_at != null ? { saved_at: source.saved_at } : {}),
    ...(source.expires_at != null ? { expires_at: source.expires_at } : {}),
    ...(source.fetch ? { fetch: source.fetch } : {}),
    ...(data ? { data } : {}),
    ...(includeMarkdown || contentMode !== 'full' ? {} : { full_content_omitted: true }),
    ...(source.success ? {
      match_status: matchStatus(source, query),
      relevant_passages: {
        query,
        passages: [] as ReturnType<typeof toPassage>[],
        total_passages: source.sections.length,
        top_n: 0,
      },
      sections: {
        total: source.sections.length,
        included: 0,
        omitted: source.sections.length,
        included_ids: [] as string[],
        omitted_preview: [] as OmittedPreview[],
        ...(source.document_id && !source.read_more_unavailable ? {
          list_more: {
            tool: 'scrape_url',
            arguments: { document_id: source.document_id, list_sections: true },
          },
        } : {}),
      },
    } : {}),
  };
}

function finalizeSource(
  result: ReturnType<typeof sourceShell>,
  source: PackableSource,
  query: string,
  omittedStatuses: Map<string, OmittedPreview>,
  includeMarkdown: boolean,
  contentMode: ContentMode,
  requestedIds?: Set<string>,
): OmittedPreview[] {
  if (!result.relevant_passages || !result.sections) return [];
  result.match_status = matchStatus(source, query);
  result.relevant_passages.query = query;
  result.relevant_passages.top_n = result.relevant_passages.passages.length;
  result.sections.included = result.sections.included_ids.length;
  if (includeMarkdown && contentMode === 'full' && result.data && 'markdown' in result.data) {
    result.sections.omitted = 0;
    result.sections.omitted_preview = [];
    delete (result as { full_content_omitted?: boolean }).full_content_omitted;
    return [];
  }
  result.sections.omitted = result.sections.total - result.sections.included;
  const ordered = source.sections
    .filter((section) => !result.sections!.included_ids.includes(section.id))
    .map((section) => ({
      ...headingPreview(section.heading),
      ...(omittedStatuses.get(section.id) ?? { status: 'section_omitted' as const }),
      id: section.id,
    }));
  const mandatory = ordered.filter((item) => isMandatoryOutcome(item, requestedIds));
  const rest = ordered.filter((item) => !isMandatoryOutcome(item, requestedIds));
  result.sections.omitted_preview = mandatory;
  return rest;
}

function attach(payload: Record<string, unknown>, limit: number): PackedResponse {
  const packed = attachResponseBudget(payload, limit);
  return {
    payload: packed,
    text: JSON.stringify(packed, null, 2),
  };
}

function usedTokens(payload: Record<string, unknown>, limit: number): number {
  return attachResponseBudget(payload, limit).budget.used;
}

function conservativeWireTokens(payload: Record<string, unknown>, limit: number): number {
  return countResponseTokens(serializeResponseText({
    ...payload,
    budget: {
      tokenizer: TOKENIZER_NAME,
      limit,
      used: limit,
      scope: BUDGET_SCOPE,
    },
  }));
}

function fits(payload: Record<string, unknown>, limit: number): boolean {
  return conservativeWireTokens(payload, limit) <= limit;
}

function flattenedSingleSource(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const results = payload.results;
  if (!Array.isArray(results) || results.length !== 1 || !results[0] || typeof results[0] !== 'object') {
    return undefined;
  }
  const { results: _results, budget: _budget, ...rest } = payload;
  return { ...rest, ...(results[0] as Record<string, unknown>) };
}

function candidateFits(
  payload: Record<string, unknown>,
  limit: number,
  flattenSingle: boolean,
): boolean {
  if (flattenSingle) {
    const flat = flattenedSingleSource(payload);
    if (flat) return fits(flat, limit);
  }
  return fits(payload, limit);
}

type ResultLike = {
  relevant_passages?: { passages: unknown[]; top_n?: number };
  sections?: {
    total: number;
    included: number;
    omitted: number;
    included_ids: string[];
    omitted_preview: OmittedPreview[];
  };
};

function collectResults(payload: Record<string, unknown>): ResultLike[] {
  if (Array.isArray(payload.results)) return payload.results as ResultLike[];
  if (payload.relevant_passages || payload.sections) return [payload as ResultLike];
  return [];
}

function stripOneOptionalPreview(results: ResultLike[], requestedIds: Set<string>): boolean {
  for (let i = results.length - 1; i >= 0; i--) {
    const preview = results[i]?.sections?.omitted_preview;
    if (!preview || preview.length === 0) continue;
    for (let index = preview.length - 1; index >= 0; index--) {
      if (!isMandatoryOutcome(preview[index], requestedIds)) {
        preview.splice(index, 1);
        return true;
      }
    }
  }
  return false;
}

function stripOneSection(results: ResultLike[], requestedIds: Set<string>): boolean {
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i];
    const passages = result?.relevant_passages?.passages;
    if (!passages || passages.length === 0) continue;
    const lastId = result.sections?.included_ids[result.sections.included_ids.length - 1];
    if (lastId && requestedIds.has(lastId)) continue;
    passages.pop();
    result.relevant_passages!.top_n = passages.length;
    if (result.sections) {
      result.sections.included_ids.pop();
      result.sections.included = result.sections.included_ids.length;
      result.sections.omitted = result.sections.total - result.sections.included;
    }
    return true;
  }
  return false;
}

function hardGuard(payload: Record<string, unknown>, limit: number, requestedIds: Set<string>): boolean {
  const results = collectResults(payload);
  while (!fits(payload, limit)) {
    if (stripOneOptionalPreview(results, requestedIds)) continue;
    if (stripOneSection(results, requestedIds)) continue;
    return false;
  }
  return true;
}

function finalizePacked(
  payload: Record<string, unknown>,
  limit: number,
  requestedSectionIds?: string[],
): PackedResponse {
  const requestedIds = new Set(requestedSectionIds ?? []);
  if (!hardGuard(payload, limit, requestedIds)) {
    return compactBudgetTooSmall(usedTokens(payload, limit), limit);
  }
  return attach(payload, limit);
}

function requiredTokensForSection(
  envelope: Record<string, unknown>,
  source: PackableSource,
  section: DocumentSection,
  ranked: RankedSection | undefined,
  contentMode: ContentMode,
  query: string,
): number {
  const result = sourceShell(source, contentMode, false, query);
  if (result.relevant_passages && result.sections) {
    result.relevant_passages.passages = [toPassage(section, ranked)];
    result.relevant_passages.top_n = 1;
    result.sections.included = 1;
    result.sections.omitted = Math.max(0, result.sections.total - 1);
    result.sections.included_ids = [section.id];
    result.sections.omitted_preview = [];
  }
  return usedTokens({ ...envelope, results: [result] }, MAX_MAX_TOKENS);
}

function sectionStatus(requiredTokens: number, limit: number): OmittedPreview['status'] {
  if (requiredTokens > MAX_MAX_TOKENS) return 'section_exceeds_max_budget';
  if (requiredTokens > limit) return 'section_too_large';
  return 'section_omitted';
}

function candidates(source: PackableSource, requestedSectionIds: string[] | undefined): RankedSection[] {
  const byId = sectionById(source);
  if (requestedSectionIds) {
    return requestedSectionIds
      .filter((id) => byId.has(id))
      .map((id) => scoreById(source).get(id) ?? { id, score: 0, position: Number(id.slice(1)) || 0 });
  }
  const ranked = source.ranked.filter((item) => byId.has(item.id));
  if (ranked.some((item) => item.score > 0)) {
    return ranked.filter((item) => item.score > 0);
  }
  return ranked;
}

function buildSkeleton(
  request: PackRequest,
  includeMarkdown: boolean,
) {
  const results = request.sources.map((source) => (
    sourceShell(source, request.contentMode, includeMarkdown, request.query)
  ));
  return {
    ...request.envelope,
    results,
  };
}

function compactBudgetTooSmall(requiredTokens: number, limit: number): PackedResponse {
  return attach({
    error: 'budget_too_small',
    required_tokens: requiredTokens,
  }, limit);
}

function revertPassage(
  result: ReturnType<typeof sourceShell>,
  planner: Planner,
  passage: ReturnType<typeof toPassage>,
  sectionId: string,
): void {
  result.relevant_passages!.passages.pop();
  result.relevant_passages!.top_n = result.relevant_passages!.passages.length;
  result.sections!.included_ids.pop();
  result.sections!.included = result.sections!.included_ids.length;
  result.sections!.omitted = result.sections!.total - result.sections!.included;
  planner.remove(passage);
  planner.remove(sectionId, 4);
  planner.addCost(-COUNT_CHANGE_TOKENS);
}

function tryAddPassage(
  payload: ReturnType<typeof buildSkeleton>,
  sourceIndex: number,
  section: DocumentSection,
  ranked: RankedSection | undefined,
  query: string,
  limit: number,
  planner: Planner,
  mode: 'estimate' | 'exact',
  flattenSingle = false,
): boolean {
  const result = payload.results[sourceIndex];
  if (!result.relevant_passages || !result.sections) return false;
  const passage = toPassage(section, ranked);
  result.relevant_passages.query = query;
  result.relevant_passages.passages.push(passage);
  result.relevant_passages.top_n = result.relevant_passages.passages.length;
  result.sections.included_ids.push(section.id);
  result.sections.included = result.sections.included_ids.length;
  result.sections.omitted = result.sections.total - result.sections.included;
  planner.add(passage);
  planner.add(section.id, 4);
  planner.addCost(COUNT_CHANGE_TOKENS);
  if (mode === 'exact') {
    if (candidateFits(payload, limit, flattenSingle)) {
      planner.resetExact(payload);
      return true;
    }
    revertPassage(result, planner, passage, section.id);
    return false;
  }
  if (planner.fits()) return true;
  if (planner.estimate <= limit + 64 && fits(payload, limit)) {
    planner.resetExact(payload);
    return true;
  }
  revertPassage(result, planner, passage, section.id);
  return false;
}

function fillOmittedPreviews(
  payload: ReturnType<typeof buildSkeleton>,
  sources: PackableSource[],
  omittedStatuses: Map<string, Map<string, OmittedPreview>>,
  query: string,
  includeMarkdown: boolean,
  contentMode: ContentMode,
  planner: Planner,
  requestedIds?: Set<string>,
): void {
  const optionals: OmittedPreview[][] = [];
  for (let i = 0; i < sources.length; i++) {
    const result = payload.results[i];
    if (!result.sections || !result.relevant_passages) {
      optionals.push([]);
      continue;
    }
    optionals.push(finalizeSource(
      result,
      sources[i],
      query,
      omittedStatuses.get(sources[i].url) ?? new Map(),
      includeMarkdown,
      contentMode,
      requestedIds,
    ));
  }
  planner.resetExact(payload);
  for (let i = 0; i < sources.length; i++) {
    const result = payload.results[i];
    if (!result.sections) continue;
    for (const item of optionals[i]) {
      result.sections.omitted_preview.push(item);
      planner.add(item);
      if (planner.fits()) continue;
      result.sections.omitted_preview.pop();
      planner.remove(item);
      break;
    }
  }
}

type PackSectionsResult =
  | { kind: 'packed'; payload: ReturnType<typeof buildSkeleton> }
  | { kind: 'too_small'; requiredTokens: number };

function packSections(request: PackRequest, includeMarkdown: boolean): PackSectionsResult {
  const planner = createPlanner(request.maxTokens);
  const payload = buildSkeleton(request, includeMarkdown);
  planner.resetExact(payload);
  if (!planner.fits()) {
    return { kind: 'too_small', requiredTokens: Math.max(planner.estimate, conservativeWireTokens(payload, request.maxTokens)) };
  }

  const sectionMaps = request.sources.map(sectionById);
  const requestedIds = request.requestedSectionIds
    ? [...new Set(request.requestedSectionIds)]
    : undefined;
  const requiredCache = new WeakMap<DocumentSection, number>();
  const seenText = new Set<string>();
  const omittedStatuses = new Map<string, Map<string, OmittedPreview>>();
  const reservedSlots = request.sources.map(() => new Map<string, OmittedPreview>());
  const pointers = request.sources.map(() => 0);
  const lists = request.sources.map((source) => (
    source.success ? candidates(source, request.requestedSectionIds) : []
  ));

  const requiredFor = (
    source: PackableSource,
    section: DocumentSection,
    ranked: RankedSection | undefined,
  ) => {
    const cached = requiredCache.get(section);
    if (cached !== undefined) return cached;
    const required = requiredTokensForSection(
      request.envelope,
      source,
      section,
      ranked,
      request.contentMode,
      request.query,
    );
    requiredCache.set(section, required);
    return required;
  };

  const markOmitted = (source: PackableSource, section: DocumentSection, preview: OmittedPreview) => {
    let bySource = omittedStatuses.get(source.url);
    if (!bySource) {
      bySource = new Map();
      omittedStatuses.set(source.url, bySource);
    }
    bySource.set(section.id, preview);
  };

  if (requestedIds) {
    for (let sourceIndex = 0; sourceIndex < request.sources.length; sourceIndex++) {
      const source = request.sources[sourceIndex];
      const result = payload.results[sourceIndex];
      if (!source.success || !result.sections) continue;
      const byId = sectionMaps[sourceIndex];
      for (const id of requestedIds) {
        const section = byId.get(id);
        if (!section) continue;
        const reserved = worstCaseOutcome(section);
        reservedSlots[sourceIndex].set(id, reserved);
        result.sections.omitted_preview.push(reserved);
        planner.add(reserved);
      }
    }
    planner.resetExact(payload);
    if (!planner.fits() || !candidateFits(payload, request.maxTokens, Boolean(request.deferFinalize))) {
      const measured = request.deferFinalize
        ? flattenedSingleSource(payload) ?? payload
        : payload;
      return {
        kind: 'too_small',
        requiredTokens: Math.max(planner.estimate, conservativeWireTokens(measured, request.maxTokens)),
      };
    }
  }

  let rrStart = 0;
  const takeNext = (): { sourceIndex: number; ranked: RankedSection; section: DocumentSection } | undefined => {
    const n = request.sources.length;
    for (let attempt = 0; attempt < n; attempt++) {
      const sourceIndex = (rrStart + attempt) % n;
      const list = lists[sourceIndex];
      const index = pointers[sourceIndex];
      if (index >= list.length) continue;
      pointers[sourceIndex] += 1;
      rrStart = (sourceIndex + 1) % n;
      const ranked = list[index];
      const section = sectionMaps[sourceIndex].get(ranked.id);
      if (section) return { sourceIndex, ranked, section };
    }
    return undefined;
  };

  if (requestedIds) {
    for (let sourceIndex = 0; sourceIndex < request.sources.length; sourceIndex++) {
      const source = request.sources[sourceIndex];
      if (!source.success) continue;
      const result = payload.results[sourceIndex];
      for (const ranked of lists[sourceIndex]) {
        const section = sectionMaps[sourceIndex].get(ranked.id);
        if (!section) continue;
        const reserved = reservedSlots[sourceIndex].get(section.id);
        if (reserved && result.sections) {
          const idx = result.sections.omitted_preview.indexOf(reserved);
          if (idx >= 0) result.sections.omitted_preview.splice(idx, 1);
          planner.remove(reserved);
        }
        if (tryAddPassage(payload, sourceIndex, section, ranked, request.query, request.maxTokens, planner, 'exact', Boolean(request.deferFinalize))) {
          seenText.add(section.text);
          reservedSlots[sourceIndex].delete(section.id);
          continue;
        }
        const required = requiredFor(source, section, ranked);
        const outcome: OmittedPreview = {
          id: section.id,
          ...headingPreview(section.heading),
          status: sectionStatus(required, request.maxTokens),
          required_tokens: required,
        };
        if (result.sections) {
          result.sections.omitted_preview.push(outcome);
          planner.add(outcome);
        }
        markOmitted(source, section, outcome);
      }
    }
  } else {
    let next = takeNext();
    while (next) {
      const { sourceIndex, ranked, section } = next;
      const source = request.sources[sourceIndex];
      if (seenText.has(section.text)) {
        markOmitted(source, section, {
          id: section.id,
          ...headingPreview(section.heading),
          status: 'duplicate',
        });
        next = takeNext();
        continue;
      }
      if (tryAddPassage(payload, sourceIndex, section, ranked, request.query, request.maxTokens, planner, 'estimate')) {
        seenText.add(section.text);
      } else {
        const required = requiredFor(source, section, ranked);
        const status = sectionStatus(required, request.maxTokens);
        markOmitted(source, section, {
          id: section.id,
          ...headingPreview(section.heading),
          status,
          ...(isRequiredStatus(status) ? { required_tokens: required } : {}),
        });
      }
      next = takeNext();
    }
  }

  fillOmittedPreviews(
    payload,
    request.sources,
    omittedStatuses,
    request.query,
    includeMarkdown,
    request.contentMode,
    planner,
    requestedIds ? new Set(requestedIds) : undefined,
  );
  return { kind: 'packed', payload };
}

export function packBudgetedResponse(request: PackRequest): PackedResponse {
  const wantFull = request.contentMode === 'full' && !request.requestedSectionIds;
  const withFull = wantFull ? packSections(request, true) : undefined;
  if (withFull?.kind === 'packed') {
    if (request.deferFinalize) {
      return { payload: withFull.payload, text: JSON.stringify(withFull.payload, null, 2) };
    }
    return finalizePacked(withFull.payload, request.maxTokens, request.requestedSectionIds);
  }

  const withoutFull = packSections({
    ...request,
    contentMode: request.requestedSectionIds ? 'relevant_only' : request.contentMode,
  }, false);
  if (withoutFull.kind === 'packed') {
    if (wantFull) {
      for (const result of withoutFull.payload.results) {
        if (result.success) result.full_content_omitted = true;
      }
    }
    if (request.deferFinalize) {
      return { payload: withoutFull.payload, text: JSON.stringify(withoutFull.payload, null, 2) };
    }
    return finalizePacked(withoutFull.payload, request.maxTokens, request.requestedSectionIds);
  }

  return compactBudgetTooSmall(withoutFull.requiredTokens, request.maxTokens);
}

function requiredTokensForIndexEntry(
  fields: Record<string, unknown>,
  entry: { id: string; heading?: string; heading_truncated?: boolean; size_chars: number },
): number {
  return usedTokens({
    ...fields,
    sections: [entry],
    next_offset: null,
  }, MAX_MAX_TOKENS);
}

export function packSectionIndex(input: {
  url: string;
  title: string;
  document_id: string;
  sections: DocumentSection[];
  sectionOffset: number;
  maxTokens: number;
  envelope?: Record<string, unknown>;
}): PackedResponse {
  const { sections, sectionOffset, maxTokens, document_id, url, title } = input;
  const items: Array<{ id: string; heading?: string; heading_truncated?: boolean; size_chars: number }> = [];
  let nextOffset: number | null = null;

  const base = () => ({
    ...(input.envelope ?? {}),
    url,
    title,
    document_id,
    list_sections: true,
    section_offset: sectionOffset,
    total_sections: sections.length,
    sections: items,
    next_offset: nextOffset,
  });

  if (!fits(base(), maxTokens)) {
    const required = usedTokens(base(), maxTokens);
    return compactBudgetTooSmall(required, maxTokens);
  }

  for (let index = sectionOffset; index < sections.length; index++) {
    const section = sections[index];
    items.push({
      id: section.id,
      ...headingPreview(section.heading),
      size_chars: section.text.length,
    });
    nextOffset = index + 1 < sections.length ? index + 1 : null;
    if (!fits(base(), maxTokens)) {
      items.pop();
      nextOffset = index;
      break;
    }
  }

  if (items.length === 0 && sectionOffset < sections.length) {
    const section = sections[sectionOffset];
    const entry = {
      id: section.id,
      ...headingPreview(section.heading),
      size_chars: section.text.length,
    };
    const required = requiredTokensForIndexEntry({
      ...(input.envelope ?? {}),
      url,
      title,
      document_id,
      list_sections: true,
      section_offset: sectionOffset,
      total_sections: sections.length,
    }, entry);
    const advanced = sectionOffset + 1 < sections.length ? sectionOffset + 1 : null;
    return finalizePacked({
      document_id,
      url,
      title,
      list_sections: true,
      section_offset: sectionOffset,
      total_sections: sections.length,
      sections: [],
      next_offset: advanced,
      error: required > MAX_MAX_TOKENS ? 'section_exceeds_max_budget' : 'section_too_large',
      required_tokens: required,
    }, maxTokens);
  }

  return finalizePacked(base(), maxTokens);
}

export function flattenPackedSource(
  packed: PackedResponse,
  limit: number,
  requestedSectionIds?: string[],
): PackedResponse {
  const payload = packed.payload;
  const results = Array.isArray(payload.results) ? payload.results : [];
  const first = results[0] && typeof results[0] === 'object'
    ? results[0] as Record<string, unknown>
    : {};
  const { results: _results, budget: _budget, ...rest } = payload;
  return finalizePacked({ ...rest, ...first }, limit, requestedSectionIds);
}

export function packQuickResearch(input: {
  envelope: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  maxTokens: number;
}): PackedResponse {
  const included: Array<Record<string, unknown>> = [];
  let omitted = 0;
  const build = () => ({
    ...input.envelope,
    results: included,
    ...(omitted > 0 ? { omitted_snippets: omitted } : {}),
  });

  if (!fits(build(), input.maxTokens)) {
    return compactBudgetTooSmall(usedTokens(build(), input.maxTokens), input.maxTokens);
  }

  for (const result of input.results) {
    included.push(result);
    if (!fits(build(), input.maxTokens)) {
      included.pop();
      omitted += 1;
    }
  }

  return finalizePacked(build(), input.maxTokens);
}
