// ============================================================
// Relic service worker (MV3) — Session 2
// ------------------------------------------------------------
// Responsibilities:
//   - Side-panel setup.
//   - ensureOffscreen(): singleton guard using chrome.runtime.getContexts so that
//     5 concurrent calls before creation yield exactly ONE offscreen document.
//   - Message router: SUMMARIZE_SECTION / ANALYZE_SENTIMENT / COMPUTE_REDLINE → offscreen;
//     HIGHLIGHT_RANGE / CLEAR_HIGHLIGHTS → active-tab content script;
//     OFFSCREEN_IDLE → close offscreen doc.
//   - Cross-origin EDGAR fetches with rate limiting (Session 3+).
//
// Privacy invariant: no filing text and no derived analysis ever leaves the device.
// ============================================================

import type {
  HighlightRangeMsg,
  ClearHighlightsMsg,
  SummarizeSectionMsg,
  AnalyzeSentimentMsg,
  ComputeRedlineMsg,
  CancelRedlineMsg,
  OffscreenExtractiveMsg,
  OffscreenSentimentMsg,
  OffscreenRedlineMsg,
  OffscreenEmbedMsg,
  ExtractiveResponse,
  SentimentResponse,
  EmbedTextsMsg,
  EmbedTextsResponse,
  RedlineResponse,
  RedlineProgressMsg,
  RedlineStage,
  RedlinePriorInfo,
  AnalyzePageResponse,
  EnsureSessionStorageMsg,
  PersistFilingMsg,
  FilingReadyMsg,
  FlagResultsMsg,
  ParsePdfMsg,
  OffscreenParsePdfMsg,
  ParsePdfResponse,
  InferenceDeviceMsg,
} from '@/messages/types';
import {
  getPreferWasm,
  setPreferWasm,
  offscreenUrlWithPref,
} from '@/offscreen/inferencePref';
import { RateLimitedQueue, fetchEdgarText } from './edgarQueue';
import { resolvePriorFiling } from './resolvePrior';
import { classifyInjectability } from './inject';
import { debugLog } from '@/lib/debug';
import { getSiteProfile } from '@/content/ingest/siteProfiles';
import { persistFilingToSession } from '@/shared/filingSession';

/** Built content-script bundle — the path inside the packed extension. */
const CONTENT_SCRIPT_FILE = 'src/content/index.js';

// ── side panel setup ──────────────────────────────────────────────────────────

// We open the side panel from action.onClicked rather than via
// openPanelOnActionClick, because the toolbar-icon click is the user gesture
// that grants the extension `activeTab` on the current page — and the side
// panel itself never grants activeTab (crbug.com/40916430). With
// openPanelOnActionClick:true the click is consumed by the panel and onClicked
// never fires, so on-demand injection would have no permission.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  // Open the panel synchronously within the click gesture.
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  } else if (tab.id !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
  }

  // This click just granted activeTab on `tab`. EDGAR (and other auto-host)
  // pages already run the content script via the manifest, so we only inject on
  // generic pages. Injecting here — in the same gesture that granted the
  // permission — is the reliable path; the panel button is a secondary trigger
  // that depends on the grant still being live. The content script's
  // re-injection guard keeps a redundant inject harmless.
  const injectability = classifyInjectability(tab.url);
  debugLog(`[Relic] action click — ${injectability} — ${tab.url ?? '(url hidden)'}`);
  if (tab.id !== undefined && injectability === 'injectable') {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT_FILE] })
      .catch((err) => console.warn('[Relic] auto-inject on action click failed', err));
  }
});

// Let the content script write filing models/flags to chrome.storage.session
// (MV3 default restricts session storage to trusted contexts only).
async function ensureSessionStorageAccess(): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
}

ensureSessionStorageAccess().catch(console.error);

// ── ensureOffscreen ───────────────────────────────────────────────────────────

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

