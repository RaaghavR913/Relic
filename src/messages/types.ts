// ============================================================
// FilingLens — typed message bus (Session 2)
// ------------------------------------------------------------
// Every chrome.runtime.sendMessage / chrome.tabs.sendMessage call uses one of these
// types. The `target` field routes messages; each context ignores messages whose target
// does not match its own role. sendResponse shapes are also typed here.
//
// Privacy invariant: no filing text leaves the device. Retrieve results only carry
// text snippets already on the page; they never leave to a remote server.
// ============================================================

import type { DocumentModel, Section, SentenceSentiment, LanguageFlag, SectionDiff } from '@/types';
import type { DiffStats } from '@/redline/diff';

export type MessageTarget = 'sw' | 'offscreen' | 'sidepanel' | 'content';

// ── Side Panel → Service Worker ───────────────────────────────────────────────

export interface BuildIndexMsg {
  target: 'sw';
  type: 'BUILD_INDEX';
  doc: DocumentModel;
}

export interface RetrieveMsg {
  target: 'sw';
  type: 'RETRIEVE';
  rawTextHash: string;
  query: string;
  k: number;
}

export interface HighlightRangeMsg {
  target: 'sw';
  type: 'HIGHLIGHT_RANGE';
  charRange: [number, number];
}

export interface ClearHighlightsMsg {
  target: 'sw';
  type: 'CLEAR_HIGHLIGHTS';
}

// ── Service Worker → Offscreen ────────────────────────────────────────────────

export interface OffscreenBuildIndexMsg {
  target: 'offscreen';
  type: 'BUILD_INDEX';
  doc: DocumentModel;
}

export interface OffscreenRetrieveMsg {
  target: 'offscreen';
  type: 'RETRIEVE';
  rawTextHash: string;
  query: string;
  k: number;
}

// ── Offscreen → Service Worker (events) ──────────────────────────────────────

export interface OffscreenIdleMsg {
  target: 'sw';
  type: 'OFFSCREEN_IDLE';
}

// ── Offscreen / SW → Side Panel (push events) ────────────────────────────────

export type EmbedStage =
  | 'model_load'
  | 'embedding'
  | 'storing'
  | 'complete'
  | 'error';

export interface EmbedProgressMsg {
  target: 'sidepanel';
  type: 'EMBED_PROGRESS';
  stage: EmbedStage;
  /** 0..1 */
  progress: number;
  detail?: string;
}

export interface FilingReadyMsg {
  target: 'sidepanel';
  type: 'FILING_READY';
  url: string;
  model: DocumentModel;
}

// ── Service Worker → Content Script ──────────────────────────────────────────

export interface ContentHighlightMsg {
  target: 'content';
  type: 'HIGHLIGHT_RANGE';
  charRange: [number, number];
}

export interface ContentClearMsg {
  target: 'content';
  type: 'CLEAR_HIGHLIGHTS';
}

// ── Response shapes (sendResponse / Promise resolution) ───────────────────────

export interface IndexOkResponse {
  ok: true;
  rawTextHash: string;
  chunkCount: number;
  /** True when the document was already in the manifest store — embedding was skipped. */
  skipped: boolean;
}
export interface IndexErrResponse { ok: false; error: string }
export type IndexResponse = IndexOkResponse | IndexErrResponse;

export interface RetrievalResult {
  chunkId: string;
  sectionId: string;
  /** DOCUMENT-space char range (into positionMap.text). */
  charRange: [number, number];
  text: string;
  score: number;
}

export interface RetrieveOkResponse {
  ok: true;
  results: RetrievalResult[];
}
export interface RetrieveErrResponse { ok: false; error: string }
export type RetrieveResponse = RetrieveOkResponse | RetrieveErrResponse;

// ── Summarization (Session 3) ─────────────────────────────────────────────────

/**
 * Side panel → SW: request extractive sentence ranking for one section.
 * Only used when effectiveTier is 'extractive'; builtin path runs in the
 * side panel directly via Chrome AI APIs.
 */
