// ============================================================
// Relic — Section summarization orchestrator (Session 3)
// ------------------------------------------------------------
// Runs in the SIDE PANEL context (has access to Chrome AI APIs
// and chrome.runtime.sendMessage).
//
// Two-tier strategy keyed off `effectiveTier`:
//   'builtin'    → Chrome Prompt API → investor "analyst note"
//   'extractive' → embedding-centrality key sentences via offscreen
// When the Prompt API is unavailable (or fails), builtin falls back to the
// extractive key-sentence path so a summary is always produced.
//
// Cache: IndexedDB keyed by rawTextHash + sectionId + register.
// Privacy: section text never leaves the device.
// ============================================================

import type { Section, DocumentModel } from '@/types';
import {
  LANGUAGE_MODEL_LANGUAGE,
  type GenerationTier,
} from '@/runtime/capabilities';
import type { SummarizeSectionMsg, ExtractiveResponse } from '@/messages/types';
import { withStallGuard } from '@/lib/stallGuard';
import { getCachedSummary, putSummary, type SummaryEntry } from './summaryStore';

// ── public types ──────────────────────────────────────────────────────────────

export const DISCLAIMER = 'AI summary — verify against source.';

export interface SummaryResult {
  /** Builtin: the analyst note. Extractive / fallback: joined key sentences. */
  summary: string;
  /**
   * SECTION-space char ranges [start, end) for jump-to-source.
   * UI adds section.charRange[0] to get DOCUMENT-space for HIGHLIGHT_RANGE.
   * Builtin: one entry for the whole section [0, section.text.length].
   * Extractive: one entry per selected sentence.
   */
  anchors: ReadonlyArray<[number, number]>;
  register: GenerationTier;
  /** True when an analyst note was produced (Prompt API). */
  analystAvailable: boolean;
  fromCache: boolean;
}

// ── Chrome AI shims ───────────────────────────────────────────────────────────
// Minimal interfaces for the APIs we call; keeps us off globalThis casting
// while remaining compatible with @types/dom-chromium-ai.

interface DownloadMonitor {
  addEventListener(
    type: 'downloadprogress',
    cb: (e: { loaded: number; total: number }) => void,
  ): void;
}

