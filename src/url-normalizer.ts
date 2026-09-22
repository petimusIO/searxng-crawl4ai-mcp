const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'gclsrc', 'dclid',
  'msclkid', 'twclid', 'igshid', 'wt_mc', 'wt_zmc',
]);

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    const params = url.searchParams;
    const toDelete: string[] = [];
    params.forEach((_v, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        toDelete.push(key);
      }
    });
    toDelete.forEach(k => params.delete(k));
    params.sort();
    return url.toString();
  } catch {
    return raw; // malformed URLs pass through unchanged
  }
}