export interface SummarizeSectionMsg {
  target: 'sw';
  type: 'SUMMARIZE_SECTION';
  rawTextHash: string;
  sectionId: string;
  /** section.text — stays on-device; routed SW → offscreen → encoder worker */
  sectionText: string;
}

/** SW → Offscreen: run embedding-centrality ranking on section sentences. */
export interface OffscreenExtractiveMsg {
  target: 'offscreen';
  type: 'EXTRACTIVE_SUMMARIZE';
  rawTextHash: string;
  sectionId: string;
  sectionText: string;
}

/** One selected sentence from extractive ranking. Range is SECTION-space. */
export interface ExtractedSentence {
  text: string;
  /** [start, end) offsets within sectionText (section-space). */
  range: [number, number];
  score: number;
}

export interface ExtractiveOkResponse {
  ok: true;
  /** Top sentences sorted by original position (not score). */
  sentences: ExtractedSentence[];
}
export interface ExtractiveErrResponse { ok: false; error: string }
export type ExtractiveResponse = ExtractiveOkResponse | ExtractiveErrResponse;

// ── Session 5: Flagging (Content Script → Side Panel / Side Panel → Content) ──

/**
 * Broadcast from content script → side panel after flagAllSections() completes.
 * Contains the full LanguageFlag[] for the current document.
 * Privacy: flag ranges are document-space offsets + lexicon-matched terms only;
 * no original filing prose is included beyond the matched term itself.
 */
export interface FlagResultsMsg {
  target: 'sidepanel';
  type: 'FLAG_RESULTS';
  /** All flags for the document, in document order. */
  flags: LanguageFlag[];
}

/**
 * Sent from the side panel → content script when the user clicks a flag
 * in the FlagPanel to jump to its location in the filing.
 * The content script scrolls the first flagged range into view and briefly
 * applies the 'qa' highlight so the user can locate it.
 */
export interface ContentScrollToFlagMsg {
  target: 'content';
  type: 'SCROLL_TO_FLAG';
  /** Document-space [start, end) of the target flag. */
  range: [number, number];
}

// ── Session 6: Year-over-year redline ─────────────────────────────────────────
//
// Flow:
//   Side panel → SW   COMPUTE_REDLINE   (current DocumentModel)
//   SW: resolvePriorFiling() via the EDGAR rate-limit queue, fetch the prior HTML.
//   SW → Offscreen    COMPUTE_REDLINE   (current doc + prior HTML + prior info)
//   Offscreen: parse prior → alignSections → diffSection (textual + embedding semantic)
//   Offscreen → SW    RedlineResponse   (SectionDiff[] with TEMPLATED summaries)
//   SW → Side panel   RedlineResponse
//   Side panel: if tier==='builtin', upgrade each summary via the Prompt API.
//
// Progress for every stage streams straight to the side panel (target:'sidepanel').
// Privacy: prior filing HTML is fetched from EDGAR (public) and parsed on-device;
// no filing text or diff ever leaves the device.

/** Side panel → SW: compute a YoY redline for the currently-open filing. */
export interface ComputeRedlineMsg {
  target: 'sw';
  type: 'COMPUTE_REDLINE';
  doc: DocumentModel;
}

/** Metadata for the resolved prior comparable filing (from EDGAR submissions JSON). */
export interface RedlinePriorInfo {
  companyName?: string;
  form: string;
  /** periodOfReport / reportDate, ISO date. */
  reportDate: string;
  filingDate: string;
  url: string;
  accessionNo: string;
}

/** SW → Offscreen: parse + align + diff the prior filing against the current one. */
export interface OffscreenRedlineMsg {
  target: 'offscreen';
  type: 'COMPUTE_REDLINE';
  doc: DocumentModel;
  /** Raw HTML of the prior filing's primary document (already fetched by the SW). */
  priorHtml: string;
  priorUrl: string;
  priorInfo: RedlinePriorInfo;
}

