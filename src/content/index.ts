/**
 * FilingLens content script — injected on EDGAR / IR filing pages.
 *
 * Session 1: pick the filing frame, build the DocumentModel + PositionMap, and
 * expose a dev demo proving multi-node range mapping.
 *
 * Session 2: persist the DocumentModel to chrome.storage.session (so the side panel
 * can read it without messaging), broadcast FILING_READY, and handle
 * HIGHLIGHT_RANGE / CLEAR_HIGHLIGHTS messages routed from the side panel via the SW.
 *
 * Session 5: run flagAllSections() after ingestion (pure regex, fast), paint
 * per-type CSS Custom Highlight layers, mount a hover tooltip, persist flags to
 * storage, and handle overlay toggle messages from the side panel.
 *
 * Phase 2.2: LM dictionary is loaded lazily (dynamic import). Pre-warm starts at
 * module load time so JSON chunks are in-flight during the DOM walk; run() awaits
 * completion before flagging to guarantee full LM coverage on every page.
 */

import { ingestDocument } from './ingest';
import { isLowConfidenceGeneric } from './ingest/detect';
import { waitForContent } from './ingest/ready';
import { getSiteProfile, detectGateState } from './ingest/siteProfiles';
import type { IngestResult, LanguageFlag, SentenceSentiment } from '@/types';
import {
  HighlightController,
  demoHighlight,
  applySentimentHighlights,
  clearSentimentLayers,
  type DemoResult,
} from './highlight/demo';
import { FlagOverlayManager } from './highlight/flagOverlay';
import { flagAllSections } from '@/flagging/flagLanguage';
import { awaitLexiconReady } from '@/flagging/lexiconLoader';

// Kick off LM dictionary load immediately so it races against the DOM walk.
const _lmPrewarm = awaitLexiconReady();
import type {
  ContentHighlightMsg,
  ContentShowRedlineMsg,
  ContentSentimentAddMsg,
  ContentSetSentimentOverlayMsg,
  ContentSetFlagOverlayMsg,
  FilingReadyMsg,
  FilingGatedMsg,
  FlagResultsMsg,
} from '@/messages/types';

interface FilingLensDevApi {
  result: IngestResult | null;
  reingest: () => IngestResult;
  highlight: (substring: string) => DemoResult;
  clearHighlight: () => void;
  demo: () => DemoResult;
}

const RAG_HIGHLIGHT_LAYER = 'qa' as const;

// ── Re-injection guard ────────────────────────────────────────────────────────
// The script is delivered two ways: manifest content_scripts on EDGAR, and
// chrome.scripting.executeScript for on-demand "Analyze this page". A second
// injection into the same frame must not re-ingest or attach duplicate
// listeners — it only re-broadcasts the existing results so a freshly opened
// side panel syncs up. The flag and the rebroadcast hook live on globalThis
// because each injection gets a fresh module scope in the same isolated world.
interface FilingLensGlobal {
  __filingLensInjected?: boolean;
  __filingLensRebroadcast?: () => void;
}
const FL_GLOBAL = globalThis as FilingLensGlobal;
const ALREADY_INJECTED = FL_GLOBAL.__filingLensInjected === true;
FL_GLOBAL.__filingLensInjected = true;

/** Minimum normalised-text length for a frame to be treated as the filing frame. */
const MIN_FILING_CHARS = 500;

let _positionMap:        IngestResult['positionMap'] | null = null;
let _highlightController: HighlightController | null = null;
let _flagOverlay:         FlagOverlayManager | null = null;

// ── Session 7 overlay caches ──────────────────────────────────────────────────
// The side panel drives master show/hide toggles for the sentiment heatmap and the
// flag overlay. We cache the inputs so visibility can flip without re-analysis.
let _allFlags:          LanguageFlag[] = [];
let _sentimentCache:    SentenceSentiment[] = [];
let _sentimentVisible = false;
let _flagsVisible     = true;
// Low-confidence generic page: flag overlay stays hidden until the user
// explicitly opts in (the panel's passive pref sync must not enable it).
let _flagOptInRequired = false;

