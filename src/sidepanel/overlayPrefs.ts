// ============================================================
// Disclora — overlay preferences store (Session 7 · extended Session 8)
// ------------------------------------------------------------
// Single source of truth for the on-page language-flag overlay:
//   • flags        — master show/hide switch
//   • types        — per-category visibility (uncertainty / weak_modal / …)
//   • boilerplate  — include forward-looking / safe-harbor matches
//
// Persisted to chrome.storage.local and pushed to the active tab's content
// script as a pure visibility switch (no re-analysis).
//
// Components subscribe via useOverlayPrefs(); a tiny in-module emitter keeps
// every instance in sync without a global React context.
// ============================================================

import { useEffect, useState } from 'react';
import type { LanguageFlag } from '@/types';
import type { ContentSetFlagOverlayMsg } from '@/messages/types';

export type FlagCategory = LanguageFlag['type'];

/** Canonical category order — drives the Settings legend and the defaults below. */
export const FLAG_CATEGORIES: readonly FlagCategory[] = [
  'uncertainty',
  'weak_modal',
  'litigious',
  'negative',
];

export interface OverlayPrefs {
  /** Master switch: language-flag underlines + hover tooltip on the page. Default on. */
  flags: boolean;
  /** Per-category visibility. A false category is hidden even with the master on. */
  types: Record<FlagCategory, boolean>;
  /** Show forward-looking / safe-harbor boilerplate matches. Default off (low signal). */
  boilerplate: boolean;
}

const FLAGS_KEY = 'disclora:flagsEnabled';
const TYPES_KEY = 'disclora:flagTypes';
const BOILERPLATE_KEY = 'disclora:showBoilerplate';

const ALL_TYPES_ON: Record<FlagCategory, boolean> = {
  uncertainty: true,
  weak_modal: true,
  litigious: true,
  negative: true,
};

const DEFAULTS: OverlayPrefs = {
  flags: true,
  types: { ...ALL_TYPES_ON },
  boilerplate: false,
};

let _prefs: OverlayPrefs = { flags: DEFAULTS.flags, types: { ...DEFAULTS.types }, boilerplate: DEFAULTS.boilerplate };
let _loaded = false;
const _listeners = new Set<(p: OverlayPrefs) => void>();

function snapshot(): OverlayPrefs {
  return { flags: _prefs.flags, types: { ..._prefs.types }, boilerplate: _prefs.boilerplate };
}

function emit(): void {
  const snap = snapshot();
  for (const l of _listeners) l(snap);
}

async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

/** Push the full current overlay state to the active tab's content script. */
async function pushOverlay(explicit = false): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentSetFlagOverlayMsg = {
    target: 'content',
    type: 'SET_FLAG_OVERLAY',
    enabled: _prefs.flags,
    explicit,
    types: { ..._prefs.types },
    boilerplate: _prefs.boilerplate,
  };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/** Coerce a persisted value into a complete per-category map (tolerant of partial/legacy data). */
function normalizeTypes(raw: unknown): Record<FlagCategory, boolean> {
  const out: Record<FlagCategory, boolean> = { ...ALL_TYPES_ON };
  if (raw && typeof raw === 'object') {
    for (const cat of FLAG_CATEGORIES) {
      const v = (raw as Record<string, unknown>)[cat];
      if (typeof v === 'boolean') out[cat] = v;
    }
  }
  return out;
}

let _loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (_loadPromise) return _loadPromise;
  _loadPromise = chrome.storage.local
    .get([FLAGS_KEY, TYPES_KEY, BOILERPLATE_KEY])
    .then((data: Record<string, unknown>) => {
      _prefs = {
        flags: (data[FLAGS_KEY] as boolean | undefined) ?? DEFAULTS.flags,
        types: normalizeTypes(data[TYPES_KEY]),
        boilerplate: (data[BOILERPLATE_KEY] as boolean | undefined) ?? DEFAULTS.boilerplate,
      };
      _loaded = true;
      emit();
      // Push the persisted state to the page so the content script matches it
      // even when its defaults differ (flags default to visible on ingest).
      void pushOverlay();
    })
    .catch(() => {
      _loaded = true;
    });
  return _loadPromise;
}

/** Toggle the master language-flag overlay. Setter calls come from user gestures. */
export function setFlags(enabled: boolean): void {
  _prefs = { ..._prefs, flags: enabled };
  emit();
  chrome.storage.local.set({ [FLAGS_KEY]: enabled }).catch(() => {});
  void pushOverlay(true);
}

/** Toggle a single flag category's on-page visibility. */
export function setType(category: FlagCategory, enabled: boolean): void {
  _prefs = { ..._prefs, types: { ..._prefs.types, [category]: enabled } };
  emit();
  chrome.storage.local.set({ [TYPES_KEY]: { ..._prefs.types } }).catch(() => {});
  void pushOverlay(true);
}

/** Toggle inclusion of forward-looking / safe-harbor boilerplate matches. */
export function setBoilerplate(enabled: boolean): void {
  _prefs = { ..._prefs, boilerplate: enabled };
  emit();
  chrome.storage.local.set({ [BOILERPLATE_KEY]: enabled }).catch(() => {});
  void pushOverlay(true);
}

/**
 * Subscribe to overlay prefs. Returns the current prefs plus setters and a
 * `loaded` flag so callers can avoid flashing the default state.
 */
export function useOverlayPrefs(): {
  prefs: OverlayPrefs;
  loaded: boolean;
  setFlags: (v: boolean) => void;
  setType: (category: FlagCategory, v: boolean) => void;
  setBoilerplate: (v: boolean) => void;
} {
  const [prefs, setPrefs] = useState<OverlayPrefs>(snapshot);
  const [loaded, setLoadedState] = useState(_loaded);

  useEffect(() => {
    const listener = (p: OverlayPrefs) => setPrefs(p);
    _listeners.add(listener);
    void ensureLoaded().then(() => {
      setPrefs(snapshot());
      setLoadedState(true);
    });
    return () => {
      _listeners.delete(listener);
    };
  }, []);

  return { prefs, loaded, setFlags, setType, setBoilerplate };
}