/** Singleton creation promise prevents races (test: 5 concurrent calls → 1 doc). */
let _offscreenCreating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // Fast path: a creation is already in flight.
  if (_offscreenCreating) return _offscreenCreating;

  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;

  // After the await, another concurrent call may have already set the promise.
  if (_offscreenCreating) return _offscreenCreating;

  // Hand the session's inference preference to the document at creation: the
  // offscreen context has no chrome.storage, so a URL param is how a recycled
  // document learns to skip a WebGPU path already known to be bad this session.
  const preferWasm = await getPreferWasm();

  // Re-check after the await — a concurrent call may have won the race.
  if (_offscreenCreating) return _offscreenCreating;

  _offscreenCreating = chrome.offscreen
    .createDocument({
      url: offscreenUrlWithPref(chrome.runtime.getURL(OFFSCREEN_URL), preferWasm),
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        'Runs encoder Web Workers (ONNX Runtime) for on-device embeddings using bundled model weights — no runtime network fetches.',
    })
    .finally(() => {
      _offscreenCreating = null;
    });

  return _offscreenCreating;
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

/**
 * Whether the user has granted "Allow access to file URLs" for Relic. Required
 * before Chrome will let us inject the content script into a file:// tab. The
 * API is callback-only, so wrap it; treat any error as "not allowed" (fail safe
 * toward showing the how-to-enable guidance).
 */
function isAllowedFileSchemeAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed === true));
    } catch {
      resolve(false);
    }
  });
}

async function forwardToOffscreen<T>(
  msg:
    | OffscreenExtractiveMsg
    | OffscreenSentimentMsg
    | OffscreenRedlineMsg
    | OffscreenEmbedMsg
    | OffscreenParsePdfMsg,
): Promise<T> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

// ── EDGAR redline orchestration (Session 6) ───────────────────────────────────

/** Shared rate-limit queue for all EDGAR requests (≤8 req/s, SW lifetime). */
const edgarQueue = new RateLimitedQueue({ maxPerSecond: 8 });

/**
 * AbortController for the single in-flight redline. Starting a new redline aborts
 * the previous one; a CANCEL_REDLINE from the side panel aborts the current one.
 * Aborting after completion is harmless (the fetches have already settled).
 */
let redlineAbort: AbortController | null = null;