/** One row in the section-alignment summary (shown in the UI even when not diffed). */
export interface AlignmentSummary {
  id: string;
  label: string;
  status: 'matched' | 'added' | 'removed';
}

export type RedlineStage =
  | 'resolving'
  | 'fetching'
  | 'parsing'
  | 'aligning'
  | 'diffing'
  | 'complete'
  | 'no_prior'
  | 'error';

/** SW / Offscreen → Side panel: redline progress. */
export interface RedlineProgressMsg {
  target: 'sidepanel';
  type: 'REDLINE_PROGRESS';
  stage: RedlineStage;
  /** 0..1 */
  progress: number;
  detail?: string;
}

export interface RedlineOkResponse {
  ok: true;
  /**
   * 'computed'         — a prior filing was found and the focus sections diffed.
   * 'no_prior'         — no earlier comparable filing exists on EDGAR.
   * 'unsupported_form' — a prior exists but this filing type has no Changes-tab
   *                      focus coverage, so no diff was produced (M1 guard).
   */
  status: 'computed' | 'no_prior' | 'unsupported_form';
  /** Per-section diffs. added/removed ranges are SECTION-space (added→current, removed→prior). */
  diffs: SectionDiff[];
  /** Diff stats keyed by sectionId — drives the builtin-tier summary upgrade. */
  stats: Record<string, DiffStats>;
  prior?: RedlinePriorInfo;
  alignment: AlignmentSummary[];
}
export interface RedlineErrResponse { ok: false; error: string }
export type RedlineResponse = RedlineOkResponse | RedlineErrResponse;

/**
 * Side panel → Content: paint the on-page redline overlay for ADDED passages.
 * Ranges are DOCUMENT-space (lifted from section-space by the side panel).
 * Removed passages are not on the current page, so only additions are highlighted.
 */
export interface ContentShowRedlineMsg {
  target: 'content';
  type: 'SHOW_REDLINE';
  ranges: Array<[number, number]>;
}

/** Side panel → Content: clear the redline overlay. */
export interface ContentClearRedlineMsg {
  target: 'content';
  type: 'CLEAR_REDLINE';
}

// ── Encoder Worker (no chrome.*) ─────────────────────────────────────────────

export interface WorkerInitMsg {
  type: 'INIT';
  wasmPaths: string;
  /** Base URL for bundled model weights (chrome.runtime.getURL('models/')). */
  modelBasePath: string;
  modelId: string;
  numThreads: number;
}

export interface WorkerEmbedMsg {
  type: 'EMBED';
  id: string;
  texts: string[];
}

export type WorkerInbound = WorkerInitMsg | WorkerEmbedMsg;

export interface WorkerReadyMsg {
  type: 'READY';
  device: 'webgpu' | 'wasm';
}

export interface WorkerProgressMsg {
  type: 'PROGRESS';
  /** 0..1 */
  progress: number;
  file?: string;
}

export interface WorkerEmbedResultMsg {
  type: 'EMBED_RESULT';
  id: string;
  /** Transferable Float32Array buffers, one per input text. */
  buffers: ArrayBuffer[];
  dim: number;
}

export interface WorkerErrorMsg {
  type: 'ERROR';
  id?: string;
  message: string;
}

export type WorkerOutbound =
  | WorkerReadyMsg
  | WorkerProgressMsg
  | WorkerEmbedResultMsg
  | WorkerErrorMsg;

// ── Sentiment Analysis (Session 4) ────────────────────────────────────────────

/** Side panel → SW: kick off FinBERT sentiment analysis for this filing. */
export interface AnalyzeSentimentMsg {
  target: 'sw';
  type: 'ANALYZE_SENTIMENT';
  rawTextHash: string;
  sections: Section[];
}

