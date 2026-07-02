// ============================================================
// Relic — offscreen document main thread (Session 2)
// ------------------------------------------------------------
// Responsibilities:
//   1. Encoder Web Worker lifecycle (lazy init, idle-unload).
//   2. Extractive summarization (sentence-centrality ranking via embeddings).
//   3. FinBERT sentiment classification.
//   4. Redline diff (textual + embedding-backed semantic pass).
//
// The offscreen doc receives messages routed from the SW with target:'offscreen'.
// It sends progress updates directly to side-panel listeners (target:'sidepanel')
// and sends OFFSCREEN_IDLE to the SW when the idle timer fires.
//
// PRIVACY: no text leaves the device. Model weights are BUNDLED in the extension
// (loaded via chrome.runtime.getURL('models/') with allowRemoteModels=false) — they
// are never fetched from Hugging Face at runtime. The only network calls are EDGAR.
// ============================================================

import type {
  OffscreenExtractiveMsg,
  OffscreenSentimentMsg,
  EmbedProgressMsg,
  ExtractiveResponse,
  SentimentResponse,
  SentimentSectionDoneMsg,
  SentimentProgressMsg,
  WorkerOutbound,
  WorkerInitMsg,
  SentimentWorkerOutbound,
  SentimentWorkerClassifyResultMsg,
  OffscreenRedlineMsg,
  RedlineResponse,
  RedlineProgressMsg,
  RedlineStage,
  AlignmentSummary,
} from '@/messages/types';
import type { DocumentModel, Section, SentenceSentiment, SectionDiff } from '@/types';
import { filterNonTableSentences } from './sentenceFilter';
import { calibrateSentimentLabel } from './calibrateSentiment';
import {
  splitSentences,
  rankByCentrality,
  selectTopN,
  targetSentenceCount,
  cosineSim,
} from '@/summarizer/extractive';
import {
  structuralDiff,
  assembleSectionDiff,
  diffSection,
  templatedChangeSummary,
  jaccardSimilarity,
  type Similarity,
  type SectionDiffCore,
} from '@/redline/diff';
import { alignSections, focusAlignments } from '@/redline/align';
import { parsePriorFiling } from '@/redline/parsePrior';
import { getSentimentCache, putSentimentCache } from '@/db/sentimentStore';

// ── constants ─────────────────────────────────────────────────────────────────

const MODEL_ID = 'mixedbread-ai/mxbai-embed-xsmall-v1';
/**
 * FinBERT ONNX export — ProsusAI/finbert via the Xenova ONNX community export.
 * The quantized weights are bundled under models/ and loaded locally
 * (allowRemoteModels=false) — never fetched from the Hub at runtime.
 */
const FINBERT_MODEL_ID = 'Xenova/finbert';
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
/** Max texts per single EMBED call (keeps per-call memory bounded). */
const EMBED_BATCH = 32;
/** Max concurrent EMBED calls in-flight to the encoder worker. */
const EMBED_CONCURRENCY = 2;
/** Max texts per single CLASSIFY call — FinBERT sentences are longer than embed chunks. */
const CLASSIFY_BATCH = 8;
/** Concurrency for CLASSIFY calls — FinBERT classification is sequential per GPU. */
const CLASSIFY_CONCURRENCY = 1;

// ── encoder worker state ──────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerReady: Promise<'webgpu' | 'wasm'> | null = null;
let workerDevice: 'webgpu' | 'wasm' = 'wasm';

/** Pending EMBED request callbacks, keyed by correlation id. */
const pending = new Map<
  string,
  { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }
>();

let pendingInit: { resolve: (d: 'webgpu' | 'wasm') => void; reject: (e: Error) => void } | null =
  null;

// ── sentiment (FinBERT) worker state ──────────────────────────────────────────

let sentimentWorker: Worker | null = null;
let sentimentWorkerReady: Promise<'webgpu' | 'wasm'> | null = null;
let sentimentWorkerDevice: 'webgpu' | 'wasm' = 'wasm';

