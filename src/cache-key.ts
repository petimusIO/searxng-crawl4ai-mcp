export function buildCacheKey(namespace: string, fields: readonly unknown[]): string {
  return `${namespace}:${JSON.stringify(fields)}`;
}