interface LMSession {
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface LMCtor {
  create(opts: {
    // ReadonlyArray so the `as const` LANGUAGE_MODEL_LANGUAGE tuples assign cleanly.
    expectedInputs?: ReadonlyArray<{ type: string; languages: readonly string[] }>;
    expectedOutputs?: ReadonlyArray<{ type: string; languages: readonly string[] }>;
    initialPrompts?: Array<{ role: string; content: string }>;
    monitor?: (m: DownloadMonitor) => void;
    signal?: AbortSignal;
  }): Promise<LMSession>;
}

function getLanguageModel(): LMCtor | undefined {
  return (globalThis as Record<string, unknown>)['LanguageModel'] as LMCtor | undefined;
}

// ── constants ─────────────────────────────────────────────────────────────────

const MAX_ANALYST_CHARS = 4_000;

/**
 * Abort the builtin path when Gemini Nano makes NO progress for this long.
 * A healthy multi-minute first-run download keeps resetting the guard via
 * downloadprogress deltas; a wedged create()/prompt() or a stalled Chrome
 * download (metered network, low disk) trips it and we degrade to extractive
 * instead of freezing the panel's bar at the last fraction forever.
 */
const NANO_STALL_MS = 45_000;

const ANALYST_SYSTEM_PROMPT =
  'You are an equity research analyst reviewing a section of a financial document for investors. ' +
  'In 3–4 concise sentences, translate the section into investor signals: what happened, what changed, ' +
  'and why it matters for revenue, margins, cash flow, balance-sheet strength, dilution, guidance, or risk. ' +
  'Do not merely compress the text — surface only what an investor would care about. ' +
  'Never give investment advice (no buy/sell/short, no price predictions); use careful language like ' +
  '"this may be viewed positively by investors because…". ' +
  'Do not invent figures — only reference what is explicitly stated. ' +
  'If the section has no investor-relevant content, say so in one sentence. ' +
  'No bullet points. Output only the analyst note.';

// ── public entry point ────────────────────────────────────────────────────────

/**
 * Cache read honouring the degraded-run fallback: a builtin-tier request also
 * accepts a previously degraded extractive entry (`register` records what was
 * actually produced, not what was requested), so machines where Nano stalls
 * don't repay the 45s stall penalty on every visit.
 */
export async function getCachedSummaryWithFallback(
  rawTextHash: string,
  sectionId: string,
  tier: GenerationTier,
): Promise<SummaryEntry | null> {
  const direct = await getCachedSummary(rawTextHash, sectionId, tier);
  if (direct) return direct;
  if (tier === 'builtin') return getCachedSummary(rawTextHash, sectionId, 'extractive');
  return null;
}

/**
 * Produce a { summary } for a section.
 * Checks cache first; writes result to cache after generation.
 */
export async function summarizeSection(
  section: Section,
  doc: DocumentModel,
  opts: {
    effectiveTier: GenerationTier;
    onDownloadProgress?: (loaded: number) => void;
    signal?: AbortSignal;
  },
): Promise<SummaryResult> {
  // Cache hit
  const cached = await getCachedSummaryWithFallback(doc.rawTextHash, section.id, opts.effectiveTier);
  if (cached) {
    const register: GenerationTier = cached.register === 'builtin' ? 'builtin' : 'extractive';
    return {
      summary: cached.analyst,
      anchors: cached.plainAnchors,
      register,
      analystAvailable: register === 'builtin',
      fromCache: true,
    };
  }

  const result =
    opts.effectiveTier === 'builtin'
      ? await runBuiltin(section, doc.rawTextHash, opts)
      : await runExtractive(section, doc.rawTextHash);

  // Persist (best-effort — don't fail summarization if cache write fails).
  // The store schema keeps `plain` for back-compat; it now mirrors `analyst`.
  // Keyed by result.register — NOT the requested tier — so a builtin run that
  // degraded to extractive can never occupy the builtin cache slot and be
  // served later as if it were an analyst note.
  await putSummary({
    rawTextHash: doc.rawTextHash,
    sectionId: section.id,
    register: result.register,
    plain: result.summary,
    analyst: result.summary,
    plainAnchors: result.anchors as Array<[number, number]>,
    cachedAt: Date.now(),
  }).catch(console.warn);

  return result;
}

// ── builtin tier ──────────────────────────────────────────────────────────────

async function runBuiltin(
  section: Section,
  rawTextHash: string,
  opts: { onDownloadProgress?: (loaded: number) => void; signal?: AbortSignal },
): Promise<SummaryResult> {
  const text = section.text;
  if (!text.trim()) {
    return emptyResult('builtin', section);
  }

  // Analyst note via Prompt API (Gemini Nano). When the Prompt API is
  // unavailable, stalls, or fails, fall back to the extractive key-sentence
  // path so a summary is always produced.
  const LM = getLanguageModel();
  if (!LM) return runExtractive(section, rawTextHash);

  const sig = opts.signal;

  try {
    // The stall guard — not a fixed deadline — wraps create()+prompt(): a
    // healthy first-run Nano download may take minutes and keeps bumping the
    // guard, while one that stops progressing is aborted after NANO_STALL_MS.
    const analyst = await withStallGuard<string>(
      async (signal, bump) => {
        // Only a real delta counts as progress — Chrome can re-emit the same
        // fraction (e.g. 0.69) while a stalled download sits still.
        let lastLoaded = -1;
        const monitor = (m: DownloadMonitor) => {
          m.addEventListener('downloadprogress', (e) => {
            if (e.loaded !== lastLoaded) {
              lastLoaded = e.loaded;
              bump();
            }
            opts.onDownloadProgress?.(e.loaded);
          });
        };

        const session = await LM.create({
          ...LANGUAGE_MODEL_LANGUAGE,
          initialPrompts: [{ role: 'system', content: ANALYST_SYSTEM_PROMPT }],
          monitor,
          signal,
        });
        try {
          return await session.prompt(
            `Section: ${section.label}\n\n${text.slice(0, MAX_ANALYST_CHARS)}`,
            { signal },
          );
        } finally {
          session.destroy();
        }
      },
      { stallMs: NANO_STALL_MS, ...(sig !== undefined ? { parent: sig } : {}) },
    );

    return {
      summary: analyst,
      // Whole-section anchor in SECTION space.
      anchors: [[0, text.length]],
      register: 'builtin',
      analystAvailable: true,
      fromCache: false,
    };
  } catch (err) {
    // Respect aborts; otherwise (failure OR stall) fall back to extractive.
    if (sig?.aborted) throw err;
    return runExtractive(section, rawTextHash);
  }
}

// ── extractive tier ───────────────────────────────────────────────────────────

async function runExtractive(
  section: Section,
  rawTextHash: string,
): Promise<SummaryResult> {
  if (!section.text.trim()) {
    return emptyResult('extractive', section);
  }

  const msg: SummarizeSectionMsg = {
    target: 'sw',
    type: 'SUMMARIZE_SECTION',
    rawTextHash,
    sectionId: section.id,
    sectionText: section.text,
    charStart: section.charRange[0],
    ...(section.tables !== undefined ? { tables: section.tables } : {}),
  };

  const resp: ExtractiveResponse = await (
    chrome.runtime.sendMessage(msg) as Promise<ExtractiveResponse>
  );

  if (!resp.ok) throw new Error(`Extractive summarization failed: ${resp.error}`);

  const { sentences } = resp;

  if (sentences.length === 0) {
    return emptyResult('extractive', section);
  }

  const summary = sentences.map((s) => s.text).join(' ');
  const anchors: Array<[number, number]> = sentences.map((s) => s.range);

  return {
    summary,
    anchors,
    register: 'extractive',
    analystAvailable: false,
    fromCache: false,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function emptyResult(register: GenerationTier, section: Section): SummaryResult {
  const snippet = section.text.trim().slice(0, 200);
  const summary = snippet
    ? snippet + (section.text.trim().length > 200 ? '…' : '')
    : '(empty section)';
  return {
    summary,
    anchors: [[0, section.text.length]],
    register,
    analystAvailable: false,
    fromCache: false,
  };
}
