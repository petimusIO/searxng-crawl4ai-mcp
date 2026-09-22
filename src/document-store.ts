import { randomUUID } from 'node:crypto';

export interface StoredSection {
  id: string;
  heading?: string;
  text: string;
  source_offset: { start: number; end: number };
  definitions?: Array<{
    identifier: string;
    text: string;
    source_offset: { start: number; end: number };
  }>;
}

export interface StoredDocument {
  document_id: string;
  url: string;
  title: string;
  markdown: string;
  sections: StoredSection[];
  saved_at: number;
  expires_at: number;
}

export interface DocumentStoreOptions {
  now?: () => number;
  maxDocuments?: number;
  maxBytes?: number;
  ttlMs?: number;
}

export type DocumentLookup =
  | { ok: true; document: StoredDocument }
  | { ok: false; reason: 'missing' | 'expired' };

export type DocumentSaveResult =
  | { ok: true; document: StoredDocument }
  | { ok: false; reason: 'too_large' };

const DEFAULT_MAX_DOCUMENTS = 64;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function freezeOffset(offset: { start: number; end: number }) {
  return Object.freeze({ start: offset.start, end: offset.end });
}

function freezeSection(section: StoredSection): StoredSection {
  const frozen: StoredSection = {
    id: section.id,
    text: section.text,
    source_offset: freezeOffset(section.source_offset),
  };
  if (section.heading !== undefined) frozen.heading = section.heading;
  if (section.definitions) {
    frozen.definitions = Object.freeze(section.definitions.map((definition) => Object.freeze({
      identifier: definition.identifier,
      text: definition.text,
      source_offset: freezeOffset(definition.source_offset),
    }))) as StoredSection['definitions'];
  }
  return Object.freeze(frozen) as StoredSection;
}

function freezeDocument(document: StoredDocument): StoredDocument {
  return Object.freeze({
    document_id: document.document_id,
    url: document.url,
    title: document.title,
    markdown: document.markdown,
    sections: Object.freeze(document.sections.map(freezeSection)) as StoredSection[],
    saved_at: document.saved_at,
    expires_at: document.expires_at,
  }) as StoredDocument;
}

function evidenceBytes(document: StoredDocument): number {
  return Buffer.byteLength(JSON.stringify({
    document_id: document.document_id,
    url: document.url,
    title: document.title,
    markdown: document.markdown,
    sections: document.sections,
    saved_at: document.saved_at,
    expires_at: document.expires_at,
  }), 'utf8');
}

export class DocumentStore {
  private readonly now: () => number;
  private readonly maxDocuments: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly byId = new Map<string, StoredDocument>();
  private readonly byUrl = new Map<string, string>();

  constructor(options: DocumentStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  save(input: {
    url: string;
    title: string;
    markdown: string;
    sections: StoredSection[];
  }): DocumentSaveResult {
    this.purgeExpired();

    const existingId = this.byUrl.get(input.url);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing && existing.expires_at > this.now()) {
        this.touch(existingId);
        return { ok: true, document: existing };
      }
    }

    if (this.maxDocuments <= 0 || this.maxBytes <= 0) {
      return { ok: false, reason: 'too_large' };
    }

    const saved_at = this.now();
    const document = freezeDocument({
      document_id: randomUUID(),
      url: input.url,
      title: input.title,
      markdown: input.markdown,
      sections: input.sections,
      saved_at,
      expires_at: saved_at + this.ttlMs,
    });
    const bytes = evidenceBytes(document);
    if (bytes > this.maxBytes) {
      return { ok: false, reason: 'too_large' };
    }

    this.evictUntilFit(bytes);
    if (this.byId.size >= this.maxDocuments || this.totalBytes() + bytes > this.maxBytes) {
      return { ok: false, reason: 'too_large' };
    }

    this.byId.set(document.document_id, document);
    this.byUrl.set(input.url, document.document_id);
    return { ok: true, document };
  }

  get(documentId: string): DocumentLookup {
    const document = this.byId.get(documentId);
    if (!document) return { ok: false, reason: 'missing' };
    if (document.expires_at <= this.now()) {
      this.remove(documentId);
      return { ok: false, reason: 'expired' };
    }
    this.touch(documentId);
    return { ok: true, document };
  }

  getByUrl(url: string): DocumentLookup {
    const documentId = this.byUrl.get(url);
    if (!documentId) return { ok: false, reason: 'missing' };
    return this.get(documentId);
  }

  has(documentId: string): boolean {
    return this.get(documentId).ok;
  }

  private totalBytes(): number {
    let total = 0;
    for (const document of this.byId.values()) {
      total += evidenceBytes(document);
    }
    return total;
  }

  private touch(documentId: string): void {
    const document = this.byId.get(documentId);
    if (!document) return;
    this.byId.delete(documentId);
    this.byId.set(documentId, document);
  }

  private remove(documentId: string): void {
    const document = this.byId.get(documentId);
    this.byId.delete(documentId);
    if (document && this.byUrl.get(document.url) === documentId) {
      this.byUrl.delete(document.url);
    }
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, document] of [...this.byId]) {
      if (document.expires_at <= now) this.remove(id);
    }
  }

  private evictUntilFit(neededBytes: number): void {
    while (
      this.byId.size > 0
      && (this.byId.size >= this.maxDocuments || this.totalBytes() + neededBytes > this.maxBytes)
    ) {
      const oldest = this.byId.keys().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
  }
}
