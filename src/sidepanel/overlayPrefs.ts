// ============================================================
// FilingLens — overlay preferences store (Session 7)
// ------------------------------------------------------------
// Single source of truth for the two master on-page overlay toggles
// (sentiment heatmap, language flags). Persisted to chrome.storage.local and
// pushed to the active tab's content script as pure visibility switches.
//
// Several components subscribe (OverlayControls + SentimentPanel), so a tiny
// in-module emitter keeps every useOverlayPrefs() instance in sync without a
// global React context.
// ============================================================

import { useEffect, useState } from 'react';
import type {
  ContentSetSentimentOverlayMsg,
  ContentSetFlagOverlayMsg,
} from '@/messages/types';

export interface OverlayPrefs {
  /** Sentiment heatmap visible on the page. Default off until first analysis. */
  heatmap: boolean;
  /** Language-flag underlines + hover tooltip visible on the page. Default on. */
  flags: boolean;
}

const HEATMAP_KEY = 'filinglens:sentimentEnabled';
const FLAGS_KEY = 'filinglens:flagsEnabled';

const DEFAULTS: OverlayPrefs = { heatmap: false, flags: true };

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

async function pushSentiment(enabled: boolean): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentSetSentimentOverlayMsg = {
    target: 'content',
    type: 'SET_SENTIMENT_OVERLAY',
    enabled,
  };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function pushFlags(enabled: boolean): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentSetFlagOverlayMsg = {
    target: 'content',
    type: 'SET_FLAG_OVERLAY',
    enabled,
  };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

let _loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (_loadPromise) return _loadPromise;
  _loadPromise = chrome.storage.local
    .get([HEATMAP_KEY, FLAGS_KEY])
    .then((data: Record<string, unknown>) => {
      _prefs = {
        heatmap: (data[HEATMAP_KEY] as boolean | undefined) ?? DEFAULTS.heatmap,
        flags: (data[FLAGS_KEY] as boolean | undefined) ?? DEFAULTS.flags,
      };
      _loaded = true;
      emit();
      // Push the persisted state to the page so the content script matches it
      // even when its defaults differ (flags default to visible on ingest).
      void pushSentiment(_prefs.heatmap);
      void pushFlags(_prefs.flags);
    })
    .catch(() => {
      _loaded = true;
    });
  return _loadPromise;
}

export function setHeatmap(enabled: boolean): void {
  _prefs = { ..._prefs, heatmap: enabled };
  emit();
  chrome.storage.local.set({ [HEATMAP_KEY]: enabled }).catch(() => {});
  void pushSentiment(enabled);
}

export function setFlags(enabled: boolean): void {
  _prefs = { ..._prefs, flags: enabled };
  emit();
  chrome.storage.local.set({ [FLAGS_KEY]: enabled }).catch(() => {});
  void pushFlags(enabled);
}

/** Read the current heatmap pref synchronously (best-effort; may be pre-load default). */
export function heatmapEnabled(): boolean {
  return _prefs.heatmap;
}

/**
 * Subscribe to overlay prefs. Returns the current prefs plus setters and a
 * `loaded` flag so callers can avoid flashing the default state.
 */
export function useOverlayPrefs(): {
  prefs: OverlayPrefs;
  loaded: boolean;
  setHeatmap: (v: boolean) => void;
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

  return { prefs, loaded, setHeatmap, setFlags };
}
