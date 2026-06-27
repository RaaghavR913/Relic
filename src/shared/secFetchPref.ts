// ============================================================
// Relic — "fetch prior-year filings from SEC.gov" preference
// ------------------------------------------------------------
// The redline (Changes tab) is the only feature that makes a network request:
// it fetches last year's comparable filing from EDGAR to diff against. This
// preference lets the user gate that one request. Default on.
//
// Persisted to chrome.storage.local; both the settings page and the redline
// panel read it. Cross-context changes propagate via chrome.storage.onChanged,
// so toggling it in Settings updates an open side panel without a reload.
// ============================================================

import { useEffect, useState } from 'react';

const KEY = 'relic:secFetch';
export const SEC_FETCH_DEFAULT = true;

/** One-shot read, for non-React callers (e.g. just before a fetch). */
export async function getSecFetchEnabled(): Promise<boolean> {
  try {
    const data = await chrome.storage.local.get(KEY);
    const v = data[KEY];
    return typeof v === 'boolean' ? v : SEC_FETCH_DEFAULT;
  } catch {
    return SEC_FETCH_DEFAULT;
  }
}

/** Subscribe to the SEC-fetch preference; stays in sync across contexts. */
export function useSecFetchPref(): {
  enabled: boolean;
  loaded: boolean;
  setSecFetch: (v: boolean) => void;
} {
  const [enabled, setEnabled] = useState(SEC_FETCH_DEFAULT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    chrome.storage.local
      .get(KEY)
      .then((data: Record<string, unknown>) => {
        if (!alive) return;
        const v = data[KEY];
        setEnabled(typeof v === 'boolean' ? v : SEC_FETCH_DEFAULT);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'local' && changes[KEY]) {
        setEnabled(Boolean(changes[KEY].newValue ?? SEC_FETCH_DEFAULT));
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const setSecFetch = (v: boolean): void => {
    setEnabled(v);
    chrome.storage.local.set({ [KEY]: v }).catch(() => {});
  };

  return { enabled, loaded, setSecFetch };
}
