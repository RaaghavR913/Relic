// ============================================================
// Relic — session-storage persistence + eviction
// ------------------------------------------------------------
// persistFilingToSession writes the whole DocumentModel under filing:model:<hash>
// (plus filing:flags:<hash>). chrome.storage.session has a hard ~10 MB quota, so
// each write must first evict the *prior* filing's keys — otherwise a few large
// 10-Ks in one browser session exhaust the quota and set() fails.
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { persistFilingToSession, loadFilingFromSession } from '../src/shared/filingSession';
import type { DocumentModel, LanguageFlag } from '../src/types';

// Minimal in-memory chrome.storage.session mock covering the surface the module
// uses: get(null) enumeration, get(<key>), set(obj), remove(string[]). Returns the
// backing Map so tests can assert exactly which keys survive.
function installSessionMock(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  const session = {
    get: async (keys: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(store);
      const arr = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of arr) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { session } };
  return store;
}

function makeModel(hash: string, url: string): DocumentModel {
  return {
    source: { url, host: 'edgar', cik: '320193' },
    filingType: '10-K',
    companyName: 'Test Co.',
    sections: [],
    rawTextHash: hash,
  };
}

describe('persistFilingToSession — session-storage eviction', () => {
  let store: Map<string, unknown>;
  beforeEach(() => {
    store = installSessionMock();
  });

  it('evicts the prior filing model+flags when a new filing is persisted', async () => {
    const flagsA: LanguageFlag[] = [
      { type: 'uncertainty', range: [0, 3], sectionId: 's1', term: 'may', note: 'n' },
    ];
    const flagsB: LanguageFlag[] = [
      { type: 'litigious', range: [1, 4], sectionId: 's2', term: 'sue', note: 'n' },
    ];

    await persistFilingToSession(makeModel('AAAA', 'https://www.sec.gov/a'), flagsA);
    await persistFilingToSession(makeModel('BBBB', 'https://www.sec.gov/b'), flagsB);

    // A's model+flags are gone; only B's plus the filing:current pointer remain.
    expect([...store.keys()].sort()).toEqual([
      'filing:current',
      'filing:flags:BBBB',
      'filing:model:BBBB',
    ]);
    expect(store.has('filing:model:AAAA')).toBe(false);
    expect(store.has('filing:flags:AAAA')).toBe(false);

    // filing:current points to B; the loader returns B's model + flags.
    const loaded = await loadFilingFromSession();
    expect(loaded.model?.rawTextHash).toBe('BBBB');
    expect(loaded.flags).toEqual(flagsB);
    expect((store.get('filing:current') as { hash: string }).hash).toBe('BBBB');
  });

  it('keeps the current filing’s own keys when it is re-persisted (idempotent)', async () => {
    const flags: LanguageFlag[] = [
      { type: 'negative', range: [0, 2], sectionId: 's', term: 'loss', note: 'n' },
    ];
    await persistFilingToSession(makeModel('SAME', 'https://www.sec.gov/x'), flags);
    await persistFilingToSession(makeModel('SAME', 'https://www.sec.gov/x'), flags);

    expect(store.has('filing:model:SAME')).toBe(true);
    expect(store.has('filing:flags:SAME')).toBe(true);
    const loaded = await loadFilingFromSession();
    expect(loaded.model?.rawTextHash).toBe('SAME');
    expect(loaded.flags).toEqual(flags);
  });

  it('persists without flags and still evicts a prior filing', async () => {
    await persistFilingToSession(makeModel('OLD', 'https://www.sec.gov/old'), [
      { type: 'weak_modal', range: [0, 1], sectionId: 's', term: 'could', note: 'n' },
    ]);
    await persistFilingToSession(makeModel('NEW', 'https://www.sec.gov/new'));

    expect(store.has('filing:model:OLD')).toBe(false);
    expect(store.has('filing:flags:OLD')).toBe(false);
    expect(store.has('filing:model:NEW')).toBe(true);
    // No flags were supplied for NEW, so no flags key is written.
    expect(store.has('filing:flags:NEW')).toBe(false);
    const loaded = await loadFilingFromSession();
    expect(loaded.model?.rawTextHash).toBe('NEW');
    expect(loaded.flags).toBeNull();
  });
});