/** SW → Offscreen: run FinBERT classification for all sections. */
export interface OffscreenSentimentMsg {
  target: 'offscreen';
  type: 'ANALYZE_SENTIMENT';
  rawTextHash: string;
  sections: Section[];
}

/**
 * Offscreen → Side panel (push event, emitted per section as it finishes).
 * Lets the side panel apply inline highlights progressively without waiting
 * for the full document pass to complete.
 */
export interface SentimentSectionDoneMsg {
  target: 'sidepanel';
  type: 'SENTIMENT_SECTION_DONE';
  sectionId: string;
  sectionIdx: number;
  totalSections: number;
  /** DOCUMENT-space SentenceSentiment[] for this section only. */
  results: SentenceSentiment[];
  /** Wall-clock time in ms to classify this section (instrumentation). */
  elapsedMs: number;
}

/** Offscreen → Side panel: model-load / overall progress. */
export interface SentimentProgressMsg {
  target: 'sidepanel';
  type: 'SENTIMENT_PROGRESS';
  stage: 'model_load' | 'classifying' | 'complete' | 'error';
  /** 0..1 */
  progress: number;
  detail?: string;
}

export interface SentimentOkResponse {
  ok: true;
  rawTextHash: string;
  totalSentences: number;
  /** Wall-clock ms for the full pass (instrumentation). */
  elapsedMs: number;
  /** True when results were served from the IDB cache. */
  fromCache: boolean;
}
export interface SentimentErrResponse { ok: false; error: string }
export type SentimentResponse = SentimentOkResponse | SentimentErrResponse;

/**
 * Side panel → Content (via tabs.sendMessage): add sentiment highlight ranges
 * to the filing. Called progressively as each section finishes.
 */
export interface ContentSentimentAddMsg {
  target: 'content';
  type: 'SENTIMENT_ADD_RANGES';
  results: SentenceSentiment[];
}

/** Side panel → Content: clear all sentiment highlight layers. */
export interface ContentClearSentimentMsg {
  target: 'content';
  type: 'CLEAR_SENTIMENT';
}

// ── Session 7: master overlay toggles ─────────────────────────────────────────
//
// The content script caches the last-applied sentiment ranges and the document's
// flags, so the side-panel "Overlay controls" surface can show/hide each overlay
// WITHOUT re-running analysis. These are pure visibility switches.

/** Side panel → Content: show/hide the sentiment heatmap from cached ranges. */
export interface ContentSetSentimentOverlayMsg {
  target: 'content';
  type: 'SET_SENTIMENT_OVERLAY';
  enabled: boolean;
}

/** Side panel → Content: show/hide the language-flag overlay (and its tooltip). */
export interface ContentSetFlagOverlayMsg {
  target: 'content';
  type: 'SET_FLAG_OVERLAY';
  enabled: boolean;
}

/**
 * Side panel → Content: scroll a document-space range into view and briefly
 * flash it (reuses the 'qa' highlight). Used by the section navigator's
 * "jump to section" affordance. Identical payload shape to SCROLL_TO_FLAG.
 */
export interface ContentScrollToRangeMsg {
  target: 'content';
  type: 'SCROLL_TO_RANGE';
  range: [number, number];
}

// ── Sentiment Worker (no chrome.*) ────────────────────────────────────────────

export interface SentimentWorkerClassifyMsg {
  type: 'CLASSIFY';
  id: string;
  texts: string[];
}

export type SentimentWorkerInbound = WorkerInitMsg | SentimentWorkerClassifyMsg;

export interface SentimentWorkerClassifyResultMsg {
  type: 'CLASSIFY_RESULT';
  id: string;
  /** Lowercase label ('positive'|'negative'|'neutral') for each input text. */
  labels: string[];
  /** Confidence score 0..1 for each input text. */
  scores: number[];
}

export type SentimentWorkerOutbound =
  | WorkerReadyMsg
  | WorkerProgressMsg
  | SentimentWorkerClassifyResultMsg
  | WorkerErrorMsg;
