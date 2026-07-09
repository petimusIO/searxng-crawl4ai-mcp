const TRACKING_PARAMS = new Set([
  'ref', 'utm', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'gclsrc', 'dclid',
  'msclkid', 'twclid', 'igshid', 'wt_mc', 'wt_zmc',
]);

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Lowercase scheme + host + path
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.toLowerCase();
    // Strip www prefix
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
    }
    // Strip tracking query params
    const params = url.searchParams;
    const toDelete: string[] = [];
    params.forEach((_v, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        toDelete.push(key);
      }
    });
    toDelete.forEach(k => params.delete(k));
    // Sort remaining params for stable keys
    params.sort();
    // Rebuild
    let result = url.toString();
    // Strip trailing slash unless root path
    const parsed = new URL(result);
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
      result = parsed.toString();
    }
    return result;
  } catch {
    return raw; // malformed URLs pass through unchanged
  }
}