function sendRedlineProgress(stage: RedlineStage, progress: number, detail?: string): void {
  const msg: RedlineProgressMsg = {
    target: 'sidepanel',
    type: 'REDLINE_PROGRESS',
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...(detail ? { detail } : {}),
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/**
 * Resolve the prior comparable filing via EDGAR, fetch its HTML through the
 * rate-limit queue, then hand off to the offscreen doc for parse + align + diff.
 * Returns a 'no_prior' response (not an error) when no earlier filing exists.
 */
async function handleComputeRedline(m: ComputeRedlineMsg): Promise<RedlineResponse> {
  const { doc } = m;
  const cik = doc.source.cik;
  if (!cik) {
    return { ok: false, error: 'No CIK on this filing — cannot resolve a prior filing.' };
  }

  // One redline at a time: abort any previous run's in-flight EDGAR fetches
  // before starting this one. `signal` is captured locally so this run always
  // checks its own controller even after a later run reassigns redlineAbort.
  redlineAbort?.abort();
  redlineAbort = new AbortController();
  const { signal } = redlineAbort;

  const fetchText = (url: string) => fetchEdgarText(url, { queue: edgarQueue, signal });

  // 1. Resolve the prior comparable filing.
  sendRedlineProgress('resolving', 0.05, 'Finding last year’s filing…');
  let prior;
  try {
    prior = await resolvePriorFiling(cik, doc.filingType, doc.periodOfReport, { fetchText });
  } catch (err) {
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    return { ok: false, error: `EDGAR resolve failed: ${String(err)}` };
  }

  if (!prior) {
    sendRedlineProgress('no_prior', 1, 'No prior comparable filing found.');
    return { ok: true, status: 'no_prior', diffs: [], stats: {}, alignment: [] };
  }

  // 2. Fetch the prior filing's primary document.
  sendRedlineProgress('fetching', 0.15, `Downloading ${prior.form} (${prior.reportDate})…`);
  let priorHtml: string;
  try {
    priorHtml = await fetchEdgarText(prior.url, { queue: edgarQueue, signal });
  } catch (err) {
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    return { ok: false, error: `EDGAR fetch failed: ${String(err)}` };
  }

  // 3. Hand off to offscreen for parse + align + diff.
  const priorInfo: RedlinePriorInfo = {
    form: prior.form,
    reportDate: prior.reportDate,
    filingDate: prior.filingDate,
    url: prior.url,
    accessionNo: prior.accessionNo,
    ...(prior.companyName ? { companyName: prior.companyName } : {}),
  };

  const fwd: OffscreenRedlineMsg = {
    target: 'offscreen',
    type: 'COMPUTE_REDLINE',
    doc,
    priorHtml,
    priorUrl: prior.url,
    priorInfo,
  };
  return forwardToOffscreen<RedlineResponse>(fwd);
}

// ── on-demand content-script injection ("Analyze this page") ─────────────────

/**
 * Inject the content script into the active tab. Authorized by the activeTab
 * grant from the user's toolbar click; no broad host permissions involved.
 * The content script's own re-injection guard makes a duplicate call harmless.
 * This is the panel-button path; it works only while the grant from the last
 * icon click is still live (same tab, no navigation since). The primary path is
 * the action.onClicked handler above, which injects inside the grant gesture.
 */
async function handleAnalyzePage(): Promise<AnalyzePageResponse> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined) {
    return { ok: false, reason: 'no_tab' };
  }

  // Without the "tabs" permission, tab.url is only populated when activeTab
  // has been granted for this tab OR the extension has host permissions for it.
  if (!tab.url) {
    return { ok: false, reason: 'no_permission' };
  }

  // Group C: optional_host_permissions are required for panel-driven injection
  // (i.e. when activeTab is not in effect from a fresh toolbar click). If the
  // permission hasn't been granted, ask the side panel to request it — do not
  // attempt executeScript, which would fail with a "missing host permission" error.
  const profile = getSiteProfile(tab.url);
  if (profile?.group === 'C' && profile.optionalHostPattern) {
    const has = await chrome.permissions.contains({ origins: [profile.optionalHostPattern] });
    if (!has) {
      return {
        ok: false,
        reason: 'needs_optional_permission',
        hosts: [profile.optionalHostPattern],
        label: profile.label,
      };
    }
  }

  const injectability = classifyInjectability(tab.url);
  if (injectability === 'unsupported') {
    return { ok: false, reason: 'unsupported_url' };
  }

  // Local file:// pages (typically PDFs opened from disk) can only be scripted
  // when the user has enabled "Allow access to file URLs" for the extension.
  // Detect the missing grant up front and guide the user, rather than letting
  // executeScript fail with an opaque "cannot access" error.
  if (tab.url.startsWith('file:') && !(await isAllowedFileSchemeAccess())) {
    return { ok: false, reason: 'needs_file_access' };
  }

  // On auto hosts the manifest script already ran; injecting again is harmless
  // (the content script's guard re-broadcasts FILING_READY instead of
  // re-ingesting), and it resyncs a side panel that missed the original event.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [CONTENT_SCRIPT_FILE],
    });
    return { ok: true, status: injectability === 'auto_host' ? 'already_active' : 'injected' };
  } catch (err) {
    const message = String(err);
    if (/cannot access|cannot be scripted|missing host permission/i.test(message)) {
      return { ok: false, reason: 'no_permission', error: message };
    }
    return { ok: false, reason: 'error', error: message };
  }
}

