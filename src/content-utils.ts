export type ContentMode = 'full' | 'relevant_only' | 'snippet';

/**
 * Strip the `markdown` field from a data object when content mode is "relevant_only" or "snippet".
 * In "full" mode or when mode is undefined, returns the data unchanged.
 * Always returns a partial copy — never mutates the input.
 */
export function stripMarkdownFromData<T extends { markdown?: string }>(
  data: T | undefined,
  contentMode: ContentMode | undefined
): T | undefined {
  if (!data) return data;
  if (!contentMode || contentMode === 'full') return data;
  const { markdown: _, ...rest } = data;
  return rest as T;
}
