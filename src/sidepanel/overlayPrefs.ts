// ============================================================
// Disclora — overlay preferences store (Session 7)
// ------------------------------------------------------------
// Single source of truth for the on-page language-flag overlay toggle.
// Persisted to chrome.storage.local and pushed to the active tab's content
// script as a pure visibility switch.
//
// Components subscribe via useOverlayPrefs(); a tiny in-module emitter keeps
// every instance in sync without a global React context.
// ============================================================

import { useEffect, useState } from 'react';
import type { ContentSetFlagOverlayMsg } from '@/messages/types';

export interface OverlayPrefs {
  /** Language-flag underlines + hover tooltip visible on the page. Default on. */
  flags: boolean;
}

const FLAGS_KEY = 'disclora:flagsEnabled';

const DEFAULTS: OverlayPrefs = { flags: true };

let _prefs: OverlayPrefs = { ...DEFAULTS };
let _loaded = false;
const _listeners = new Set<(p: OverlayPrefs) => void>();

function emit(): void {
  for (const l of _listeners) l(_prefs);
}

async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function pushFlags(enabled: boolean, explicit = false): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentSetFlagOverlayMsg = {
    target: 'content',
    type: 'SET_FLAG_OVERLAY',
    enabled,
    explicit,
  };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

let _loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (_loadPromise) return _loadPromise;
  _loadPromise = chrome.storage.local
    .get([FLAGS_KEY])
    .then((data: Record<string, unknown>) => {
      _prefs = {
        flags: (data[FLAGS_KEY] as boolean | undefined) ?? DEFAULTS.flags,
      };
      _loaded = true;
      emit();
      // Push the persisted state to the page so the content script matches it
      // even when its defaults differ (flags default to visible on ingest).
      void pushFlags(_prefs.flags);
    })
    .catch(() => {
      _loaded = true;
    });
  return _loadPromise;
}

export function setFlags(enabled: boolean): void {
  _prefs = { ..._prefs, flags: enabled };
  emit();
  chrome.storage.local.set({ [FLAGS_KEY]: enabled }).catch(() => {});
  // Setter calls come from user gestures (overlay toggle / banner action).
  void pushFlags(enabled, true);
}

/**
 * Subscribe to overlay prefs. Returns the current prefs plus the setter and a
 * `loaded` flag so callers can avoid flashing the default state.
 */
export function useOverlayPrefs(): {
  prefs: OverlayPrefs;
  loaded: boolean;
  setFlags: (v: boolean) => void;
} {
  const [prefs, setPrefs] = useState<OverlayPrefs>(_prefs);
  const [loaded, setLoadedState] = useState(_loaded);

  useEffect(() => {
    const listener = (p: OverlayPrefs) => setPrefs({ ...p });
    _listeners.add(listener);
    void ensureLoaded().then(() => {
      setPrefs({ ..._prefs });
      setLoadedState(true);
    });
    return () => {
      _listeners.delete(listener);
    };
  }, []);

  return { prefs, loaded, setFlags };
}