/** Pending CLASSIFY request callbacks, keyed by correlation id. */
const sentimentPending = new Map<
  string,
  { resolve: (v: { labels: string[]; scores: number[] }) => void; reject: (e: Error) => void }
>();

let sentimentPendingInit: {
  resolve: (d: 'webgpu' | 'wasm') => void;
  reject: (e: Error) => void;
} | null = null;

let _classifyIdCounter = 0;

/**
 * Count of ANALYZE_SENTIMENT requests currently being processed. The sentiment
 * worker is only torn down when this returns to 0, so an overlapping/queued batch
 * is never terminated out from under an in-flight classification.
 */
let sentimentInFlight = 0;

// ── idle-unload ───────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.debug('[offscreen] idle timeout — unloading workers');
    terminateWorkers();
    // Ask the SW to close this offscreen document.
    chrome.runtime.sendMessage({ target: 'sw', type: 'OFFSCREEN_IDLE' }).catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

function terminateWorkers(): void {
  // Encoder worker
  worker?.terminate();
  worker = null;
  workerReady = null;
  for (const p of pending.values()) p.reject(new Error('Worker terminated'));
  pending.clear();
  pendingInit = null;

  terminateSentimentWorker();
}

/**
 * Tear down just the FinBERT sentiment worker, leaving the encoder worker (which
 * serves summaries + the redline semantic pass) untouched. Called eagerly after a
 * sentiment pass finishes so the ~1 GB peak FinBERT holds on WASM devices is freed
 * without waiting for the 5-minute idle unload. ensureSentimentWorker() rebuilds a
 * fresh worker (and re-INITs from the retained constants) on the next request.
 */
function terminateSentimentWorker(): void {
  sentimentWorker?.terminate();
  sentimentWorker = null;
  sentimentWorkerReady = null;
  for (const p of sentimentPending.values()) p.reject(new Error('Worker terminated'));
  sentimentPending.clear();
  sentimentPendingInit = null;
}

// ── worker message handler ────────────────────────────────────────────────────

function handleWorkerMsg(e: MessageEvent): void {
  const msg = e.data as WorkerOutbound;

  if (msg.type === 'READY') {
    workerDevice = msg.device;
    if (msg.diag) console.debug(`[offscreen] encoder ready on ${msg.device} —`, msg.diag.attempts);
    pendingInit?.resolve(msg.device);
    pendingInit = null;
    return;
  }

  if (msg.type === 'PROGRESS') {
    sendProgress('model_load', msg.progress, msg.file);
    return;
  }

  if (msg.type === 'EMBED_RESULT') {
    const cb = pending.get(msg.id);
    if (cb) {
      const vectors = msg.buffers.map((ab) => new Float32Array(ab));
      cb.resolve(vectors);
      pending.delete(msg.id);
    }
    return;
  }

  if (msg.type === 'ERROR') {
    if (msg.id) {
      const cb = pending.get(msg.id);
      if (cb) {
        cb.reject(new Error(msg.message));
        pending.delete(msg.id);
      }
    } else {
      pendingInit?.reject(new Error(msg.message));
      pendingInit = null;
    }
  }
}

// ── worker lifecycle ──────────────────────────────────────────────────────────

function ensureWorker(): Promise<'webgpu' | 'wasm'> {
  if (workerReady) return workerReady;

  workerReady = new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
    pendingInit = { resolve, reject };

    worker = new Worker(
      new URL('../workers/encoder.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = handleWorkerMsg;
    worker.onerror = (ev) => {
      pendingInit?.reject(new Error(ev.message));
      pendingInit = null;
    };

    // Pass wasmPaths + model base path computed here (offscreen has chrome.*) —
    // worker must never use chrome.*. Models are bundled under dist/models/.
    const wasmPaths = chrome.runtime.getURL('wasm/');
    const modelBasePath = chrome.runtime.getURL('models/');
    const initMsg: WorkerInitMsg = {
      type: 'INIT',
      wasmPaths,
      modelBasePath,
      modelId: MODEL_ID,
      numThreads: 1,
    };
    worker.postMessage(initMsg);
  });

  return workerReady;
}

