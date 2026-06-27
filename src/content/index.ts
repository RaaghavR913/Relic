/**
 * Relic content script — injected on EDGAR / IR filing pages.
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
import type { IngestResult, LanguageFlag } from '@/types';
import {
  HighlightController,
  demoHighlight,
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
  ContentSetFlagOverlayMsg,
  FilingReadyMsg,
  FilingGatedMsg,
  FlagResultsMsg,
} from '@/messages/types';

interface RelicDevApi {
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
// injection into the same frame is always an explicit user re-analyze. Because
// each injection gets a fresh module scope in the same isolated world — while the
// message listeners and highlight state from the FIRST injection stay live — a
// re-analyze must re-run ingestion inside that original scope, not the new one.
// We expose a re-ingest closure (bound to the first scope) on globalThis for the
// new injection to call; it re-runs run(), which tears down the prior overlay
// first so no duplicate tooltip / mouse listeners leak.
interface RelicGlobal {
  __relicInjected?: boolean;
  __relicReingest?: () => void;
}
const RELIC_GLOBAL = globalThis as RelicGlobal;
const ALREADY_INJECTED = RELIC_GLOBAL.__relicInjected === true;
RELIC_GLOBAL.__relicInjected = true;

/** Minimum normalised-text length for a frame to be treated as the filing frame. */
const MIN_FILING_CHARS = 500;

let _positionMap:        IngestResult['positionMap'] | null = null;
let _highlightController: HighlightController | null = null;
let _flagOverlay:         FlagOverlayManager | null = null;

// ── Session 7 overlay cache ───────────────────────────────────────────────────
// The side panel drives the flag overlay's visibility. We cache the full flag set
// so visibility (master switch, per-category, boilerplate) can flip without
// re-analysis.
let _allFlags:          LanguageFlag[] = [];
let _flagsVisible     = true;
// Per-category visibility + boilerplate inclusion, mirrored from the side panel's
// overlay prefs. Defaults match the historical master-only behaviour: every
// category on, boilerplate hidden.
let _flagTypes: Record<LanguageFlag['type'], boolean> = {
  uncertainty: true,
  weak_modal:  true,
  litigious:   true,
  negative:    true,
};
let _showBoilerplate = false;
// Low-confidence generic page: flag overlay stays hidden until the user
// explicitly opts in (the panel's passive pref sync must not enable it).
let _flagOptInRequired = false;

/** The subset of cached flags currently eligible to paint, per category + boilerplate prefs. */
function visibleFlags(): LanguageFlag[] {
  return _allFlags.filter(
    (f) => _flagTypes[f.type] !== false && (_showBoilerplate || !f.boilerplate),
  );
}

async function run(): Promise<RelicDevApi> {
  // Re-analyze (run() called a second time in this scope): tear down the prior
  // ingestion's overlay so we don't leak a duplicate hover tooltip / mouse
  // listeners, and clear any stale highlight layers before re-ingesting.
  _flagOverlay?.deactivate();
  _flagOverlay = null;
  _highlightController?.clear();

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
        `[Relic] ${window.location.hostname}: content gated (${gateState}) — skipping analysis`,
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
    `[Relic] ingested ${model.filingType} — ${model.companyName ?? 'unknown company'} ` +
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

    // Confidence gate: on a generic page that doesn't look like a filing, keep
    // the on-page flag overlay hidden until the user opts in via the side panel
    // (SET_FLAG_OVERLAY). Flags are still computed, persisted, and broadcast.
    if (isLowConfidenceGeneric(model)) {
      _flagsVisible = false;
      _flagOptInRequired = true;
    }

    // Paint the four typed CSS Custom Highlight layers + mount tooltip. The
    // overlay honours per-category + boilerplate prefs (defaults match shownFlags);
    // the side panel's pref sync refines this moments later via SET_FLAG_OVERLAY.
    const flagOverlay = new FlagOverlayManager(doc, controller);
    if (_flagsVisible) flagOverlay.activate(visibleFlags(), positionMap);
    _flagOverlay = flagOverlay;

    console.debug(
      `[Relic] flagged ${allFlags.length} language markers across ${model.sections.length} sections`,
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

    // Session 7/8: flag overlay sync — master switch + per-category + boilerplate.
    if (msg.type === 'SET_FLAG_OVERLAY') {
      const m = rawMsg as ContentSetFlagOverlayMsg;
      // Confidence gate: a passive pref sync may not enable flags on a page
      // that doesn't look like a filing — only an explicit user gesture can.
      if (m.enabled && _flagOptInRequired && !m.explicit) return false;
      if (m.explicit) _flagOptInRequired = false;
      _flagsVisible = m.enabled;
      // Adopt category / boilerplate prefs when provided (older senders omit them).
      if (m.types) _flagTypes = { ..._flagTypes, ...m.types };
      if (typeof m.boilerplate === 'boolean') _showBoilerplate = m.boilerplate;
      if (_flagOverlay && _positionMap) {
        // Re-activate (rather than no-op when already visible) so category and
        // boilerplate changes repaint the layers immediately.
        if (m.enabled) _flagOverlay.activate(visibleFlags(), _positionMap);
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
  // Second delivery — always an explicit user action: the "Analyze this page"
  // button, or a toolbar re-click. Re-run ingestion via the first injection's
  // closure so a page that was mis-parsed or still loading on the first pass gets
  // a fresh analysis and re-broadcast, instead of being a silent no-op. Running
  // in the original scope keeps the live message listeners and highlight state
  // consistent.
  if (RELIC_GLOBAL.__relicReingest) {
    RELIC_GLOBAL.__relicReingest();
  } else {
    // Hook unset — e.g. the first pass never reached ingestion, or a content
    // script from a previous extension version is still resident in this tab
    // (content scripts don't hot-update until the page reloads). Fall back to
    // ingesting in this scope so the panel still gets a fresh FILING_READY
    // broadcast and "Analyze this page" is never a silent no-op.
    run().catch((err) => console.error('[Relic] re-ingestion failed', err));
  }
} else if (shouldIngestThisFrame()) {
  // Expose the re-ingest closure (bound to this scope) for a later re-analyze.
  RELIC_GLOBAL.__relicReingest = () => {
    run().catch((err) => console.error('[Relic] re-ingestion failed', err));
  };
  run().then((api) => {
    (globalThis as unknown as { __Relic?: RelicDevApi }).__Relic = api;
    console.debug('[Relic] dev API ready: __Relic.demo() / .highlight(text)');
  }).catch((err) => {
    console.error('[Relic] ingestion failed', err);
  });
}