// ── message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    rawMsg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    const msg = rawMsg as { target?: string; type?: string };
    if (msg.target !== 'sw') return false;

    // ── HIGHLIGHT_RANGE — forward to active tab content script ──
    if (msg.type === 'HIGHLIGHT_RANGE') {
      const m = msg as HighlightRangeMsg;
      getActiveTabId()
        .then(async (tabId) => {
          if (tabId === undefined) return;
          await chrome.tabs.sendMessage(tabId, {
            target: 'content',
            type: 'HIGHLIGHT_RANGE',
            charRange: m.charRange,
          });
        })
        .catch(console.error);
      return false; // fire-and-forget
    }

    // ── CLEAR_HIGHLIGHTS ──
    if (msg.type === 'CLEAR_HIGHLIGHTS') {
      const _m = msg as ClearHighlightsMsg;
      getActiveTabId()
        .then(async (tabId) => {
          if (tabId === undefined) return;
          await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'CLEAR_HIGHLIGHTS' });
        })
        .catch(console.error);
      return false;
    }

    // ── SUMMARIZE_SECTION — extractive path: forward to offscreen ──
    if (msg.type === 'SUMMARIZE_SECTION') {
      const m = msg as SummarizeSectionMsg;
      const fwd: OffscreenExtractiveMsg = {
        target: 'offscreen',
        type: 'EXTRACTIVE_SUMMARIZE',
        rawTextHash: m.rawTextHash,
        sectionId: m.sectionId,
        sectionText: m.sectionText,
        ...(m.charStart !== undefined ? { charStart: m.charStart } : {}),
        ...(m.tables !== undefined ? { tables: m.tables } : {}),
      };
      forwardToOffscreen<ExtractiveResponse>(fwd)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // ── ANALYZE_SENTIMENT — forward to offscreen (FinBERT) ──
    if (msg.type === 'ANALYZE_SENTIMENT') {
      const m = msg as AnalyzeSentimentMsg;
      const fwd: OffscreenSentimentMsg = {
        target: 'offscreen',
        type: 'ANALYZE_SENTIMENT',
        rawTextHash: m.rawTextHash,
        sections: m.sections,
      };
      forwardToOffscreen<SentimentResponse>(fwd)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // ── EMBED_TEXTS — forward to offscreen (semantic excerpt reranking, Session E2) ──
    if (msg.type === 'EMBED_TEXTS') {
      const m = msg as EmbedTextsMsg;
      const fwd: OffscreenEmbedMsg = { target: 'offscreen', type: 'EMBED_TEXTS', texts: m.texts };
      forwardToOffscreen<EmbedTextsResponse>(fwd)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // ── PARSE_PDF — forward PDF bytes to offscreen for PDF.js text extraction ──
    if (msg.type === 'PARSE_PDF') {
      const m = msg as ParsePdfMsg;
      const fwd: OffscreenParsePdfMsg = {
        target: 'offscreen',
        type: 'PARSE_PDF',
        bytesB64: m.bytesB64,
        url: m.url,
      };
      forwardToOffscreen<ParsePdfResponse>(fwd)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // ── COMPUTE_REDLINE — resolve prior filing + diff (Session 6) ──
    if (msg.type === 'COMPUTE_REDLINE') {
      const m = msg as ComputeRedlineMsg;
      handleComputeRedline(m)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // ── CANCEL_REDLINE — abort the in-flight redline's EDGAR fetches ──
    if (msg.type === 'CANCEL_REDLINE') {
      const _m = msg as CancelRedlineMsg;
      redlineAbort?.abort();
      return false; // fire-and-forget
    }

    // ── ANALYZE_PAGE — inject content script into the active tab on demand ──
    if (msg.type === 'ANALYZE_PAGE') {
      handleAnalyzePage()
        .then(sendResponse)
        .catch((err: unknown) =>
          sendResponse({ ok: false, reason: 'error', error: String(err) } satisfies AnalyzePageResponse),
        );
      return true;
    }

    if (msg.type === 'ENSURE_SESSION_STORAGE') {
      ensureSessionStorageAccess()
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (msg.type === 'PERSIST_FILING') {
      const m = msg as PersistFilingMsg;
      ensureSessionStorageAccess()
        .then(() => persistFilingToSession(m.model, m.flags))
        .then(() => sendResponse({ ok: true }))
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // Content script → side panel push: mirror into session storage from a trusted context.
    if (msg.type === 'FILING_READY') {
      const m = msg as FilingReadyMsg;
      persistFilingToSession(m.model).catch(console.warn);
      return false;
    }
    if (msg.type === 'FLAG_RESULTS') {
      const m = msg as FlagResultsMsg;
      chrome.storage.session
        .get('filing:current')
        .then((data) => {
          const current = data['filing:current'] as { hash: string } | undefined;
          if (!current?.hash) return;
          return chrome.storage.session.set({ [`filing:flags:${current.hash}`]: m.flags });
        })
        .catch(console.warn);
      return false;
    }

    // ── OFFSCREEN_IDLE — close the offscreen document ──
    if (msg.type === 'OFFSCREEN_IDLE') {
      chrome.offscreen.closeDocument().catch(() => {});
      return false;
    }

    // ── INFERENCE_DEVICE — offscreen reports the backend it settled on ──
    // The offscreen document cannot persist this itself (no chrome.storage), so
    // it reports and we remember: a WASM outcome sticks for the browser session
    // and is handed to the next offscreen document via its creation URL.
    if (msg.type === 'INFERENCE_DEVICE') {
      const m = msg as InferenceDeviceMsg;
      if (m.device === 'wasm') {
        debugLog(`[Relic] inference device → wasm${m.reason ? ` (${m.reason})` : ''}; persisting for session`);
        void setPreferWasm(true);
      }
      return false;
    }

    return false;
  },
);