// ── embed helper ──────────────────────────────────────────────────────────────

let _embedIdCounter = 0;

function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    const id = `e${++_embedIdCounter}`;
    pending.set(id, { resolve, reject });
    worker!.postMessage({ type: 'EMBED', id, texts });
  });
}

/**
 * Embed an array of texts in mini-batches of EMBED_BATCH with EMBED_CONCURRENCY
 * parallel calls. Reports embedding progress via sendProgress.
 */
async function embedAll(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = new Array(texts.length);
  let done = 0;

  // Slice into batches.
  const batches: Array<{ start: number; texts: string[] }> = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    batches.push({ start: i, texts: texts.slice(i, i + EMBED_BATCH) });
  }

  // Process with controlled concurrency.
  let batchIdx = 0;

  async function processNext(): Promise<void> {
    while (batchIdx < batches.length) {
      const b = batches[batchIdx++]!;
      const vecs = await embedBatch(b.texts);
      for (let j = 0; j < vecs.length; j++) {
        results[b.start + j] = vecs[j]!;
      }
      done += b.texts.length;
      sendProgress('embedding', done / texts.length);
    }
  }

  const workers = Array.from({ length: EMBED_CONCURRENCY }, processNext);
  await Promise.all(workers);
  return results;
}

// ── sentiment worker message handler ─────────────────────────────────────────

function handleSentimentWorkerMsg(e: MessageEvent): void {
  const msg = e.data as SentimentWorkerOutbound;

  if (msg.type === 'READY') {
    sentimentWorkerDevice = msg.device;
    if (msg.diag) console.debug(`[offscreen] FinBERT ready on ${msg.device} —`, msg.diag.attempts);
    sentimentPendingInit?.resolve(msg.device);
    sentimentPendingInit = null;
    return;
  }

  if (msg.type === 'PROGRESS') {
    sendSentimentProgress('model_load', msg.progress, msg.file);
    return;
  }

  if (msg.type === 'CLASSIFY_RESULT') {
    const m = msg as SentimentWorkerClassifyResultMsg;
    const cb = sentimentPending.get(m.id);
    if (cb) {
      cb.resolve({ labels: m.labels, scores: m.scores });
      sentimentPending.delete(m.id);
    }
    return;
  }

  if (msg.type === 'ERROR') {
    if (msg.id) {
      const cb = sentimentPending.get(msg.id);
      if (cb) {
        cb.reject(new Error(msg.message));
        sentimentPending.delete(msg.id);
      }
    } else {
      sentimentPendingInit?.reject(new Error(msg.message));
      sentimentPendingInit = null;
    }
  }
}

// ── sentiment worker lifecycle ────────────────────────────────────────────────

function ensureSentimentWorker(): Promise<'webgpu' | 'wasm'> {
  if (sentimentWorkerReady) return sentimentWorkerReady;

  sentimentWorkerReady = new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
    sentimentPendingInit = { resolve, reject };

    sentimentWorker = new Worker(
      new URL('../workers/sentiment.worker.ts', import.meta.url),
      { type: 'module' },
    );
    sentimentWorker.onmessage = handleSentimentWorkerMsg;
    sentimentWorker.onerror = (ev) => {
      sentimentPendingInit?.reject(new Error(ev.message));
      sentimentPendingInit = null;
    };

    const wasmPaths = chrome.runtime.getURL('wasm/');
    const modelBasePath = chrome.runtime.getURL('models/');
    sentimentWorker.postMessage({
      type: 'INIT',
      wasmPaths,
      modelBasePath,
      modelId: FINBERT_MODEL_ID,
      numThreads: 1,
    } satisfies WorkerInitMsg);
  });

  return sentimentWorkerReady;
}

// ── classify helper ───────────────────────────────────────────────────────────