async function run(): Promise<FilingLensDevApi> {
  // Look up any per-site overrides (group, contentSelector, gate hints).
  const profile = getSiteProfile(window.location.href);

  // On-demand injection can fire before a client-rendered (SPA) page has its
  // article text in the DOM. Wait for content to be present/stable first; this
  // resolves immediately on server-rendered pages (EDGAR, static), so it adds
  // no delay there. Group B sites also wait for a known content selector to
  // appear, preventing extraction from running against an interstitial.
  await waitForContent(
    profile?.contentSelector ? { contentSelector: profile.contentSelector } : {},
  );

  const result = ingestDocument();
  const { model, positionMap } = result;

  const doc = bestDoc(result);
  const controller = new HighlightController(doc);

  // Group C: if the page is behind a consent or paywall gate, bail gracefully.
  // We do NOT auto-click or dismiss banners. The content script reports the state
  // to the side panel so the user can act, then retry.
  if (profile?.group === 'C') {
    const gateState = detectGateState(profile, document);
    if (gateState !== 'open') {
      console.debug(
        `[FilingLens] ${window.location.hostname}: content gated (${gateState}) — skipping analysis`,
      );
      const gatedMsg: FilingGatedMsg = {
        target: 'sidepanel',
        type: 'FILING_GATED',
        reason: gateState,
        url: window.location.href,
      };
      chrome.runtime.sendMessage(gatedMsg).catch(() => {});
      return {
        result,
        reingest: () => ingestDocument(),
        highlight: (substring) => demoHighlight(positionMap, substring, doc, controller),
        clearHighlight: () => controller.clear('demo'),
        demo: () => {
          const text = positionMap.text;
          const mid   = Math.floor(text.length / 2);
          const start = text.lastIndexOf('. ', mid);
          const end   = text.indexOf('. ', mid);
          const slice = text.slice(start > 0 ? start + 2 : mid, end > 0 ? end + 1 : mid + 120).trim();
          return demoHighlight(positionMap, slice, doc, controller);
        },
      };
    }
  }

  console.debug(
    `[FilingLens] ingested ${model.filingType} — ${model.companyName ?? 'unknown company'} ` +
      `(${model.sections.length} sections, ${positionMap.text.length} chars, hash ${model.rawTextHash})`,
  );

  const hasIframes = document.querySelector('iframe') !== null;
  const isFilingFrame =
    positionMap.text.length >= MIN_FILING_CHARS || (window.top === window && !hasIframes);

  if (isFilingFrame) {
    _positionMap         = positionMap;
    _highlightController = controller;

    // Session 2: persist DocumentModel so the side panel can fetch without messaging.
    chrome.storage.session
      .set({
        [`filing:model:${model.rawTextHash}`]: model,
        'filing:current': { url: model.source.url, hash: model.rawTextHash },
      })
      .catch(console.warn);

    // Phase 2.2: await full LM dictionary before flagging (pre-warm was started at
    // module load time, so this is usually a no-op by the time we reach here).
    await _lmPrewarm;

    // Flag language — regex pass over all sections with full LM coverage.
    const allFlags = flagAllSections(model.sections, positionMap);
    _allFlags = allFlags;
    // Hide forward-looking / safe-harbor boilerplate flags by default (low signal).
    // Retained in _allFlags so a future in-page toggle can reveal them.
    const shownFlags = allFlags.filter((f) => !f.boilerplate);
    // Fresh document → drop any prior sentiment highlights/cache.
    _sentimentCache = [];

    // Confidence gate: on a generic page that doesn't look like a filing, keep
    // the on-page flag overlay hidden until the user opts in via the side panel
    // (SET_FLAG_OVERLAY). Flags are still computed, persisted, and broadcast.
    if (isLowConfidenceGeneric(model)) {
      _flagsVisible = false;
      _flagOptInRequired = true;
    }

    // Paint the four typed CSS Custom Highlight layers + mount tooltip.
    const flagOverlay = new FlagOverlayManager(doc, controller);
    if (_flagsVisible) flagOverlay.activate(shownFlags, positionMap);
    _flagOverlay = flagOverlay;

    console.debug(
      `[FilingLens] flagged ${allFlags.length} language markers across ${model.sections.length} sections`,
    );

    // Persist flags so the side panel can recover them when opened after ingestion.
    chrome.storage.session
      .set({ [`filing:flags:${model.rawTextHash}`]: shownFlags })
      .catch(console.warn);

    // Broadcast FILING_READY to any open side panel.
    const readyMsg: FilingReadyMsg = {
      target: 'sidepanel',
      type: 'FILING_READY',
      url: model.source.url,
      model,
    };
    chrome.runtime.sendMessage(readyMsg).catch(() => {});

    // Broadcast FLAG_RESULTS so a freshly-opened side panel receives them immediately.
    const flagMsg: FlagResultsMsg = {
      target: 'sidepanel',
      type: 'FLAG_RESULTS',
      flags: shownFlags,
    };
    chrome.runtime.sendMessage(flagMsg).catch(() => {});

    // A repeat injection re-broadcasts these results instead of re-ingesting.
    FL_GLOBAL.__filingLensRebroadcast = () => {
      chrome.runtime.sendMessage(readyMsg).catch(() => {});
      chrome.runtime.sendMessage(flagMsg).catch(() => {});
    };
  }

  return {
    result,
    reingest:     () => ingestDocument(),
    highlight:    (substring) => demoHighlight(positionMap, substring, doc, controller),
    clearHighlight: () => controller.clear('demo'),
    demo: () => {
      const text = positionMap.text;
      const mid   = Math.floor(text.length / 2);
      const start = text.lastIndexOf('. ', mid);
      const end   = text.indexOf('. ', mid);
      const slice = text.slice(start > 0 ? start + 2 : mid, end > 0 ? end + 1 : mid + 120).trim();
      return demoHighlight(positionMap, slice, doc, controller);
    },
  };
}

