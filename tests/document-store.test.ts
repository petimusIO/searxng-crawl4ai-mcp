import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/document-store.js';

const SECTION = {
  id: 's0',
  heading: 'Install',
  text: 'Create the project first.',
  source_offset: { start: 0, end: 25 },
};

function makeStore(now: { value: number }, extras: { maxDocuments?: number; maxBytes?: number; ttlMs?: number } = {}) {
  return new DocumentStore({
    now: () => now.value,
    maxDocuments: extras.maxDocuments ?? 64,
    maxBytes: extras.maxBytes ?? 32 * 1024 * 1024,
    ttlMs: extras.ttlMs ?? 60 * 60 * 1000,
  });
}

describe('DocumentStore', () => {
  it('retains an immutable snapshot with opaque id and stable section ids', () => {
    const now = { value: 1_700_000_000_000 };
    const store = makeStore(now);
    const saved = store.save({
      url: 'https://example.com/docs',
      title: 'Docs',
      markdown: '# Install\n\nCreate the project first.',
      sections: [SECTION],
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.document.document_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(saved.document.sections[0].id).toBe('s0');
    expect(saved.document.saved_at).toBe(now.value);
    expect(saved.document.expires_at).toBe(now.value + 60 * 60 * 1000);
    expect(saved.document.markdown).toBe('# Install\n\nCreate the project first.');

    const again = store.getByUrl('https://example.com/docs');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.document.document_id).toBe(saved.document.document_id);
  });

  it('returns expired/missing without exposing a newer page under the old id', () => {
    const now = { value: 1_000 };
    const store = makeStore(now, { ttlMs: 100, maxDocuments: 1, maxBytes: 4096 });

    const first = store.save({
      url: 'https://example.com/a',
      title: 'A',
      markdown: 'alpha-page',
      sections: [{ ...SECTION, text: 'alpha-page' }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const oldId = first.document.document_id;

    now.value += 101;
    const expired = store.get(oldId);
    expect(expired).toEqual({ ok: false, reason: 'expired' });

    const replacement = store.save({
      url: 'https://example.com/a',
      title: 'A2',
      markdown: 'beta-page!!',
      sections: [{ ...SECTION, text: 'beta-page!!' }],
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(replacement.document.document_id).not.toBe(oldId);
    expect(store.get(oldId)).toEqual({ ok: false, reason: 'missing' });
    expect(store.get(replacement.document.document_id).ok).toBe(true);

    const evicted = store.save({
      url: 'https://example.com/b',
      title: 'B',
      markdown: 'gamma-page!',
      sections: [{ ...SECTION, text: 'gamma-page!' }],
    });
    expect(evicted.ok).toBe(true);
    expect(store.get(replacement.document.document_id)).toEqual({ ok: false, reason: 'missing' });
    expect(store.get('not-a-real-id')).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses a handle when the document is larger than store capacity', () => {
    const now = { value: 1 };
    const store = makeStore(now, { maxBytes: 8 });
    const result = store.save({
      url: 'https://example.com/huge',
      title: 'Huge',
      markdown: '0123456789',
      sections: [SECTION],
    });
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });
});
