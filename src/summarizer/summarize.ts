// ============================================================
// FilingLens — Section summarization orchestrator (Session 3)
// ------------------------------------------------------------
// Runs in the SIDE PANEL context (has access to Chrome AI APIs
// and chrome.runtime.sendMessage).
//
// Two-tier strategy keyed off `effectiveTier`:
//   'builtin'   → Chrome Summarizer API (plain) + Prompt API (analyst)
//   'extractive' → embedding-centrality sentences via offscreen (plain only)
//
// Cache: IndexedDB keyed by rawTextHash + sectionId + register.
// Privacy: section text never leaves the device.
// ============================================================

import type { Section, DocumentModel } from '@/types';
import type { GenerationTier } from '@/runtime/capabilities';
import type { SummarizeSectionMsg, ExtractiveResponse } from '@/messages/types';
import { getCachedSummary, putSummary } from './summaryStore';
import { splitTextForSummarization } from '@/offscreen/chunker';

// ── public types ──────────────────────────────────────────────────────────────

export const DISCLAIMER = 'AI summary — verify against source.';

export interface SummaryResult {
  plain: string;
  analyst: string;
  /**
   * SECTION-space char ranges [start, end) for jump-to-source.
   * UI adds section.charRange[0] to get DOCUMENT-space for HIGHLIGHT_RANGE.
   * Builtin: one entry for the whole section [0, section.text.length].
   * Extractive: one entry per selected sentence.
   */
  plainAnchors: ReadonlyArray<[number, number]>;
  register: GenerationTier;
  /** True when an analyst note is available (builtin tier only). */
  analystAvailable: boolean;
  fromCache: boolean;
}

// ── Chrome AI shims ───────────────────────────────────────────────────────────
// Minimal interfaces for the APIs we call; keeps us off globalThis casting
// while remaining compatible with @types/dom-chromium-ai.

interface SummarizerMonitor {
  addEventListener(
    type: 'downloadprogress',
    cb: (e: { loaded: number; total: number }) => void,
  ): void;
}

export interface SummarizerInstance {
  summarize(
    text: string,
    opts?: { context?: string; signal?: AbortSignal },
  ): Promise<string>;
  destroy(): void;
}

interface SummarizerCtor {
  create(opts: {
    type?: string;
    format?: string;
    length?: string;
    outputLanguage?: string;
    expectedInputLanguages?: string[];
    monitor?: (m: SummarizerMonitor) => void;
    signal?: AbortSignal;
  }): Promise<SummarizerInstance>;
}

interface LMSession {
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface LMCtor {
  create(opts: {
    initialPrompts?: Array<{ role: string; content: string }>;
    monitor?: (m: SummarizerMonitor) => void;
    signal?: AbortSignal;
  }): Promise<LMSession>;
}

function getSummarizer(): SummarizerCtor | undefined {
  return (globalThis as Record<string, unknown>)['Summarizer'] as SummarizerCtor | undefined;
}

function getLanguageModel(): LMCtor | undefined {
  return (globalThis as Record<string, unknown>)['LanguageModel'] as LMCtor | undefined;
}

// ── constants ─────────────────────────────────────────────────────────────────

const MAX_SUMMARIZER_CHARS = 8_000;
const MAX_ANALYST_CHARS = 4_000;

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
 * Produce { plain, analyst } for a section.
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
  const cached = await getCachedSummary(doc.rawTextHash, section.id, opts.effectiveTier);
  if (cached) {
    return {
      plain: cached.plain,
      analyst: cached.analyst,
      plainAnchors: cached.plainAnchors,
      register: opts.effectiveTier,
      analystAvailable: opts.effectiveTier === 'builtin',
      fromCache: true,
    };
  }

  const result =
    opts.effectiveTier === 'builtin'
      ? await runBuiltin(section, opts)
      : await runExtractive(section, doc.rawTextHash);

  // Persist (best-effort — don't fail summarization if cache write fails)
  await putSummary({
    rawTextHash: doc.rawTextHash,
    sectionId: section.id,
    register: opts.effectiveTier,
    plain: result.plain,
    analyst: result.analyst,
    plainAnchors: result.plainAnchors as Array<[number, number]>,
    cachedAt: Date.now(),
  }).catch(console.warn);

  return result;
}

// ── builtin tier ──────────────────────────────────────────────────────────────