/** The Document the PositionMap was built from (might be a filing iframe). */
function bestDoc(result: IngestResult): Document {
  const r = result.positionMap.toDomRange([0, 1]);
  return r?.startContainer.ownerDocument ?? document;
}

// ── Message handler ───────────────────────────────────────────────────────────

if (!ALREADY_INJECTED) chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, _sender: chrome.runtime.MessageSender): boolean => {
    const msg = rawMsg as { target?: string; type?: string };
    if (msg.target !== 'content') return false;

    // Session 2: RAG passage highlight.
    if (msg.type === 'HIGHLIGHT_RANGE') {
      const m = rawMsg as ContentHighlightMsg;
      if (_positionMap && _highlightController) {
        const domRange = _positionMap.toDomRange(m.charRange);
        if (domRange) {
          _highlightController.setRanges(RAG_HIGHLIGHT_LAYER, [domRange]);
          const rect = domRange.getBoundingClientRect();
          if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
            domRange.startContainer.parentElement?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          }
        }
      }
      return false;
    }

    if (msg.type === 'CLEAR_HIGHLIGHTS') {
      _highlightController?.clear(RAG_HIGHLIGHT_LAYER);
      return false;
    }

    // Session 6: paint the on-page redline overlay for ADDED passages.
    if (msg.type === 'SHOW_REDLINE') {
      const m = rawMsg as ContentShowRedlineMsg;
      if (_positionMap && _highlightController) {
        const ranges: Range[] = [];
        for (const charRange of m.ranges) {
          const domRange = _positionMap.toDomRange(charRange);
          if (domRange) ranges.push(domRange);
        }
        _highlightController.setRanges('redline', ranges);
        // Scroll the first added passage into view.
        const first = ranges[0];
        if (first) {
          const rect = first.getBoundingClientRect();
          if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
            first.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
      return false;
    }

    if (msg.type === 'CLEAR_REDLINE') {
      _highlightController?.clear('redline');
      return false;
    }

    // Session 4 (wired in Session 7): receive sentiment ranges section-by-section.
    // We always cache them; we only paint when the heatmap overlay is visible.
    if (msg.type === 'SENTIMENT_ADD_RANGES') {
      const m = rawMsg as ContentSentimentAddMsg;
      _sentimentCache.push(...m.results);
      if (_sentimentVisible && _positionMap && _highlightController) {
        applySentimentHighlights(_positionMap, _highlightController, m.results);
      }
      return false;
    }

    if (msg.type === 'CLEAR_SENTIMENT') {
      _sentimentCache = [];
      if (_highlightController) clearSentimentLayers(_highlightController);
      return false;
    }

    // Session 7: master heatmap toggle — show/hide from the cache, no re-analysis.
    if (msg.type === 'SET_SENTIMENT_OVERLAY') {
      const m = rawMsg as ContentSetSentimentOverlayMsg;
      _sentimentVisible = m.enabled;
      if (!_highlightController) return false;
      if (m.enabled) {
        if (_positionMap && _sentimentCache.length > 0) {
          applySentimentHighlights(_positionMap, _highlightController, _sentimentCache);
        }
      } else {
        clearSentimentLayers(_highlightController);
      }
      return false;
    }

    // Session 7: master flag toggle — activate/deactivate the flag overlay layer.
    if (msg.type === 'SET_FLAG_OVERLAY') {
      const m = rawMsg as ContentSetFlagOverlayMsg;
      // Confidence gate: a passive pref sync may not enable flags on a page
      // that doesn't look like a filing — only an explicit user gesture can.
      if (m.enabled && _flagOptInRequired && !m.explicit) return false;
      if (m.explicit) _flagOptInRequired = false;
      _flagsVisible = m.enabled;
      if (_flagOverlay && _positionMap) {
        if (m.enabled) _flagOverlay.activate(_allFlags.filter((f) => !f.boilerplate), _positionMap);
        else _flagOverlay.deactivate();
      }
      return false;
    }

    return false;
  },
);

