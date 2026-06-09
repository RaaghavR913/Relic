// ============================================================
// FilingLens service worker (MV3) — Session 2
// ------------------------------------------------------------
// Responsibilities:
//   - Side-panel setup.
//   - ensureOffscreen(): singleton guard using chrome.runtime.getContexts so that
//     5 concurrent calls before creation yield exactly ONE offscreen document.
//   - Message router: BUILD_INDEX / RETRIEVE → offscreen; HIGHLIGHT_RANGE / CLEAR_HIGHLIGHTS
//     → active-tab content script; OFFSCREEN_IDLE → close offscreen doc.
//   - Cross-origin EDGAR fetches with rate limiting (Session 3+).
//
// Privacy invariant: no filing text and no derived analysis ever leaves the device.
// ============================================================

import type {
  BuildIndexMsg,
  RetrieveMsg,
  HighlightRangeMsg,
  ClearHighlightsMsg,
  SummarizeSectionMsg,
  AnalyzeSentimentMsg,
  ComputeRedlineMsg,
  OffscreenBuildIndexMsg,
  OffscreenRetrieveMsg,
  OffscreenExtractiveMsg,
  OffscreenSentimentMsg,
  OffscreenRedlineMsg,
  IndexResponse,
  RetrieveResponse,
  ExtractiveResponse,
  SentimentResponse,
  RedlineResponse,
  RedlineProgressMsg,
  RedlineStage,
  RedlinePriorInfo,
} from '@/messages/types';
import { RateLimitedQueue, fetchEdgarText } from './edgarQueue';
import { resolvePriorFiling } from './resolvePrior';

// ── side panel setup ──────────────────────────────────────────────────────────

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

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

  _offscreenCreating = chrome.offscreen
    .createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        'Runs encoder Web Workers (ONNX Runtime) for on-device embeddings — no network calls other than one-time model download.',
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

async function forwardToOffscreen<T>(
  msg:
    | OffscreenBuildIndexMsg
    | OffscreenRetrieveMsg
    | OffscreenExtractiveMsg
    | OffscreenSentimentMsg
    | OffscreenRedlineMsg,
): Promise<T> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

// ── EDGAR redline orchestration (Session 6) ───────────────────────────────────

/** Shared rate-limit queue for all EDGAR requests (≤8 req/s, SW lifetime). */
const edgarQueue = new RateLimitedQueue({ maxPerSecond: 8 });

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

  const fetchText = (url: string) => fetchEdgarText(url, { queue: edgarQueue });

  // 1. Resolve the prior comparable filing.
  sendRedlineProgress('resolving', 0.05, 'Finding last year’s filing…');
  let prior;
  try {
    prior = await resolvePriorFiling(cik, doc.filingType, doc.periodOfReport, { fetchText });
  } catch (err) {
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
    priorHtml = await fetchEdgarText(prior.url, { queue: edgarQueue });
  } catch (err) {
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

// ── message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    rawMsg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    const msg = rawMsg as { target?: string; type?: string };
    if (msg.target !== 'sw') return false;

    // ── BUILD_INDEX ──
    if (msg.type === 'BUILD_INDEX') {
      const m = msg as BuildIndexMsg;
      forwardToOffscreen<IndexResponse>({
        target: 'offscreen',
        type: 'BUILD_INDEX',
        doc: m.doc,
      })
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // ── RETRIEVE ──
    if (msg.type === 'RETRIEVE') {
      const m = msg as RetrieveMsg;
      forwardToOffscreen<RetrieveResponse>({
        target: 'offscreen',
        type: 'RETRIEVE',
        rawTextHash: m.rawTextHash,
        query: m.query,
        k: m.k,
      })
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

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

    // ── COMPUTE_REDLINE — resolve prior filing + diff (Session 6) ──
    if (msg.type === 'COMPUTE_REDLINE') {
      const m = msg as ComputeRedlineMsg;
      handleComputeRedline(m)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // ── OFFSCREEN_IDLE — close the offscreen document ──
    if (msg.type === 'OFFSCREEN_IDLE') {
      chrome.offscreen.closeDocument().catch(() => {});
      return false;
    }

    return false;
  },
);