function classifyBatch(texts: string[]): Promise<{ labels: string[]; scores: number[] }> {
  return new Promise((resolve, reject) => {
    const id = `c${++_classifyIdCounter}`;
    sentimentPending.set(id, { resolve, reject });
    sentimentWorker!.postMessage({ type: 'CLASSIFY', id, texts });
  });
}

/**
 * Classify an array of texts in mini-batches with CLASSIFY_CONCURRENCY.
 * Reports classification progress via sendSentimentProgress.
 */
async function classifyAll(
  texts: string[],
  onBatchDone?: (progress: number) => void,
): Promise<{ labels: string[]; scores: number[] }> {
  const allLabels: string[] = new Array(texts.length) as string[];
  const allScores: number[] = new Array(texts.length) as number[];
  let done = 0;

  const batches: Array<{ start: number; texts: string[] }> = [];
  for (let i = 0; i < texts.length; i += CLASSIFY_BATCH) {
    batches.push({ start: i, texts: texts.slice(i, i + CLASSIFY_BATCH) });
  }

  let batchIdx = 0;

  async function processNext(): Promise<void> {
    while (batchIdx < batches.length) {
      const b = batches[batchIdx++]!;
      const { labels, scores } = await classifyBatch(b.texts);
      for (let j = 0; j < b.texts.length; j++) {
        allLabels[b.start + j] = labels[j] ?? 'neutral';
        allScores[b.start + j] = scores[j] ?? 0;
      }
      done += b.texts.length;
      onBatchDone?.(done / texts.length);
    }
  }

  const workers = Array.from({ length: CLASSIFY_CONCURRENCY }, processNext);
  await Promise.all(workers);
  return { labels: allLabels, scores: allScores };
}

// ── sentiment progress broadcast ─────────────────────────────────────────────