async function runBuiltin(
  section: Section,
  opts: { onDownloadProgress?: (loaded: number) => void; signal?: AbortSignal },
): Promise<SummaryResult> {
  const text = section.text;
  if (!text.trim()) {
    return emptyResult('builtin', section);
  }

  const monitor = (m: SummarizerMonitor) => {
    m.addEventListener('downloadprogress', (e) => opts.onDownloadProgress?.(e.loaded));
  };

  const SummarizerCtor = getSummarizer();
  if (!SummarizerCtor) throw new Error('Chrome Summarizer API unavailable on this device.');

  const length = text.length < 2_000 ? 'short' : 'medium';
  // exactOptionalPropertyTypes: spread signal conditionally to avoid passing undefined.
  const sig = opts.signal;
  const summarizer = await SummarizerCtor.create({
    type: 'key-points',
    format: 'markdown',
    length,
    // SEC filings are English. Declaring the I/O languages satisfies Chrome's
    // Summarizer output-safety attestation and silences the "No output language
    // was specified" warning (surfaced during live extension testing).
    outputLanguage: 'en',
    expectedInputLanguages: ['en'],
    monitor,
    ...(sig !== undefined ? { signal: sig } : {}),
  });

  let plain: string;
  try {
    if (text.length <= MAX_SUMMARIZER_CHARS) {
      plain = await summarizer.summarize(text, {
        context: 'This is a section from an SEC regulatory filing.',
        ...(sig !== undefined ? { signal: sig } : {}),
      });
    } else {
      plain = await summarizeInChunks(text, summarizer, sig);
    }
  } finally {
    summarizer.destroy();
  }

  // Analyst note via Prompt API (Gemini Nano)
  let analyst = plain;
  let analystAvailable = false;
  const LM = getLanguageModel();
  if (LM) {
    try {
      const session = await LM.create({
        initialPrompts: [{ role: 'system', content: ANALYST_SYSTEM_PROMPT }],
        monitor,
        ...(sig !== undefined ? { signal: sig } : {}),
      });
      try {
        analyst = await session.prompt(
          `Section: ${section.label}\n\n${text.slice(0, MAX_ANALYST_CHARS)}`,
          ...(sig !== undefined ? [{ signal: sig }] : []),
        );
        analystAvailable = true;
      } finally {
        session.destroy();
      }
    } catch {
      // LM unavailable or failed — fall back to the plain summary
      analyst = plain;
    }
  }

  // Whole-section anchor in SECTION space
  const sectionAnchor: [number, number] = [0, text.length];

  return {
    plain,
    analyst,
    plainAnchors: [sectionAnchor],
    register: 'builtin',
    analystAvailable,
    fromCache: false,
  };
}

// ── multi-chunk merge ─────────────────────────────────────────────────────────

/**
 * Summarize a section that exceeds MAX_SUMMARIZER_CHARS by splitting it into
 * sequential chunks, summarizing each, then condensing the chunk summaries into
 * one coherent section summary.
 *
 * Exported for unit-testing with a mock summarizer.
 */
export async function summarizeInChunks(
  text: string,
  summarizer: SummarizerInstance,
  signal: AbortSignal | undefined,
): Promise<string> {
  const chunks = splitTextForSummarization(text, MAX_SUMMARIZER_CHARS);
  const sigOpts = signal !== undefined ? { signal } : {};

  const chunkSummaries: string[] = [];
  for (const chunk of chunks) {
    const s = await summarizer.summarize(chunk, {
      context: 'This is a portion of an SEC regulatory filing section.',
      ...sigOpts,
    });
    chunkSummaries.push(s);
  }

  // Merge pass: condense chunk summaries into one coherent, non-redundant summary.
  const mergeInput = chunkSummaries.join('\n\n').slice(0, MAX_SUMMARIZER_CHARS);
  return summarizer.summarize(mergeInput, {
    context:
      'These are partial summaries of a single SEC filing section. ' +
      'Synthesize them into one concise, coherent, non-redundant summary.',
    ...sigOpts,
  });
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
  };

  const resp: ExtractiveResponse = await (
    chrome.runtime.sendMessage(msg) as Promise<ExtractiveResponse>
  );

  if (!resp.ok) throw new Error(`Extractive summarization failed: ${resp.error}`);

  const { sentences } = resp;

  if (sentences.length === 0) {
    return emptyResult('extractive', section);
  }

  const plain = sentences.map((s) => s.text).join(' ');
  const plainAnchors: Array<[number, number]> = sentences.map((s) => s.range);

  return {
    plain,
    analyst: plain, // reused — analyst toggle disabled in extractive tier
    plainAnchors,
    register: 'extractive',
    analystAvailable: false,
    fromCache: false,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function emptyResult(register: GenerationTier, section: Section): SummaryResult {
  const snippet = section.text.trim().slice(0, 200);
  const plain = snippet ? snippet + (section.text.trim().length > 200 ? '…' : '') : '(empty section)';
  return {
    plain,
    analyst: plain,
    plainAnchors: [[0, section.text.length]],
    register,
    analystAvailable: false,
    fromCache: false,
  };
}
