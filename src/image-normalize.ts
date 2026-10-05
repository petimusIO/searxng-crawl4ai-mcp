import { normalizeUrl } from './url-normalizer.js';

export interface SearchImage {
  title: string;
  sourcePageUrl: string;
  imageUrl: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  engine?: string;
}

export interface FourgetImageSource {
  url?: string;
  width?: number;
  height?: number;
}

export interface FourgetRawImage {
  title?: string;
  url?: string;
  source?: FourgetImageSource[];
}

export interface SearxngRawImage {
  title?: string;
  url?: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  engine?: string;
  img_format?: string;
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function firstUsableSource(sources: FourgetImageSource[] | undefined): FourgetImageSource | null {
  for (const source of sources ?? []) {
    if (isHttpUrl(source?.url)) return source;
  }
  return null;
}

function lastUsableSource(sources: FourgetImageSource[] | undefined): FourgetImageSource | null {
  const list = sources ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isHttpUrl(list[index]?.url)) return list[index];
  }
  return null;
}

export function normalizeFourgetImage(raw: FourgetRawImage | null | undefined): SearchImage | null {
  if (!raw) return null;
  const title = raw.title?.trim() || '';
  const sourcePageUrl = raw.url?.trim() || '';
  if (!title || !isHttpUrl(sourcePageUrl)) return null;

  const full = firstUsableSource(raw.source);
  const thumb = lastUsableSource(raw.source);
  if (!full?.url || !thumb?.url) return null;

  return {
    title,
    sourcePageUrl,
    imageUrl: full.url,
    thumbnailUrl: thumb.url,
    width: typeof full.width === 'number' ? full.width : undefined,
    height: typeof full.height === 'number' ? full.height : undefined,
    engine: 'fourget',
  };
}

export function normalizeSearxngImage(raw: SearxngRawImage | null | undefined): SearchImage | null {
  if (!raw) return null;
  const title = raw.title?.trim() || '';
  const sourcePageUrl = raw.url?.trim() || '';
  const imageUrl = raw.img_src?.trim() || '';
  const thumbnailUrl = raw.thumbnail_src?.trim() || raw.thumbnail?.trim() || imageUrl;
  if (!title || !isHttpUrl(sourcePageUrl) || !isHttpUrl(imageUrl) || !isHttpUrl(thumbnailUrl)) {
    return null;
  }

  return {
    title,
    sourcePageUrl,
    imageUrl,
    thumbnailUrl,
    engine: raw.engine?.trim() || 'searxng',
  };
}

export function dedupeSearchImages(images: SearchImage[]): SearchImage[] {
  const seen = new Set<string>();
  const unique: SearchImage[] = [];

  for (const image of images) {
    const key = normalizeUrl(image.imageUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(image);
  }

  return unique;
}