function sendSentimentProgress(
  stage: SentimentProgressMsg['stage'],
  progress: number,
  detail?: string,
): void {
  const msg: SentimentProgressMsg = {
    target: 'sidepanel',
    type: 'SENTIMENT_PROGRESS',
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...(detail ? { detail } : {}),
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── ANALYZE_SENTIMENT ─────────────────────────────────────────────────────────

/**
 * Run FinBERT sentiment classification for all sections of a filing.
 *
 * Algorithm:
 *   1. Check IDB cache (same rawTextHash + modelId → skip inference).
 *   2. splitSentences() on each section.text; filter out table-overlapping sentences.
 *   3. classifyAll() via the sentiment worker (CLASSIFY_BATCH=8 sentences/call).
 *   4. Lift section-space ranges → DOCUMENT-space (section.charRange[0] + offset).
 *   5. Emit SENTIMENT_SECTION_DONE to side panel (progressive highlighting).
 *   6. Persist full results to IDB.
 *
 * Table exclusion: section.tables contains DOCUMENT-space [start,end) ranges.
 * Each sentence's DOCUMENT-space position is checked against those ranges.
 */
async function analyzeSentiment(
  rawTextHash: string,
  sections: Section[],
): Promise<SentimentResponse> {
  resetIdleTimer();

  const t0 = performance.now();

  // ── 1. IDB cache check ──────────────────────────────────────────────────────
  const cached = await getSentimentCache(rawTextHash, FINBERT_MODEL_ID);
  if (cached) {
    const elapsed = Math.round(performance.now() - t0);
    console.debug(`[offscreen] sentiment cache hit for ${rawTextHash} (${cached.length} results)`);

    // Replay section-done events for progressive highlighting from cache.
    const bySectionId = new Map<string, SentenceSentiment[]>();
    for (const r of cached) {
      const arr = bySectionId.get(r.sectionId);
      if (arr) {
        arr.push(r);
      } else {
        bySectionId.set(r.sectionId, [r]);
      }
    }
    sections.forEach((sec, idx) => {
      const results = bySectionId.get(sec.id) ?? [];
      const doneMsg: SentimentSectionDoneMsg = {
        target: 'sidepanel',
        type: 'SENTIMENT_SECTION_DONE',
        sectionId: sec.id,
        sectionIdx: idx,
        totalSections: sections.length,
        results,
        elapsedMs: 0,
      };
      chrome.runtime.sendMessage(doneMsg).catch(() => {});
    });

    return {
      ok: true,
      rawTextHash,
      totalSentences: cached.length,
      elapsedMs: elapsed,
      fromCache: true,
    };
  }

  // ── 2. Load model ───────────────────────────────────────────────────────────
  sendSentimentProgress('model_load', 0, 'Loading FinBERT…');
  const tModel = performance.now();
  const device = await ensureSentimentWorker();
  console.debug(`[offscreen] FinBERT ready on ${device} in ${(performance.now() - tModel).toFixed(0)} ms`);
  sendSentimentProgress('model_load', 1);

  // ── 3. Classify sections ────────────────────────────────────────────────────
  const allResults: SentenceSentiment[] = [];
  const totalSections = sections.length;

  for (let si = 0; si < totalSections; si++) {
    const section = sections[si]!;
    const tSection = performance.now();

    sendSentimentProgress(
      'classifying',
      si / totalSections,
      `Scoring ${section.label}…`,
    );

    // Split into sentences (section-space ranges).
    const sentences = splitSentences(section.text);

    // Filter sentences that overlap table regions (DOCUMENT-space check), keeping
    // each survivor's index into the ORIGINAL `sentences` array so highlight
    // offsets don't drift on sections that contain tables.
    const nonTableSentences = filterNonTableSentences(
      sentences,
      section.charRange[0],
      section.tables,
    );

    if (nonTableSentences.length === 0) {
      const doneMsg: SentimentSectionDoneMsg = {
        target: 'sidepanel',
        type: 'SENTIMENT_SECTION_DONE',
        sectionId: section.id,
        sectionIdx: si,
        totalSections,
        results: [],
        elapsedMs: 0,
      };
      chrome.runtime.sendMessage(doneMsg).catch(() => {});
      continue;
    }

    const texts = nonTableSentences.map(({ sent }) => sent.text);
    const { labels, scores } = await classifyAll(texts);

    const sectionResults: SentenceSentiment[] = [];
    for (let i = 0; i < nonTableSentences.length; i++) {
      const { sent, origIdx } = nonTableSentences[i]!;
      const label = labels[i] ?? 'neutral';
      const score = scores[i] ?? 0;

      const docRange: [number, number] = [
        section.charRange[0] + sent.range[0],
        section.charRange[0] + sent.range[1],
      ];

      // Confidence-floor calibration: low-score positive/negative → neutral, so
      // boilerplate/legal prose isn't painted with confident sentiment colour.
      const sentimentLabel = calibrateSentimentLabel(label, score);

      sectionResults.push({
        sectionId: section.id,
        sentenceIdx: origIdx,
        label: sentimentLabel,
        score,
        range: docRange,
      });
    }

    allResults.push(...sectionResults);

    const sectionElapsed = Math.round(performance.now() - tSection);
    console.debug(
      `[offscreen] sentiment: ${section.id} — ${nonTableSentences.length} sentences in ${sectionElapsed} ms`,
    );

    const doneMsg: SentimentSectionDoneMsg = {
      target: 'sidepanel',
      type: 'SENTIMENT_SECTION_DONE',
      sectionId: section.id,
      sectionIdx: si,
      totalSections,
      results: sectionResults,
      elapsedMs: sectionElapsed,
    };
    chrome.runtime.sendMessage(doneMsg).catch(() => {});
  }

  // ── 4. Persist to IDB ───────────────────────────────────────────────────────
  await putSentimentCache(rawTextHash, FINBERT_MODEL_ID, allResults);

  const elapsed = Math.round(performance.now() - t0);
  sendSentimentProgress('complete', 1);
  console.debug(
    `[offscreen] sentiment complete: ${allResults.length} sentences in ${elapsed} ms`,
  );

  return {
    ok: true,
    rawTextHash,
    totalSentences: allResults.length,
    elapsedMs: elapsed,
    fromCache: false,
  };
}

// ── progress broadcast ────────────────────────────────────────────────────────

function sendProgress(stage: EmbedProgressMsg['stage'], progress: number, detail?: string): void {
  const msg: EmbedProgressMsg = {
    target: 'sidepanel',
    type: 'EMBED_PROGRESS',
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...(detail ? { detail } : {}),
  };
  chrome.runtime.sendMessage(msg).catch(() => {}); // ignore if side panel is closed
}

// ── EXTRACTIVE_SUMMARIZE ──────────────────────────────────────────────────────

/**
 * Sentence-centrality extractive summarization for one section.
 * The encoder worker init is idempotent and shared with the redline semantic pass.
 */
async function extractiveSummarize(sectionText: string): Promise<ExtractiveResponse> {
  resetIdleTimer();

  const spans = splitSentences(sectionText);

  // Trivial cases — no embeddings needed.
  if (spans.length === 0) {
    const trimmed = sectionText.trim();
    if (!trimmed) return { ok: true, sentences: [] };
    return {
      ok: true,
      sentences: [{ text: trimmed, range: [0, trimmed.length], score: 1 }],
    };
  }
  if (spans.length === 1) {
    return { ok: true, sentences: [{ ...spans[0]!, score: 1 }] };
  }

  sendProgress('model_load', 0, 'Initializing encoder…');
  await ensureWorker();
  sendProgress('model_load', 1);

  sendProgress('embedding', 0, `Embedding ${spans.length} sentences…`);
  const texts = spans.map((s) => s.text);
  const embeddings = await embedAll(texts);
  sendProgress('embedding', 1);

  const ranked = rankByCentrality(spans, embeddings);
  const n = targetSentenceCount(sectionText.length);
  const top = selectTopN(ranked, n);

  return { ok: true, sentences: top };
}

// ── COMPUTE_REDLINE (Session 6) ───────────────────────────────────────────────

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
 * Diff one matched section with the embedding-backed SEMANTIC pass.
 * Textual structural diff first; if there are leftover added AND removed
 * sentences, embed both sides and pair by cosine similarity so cosmetic
 * rewordings drop out and meaning-changing rewordings surface as word-level spans.
 */
async function diffSectionSemantic(currentText: string, priorText: string): Promise<SectionDiffCore> {
  const td = structuralDiff(currentText, priorText);

  // Nothing to pair → the textual diff is already final (Jaccard wording pass only).
  if (td.addedIdx.length === 0 || td.removedIdx.length === 0) {
    return assembleSectionDiff(td);
  }

  await ensureWorker();

  const addedTexts = td.addedIdx.map((i) => td.currentSentences[i]!.text);
  const removedTexts = td.removedIdx.map((i) => td.priorSentences[i]!.text);
  const [addedEmb, removedEmb] = await Promise.all([embedAll(addedTexts), embedAll(removedTexts)]);

  const addedPos = new Map<number, number>();
  td.addedIdx.forEach((sentIdx, pos) => addedPos.set(sentIdx, pos));
  const removedPos = new Map<number, number>();
  td.removedIdx.forEach((sentIdx, pos) => removedPos.set(sentIdx, pos));

  const similarity: Similarity = (_a, _b, aIdx, rIdx) => {
    const ai = addedPos.get(aIdx);
    const ri = removedPos.get(rIdx);
    if (ai === undefined || ri === undefined) return 0;
    return cosineSim(addedEmb[ai]!, removedEmb[ri]!);
  };

  // cosine ≥ 0.97 → cosmetic (drop); 0.82..0.97 → reworded (word-level spans).
  return assembleSectionDiff(td, { similarity, rewordMin: 0.82, cosmeticMin: 0.97 });
}

async function computeRedline(m: OffscreenRedlineMsg): Promise<RedlineResponse> {
  resetIdleTimer();

  // 1. Parse the prior filing into a DocumentModel.
  sendRedlineProgress('parsing', 0.1, 'Parsing prior filing…');
  let priorModel: DocumentModel;
  try {
    priorModel = parsePriorFiling(m.priorHtml, m.priorUrl);
  } catch (e) {
    return { ok: false, error: `Prior filing parse failed: ${String(e)}` };
  }

  // 2. Align sections (all of them, for the alignment summary list). A bounded
  // token-Jaccard fallback re-pairs sections that were renumbered/renamed across
  // years (so they aren't read as added+removed → a misleading "no changes").
  sendRedlineProgress('aligning', 0.3, 'Aligning sections…');
  const SIM_SAMPLE = 4_000; // cap per-section text sampled for similarity
  const alignment = alignSections(m.doc.sections, priorModel.sections, {
    similarity: (c, p) => jaccardSimilarity(c.text.slice(0, SIM_SAMPLE), p.text.slice(0, SIM_SAMPLE)),
  });
  const alignmentSummary: AlignmentSummary[] = alignment.map((a) => ({
    id: a.id,
    label: a.label,
    status: a.status,
  }));

  // 3. Diff the focus sections (matched → semantic; added/removed → whole-section).
  const focusAligns = focusAlignments(alignment);

  // Fail loud, not empty: if this filing type produced ZERO focus-section matches,
  // the Changes tab has no coverage for it. Returning an empty diff here would read
  // to the user as "no changes" — a silent no-op (M1). Surface an explicit status
  // instead so the panel can say the form isn't supported yet. This guard protects
  // every current and future filing type, not just 20-F.
  if (focusAligns.length === 0) {
    sendRedlineProgress('complete', 1);
    return {
      ok: true,
      status: 'unsupported_form',
      diffs: [],
      stats: {},
      prior: m.priorInfo,
      alignment: alignmentSummary,
    };
  }

  const diffs: SectionDiff[] = [];
  const stats: Record<string, SectionDiffCore['stats']> = {};
  let core: SectionDiffCore;

  for (let i = 0; i < focusAligns.length; i++) {
    const a = focusAligns[i]!;
    sendRedlineProgress('diffing', 0.5 + 0.45 * (i / Math.max(1, focusAligns.length)), `Diffing ${a.label}…`);

    if (a.status === 'matched' && a.current && a.prior) {
      core = await diffSectionSemantic(a.current.text, a.prior.text);
    } else if (a.status === 'added' && a.current) {
      core = diffSection(a.current.text, ''); // entire section is new
    } else if (a.status === 'removed' && a.prior) {
      core = diffSection('', a.prior.text); // entire section was dropped
    } else {
      continue;
    }

    diffs.push({
      sectionId: a.id,
      added: core.added,
      removed: core.removed,
      magnitude: core.magnitude,
      summary: templatedChangeSummary(core.stats),
    });
    stats[a.id] = core.stats;
  }

  sendRedlineProgress('complete', 1);

  return {
    ok: true,
    status: 'computed',
    diffs,
    stats,
    prior: m.priorInfo,
    alignment: alignmentSummary,
  };
}

// ── message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    rawMsg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    const msg = rawMsg as { target?: string; type?: string };
    if (msg.target !== 'offscreen') return false;

    if (msg.type === 'EXTRACTIVE_SUMMARIZE') {
      const m = msg as OffscreenExtractiveMsg;
      extractiveSummarize(m.sectionText)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (msg.type === 'ANALYZE_SENTIMENT') {
      const m = msg as OffscreenSentimentMsg;
      sentimentInFlight++;
      analyzeSentiment(m.rawTextHash, m.sections)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }))
        .finally(() => {
          // Free FinBERT as soon as the last sentiment request drains — results are
          // cached by content hash upstream, so a re-request re-initializes cheaply.
          // The encoder worker stays alive for summaries/redline. Only tear down when
          // no other batch is in flight.
          if (--sentimentInFlight === 0) terminateSentimentWorker();
        });
      return true;
    }

    if (msg.type === 'COMPUTE_REDLINE') {
      const m = msg as OffscreenRedlineMsg;
      computeRedline(m)
        .then(sendResponse)
        .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    return false;
  },
);

console.debug('[Relic offscreen] ready — device will be selected on first embed request');