/**
 * Decide whether THIS frame should run ingestion. (Content script runs in all_frames.)
 *   • Top frame always ingests — pickFilingRoot descends into same-origin iframes.
 *   • Child frame ingests only if it is CROSS-ORIGIN to its parent, because the parent
 *     cannot reach into it via contentDocument. Same-origin children stay silent.
 */
function shouldIngestThisFrame(): boolean {
  if (window.top === window) return true;
  try {
    void window.parent.location.href;
    return false; // same-origin → parent will descend into us
  } catch {
    return true;  // cross-origin → the parent cannot read us
  }
}

if (ALREADY_INJECTED) {
  // Second delivery (e.g. "Analyze this page" clicked twice, or a page that
  // already ran the manifest script). If the first attempt produced results,
  // just resync the side panel. If it did NOT (rebroadcast unset — e.g. a slow
  // SPA had no content yet on the first try), re-run ingestion now that the page
  // may have rendered. run() adds no listeners, so a re-run is safe.
  if (FL_GLOBAL.__filingLensRebroadcast) {
    FL_GLOBAL.__filingLensRebroadcast();
  } else {
    run().catch((err) => console.error('[FilingLens] re-ingestion failed', err));
  }
} else if (shouldIngestThisFrame()) {
  run().then((api) => {
    (globalThis as unknown as { __FilingLens?: FilingLensDevApi }).__FilingLens = api;
    console.debug('[FilingLens] dev API ready: __FilingLens.demo() / .highlight(text)');
  }).catch((err) => {
    console.error('[FilingLens] ingestion failed', err);
  });
}
