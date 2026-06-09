// ============================================================
// FilingLens — Ask-the-filing grounded synthesis (Session 7)
// ------------------------------------------------------------
// Runs in the SIDE PANEL (has the Chrome Prompt API). Given a question and the
// passages returned by Session 2's retrieve(), it asks Gemini Nano to answer
// STRICTLY from those passages, streaming tokens to the UI and citing sources
// as [1], [2]… that map back to the passage list (and thus to positionMap
// deep-links).
//
// Privacy: only the on-page retrieved passages — already in the filing DOM — are
// fed to the on-device model. Nothing leaves the device.
// ============================================================

import type { RetrievalResult } from '@/messages/types';

// ── Chrome Prompt API shims (mirror summarize.ts / changeSummary.ts) ──────────

export interface LMSession {
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<string>;
  /** Streaming variant — returns a ReadableStream of answer chunks. */
  promptStreaming(text: string, opts?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
}
interface LMMonitor {
  addEventListener(type: 'downloadprogress', cb: (e: { loaded: number }) => void): void;
}
interface LMCtor {
  create(opts: {
    initialPrompts?: Array<{ role: string; content: string }>;
    monitor?: (m: LMMonitor) => void;
    signal?: AbortSignal;
  }): Promise<LMSession>;
}

function getLanguageModel(): LMCtor | undefined {
  return (globalThis as Record<string, unknown>)['LanguageModel'] as LMCtor | undefined;
}

export function promptApiAvailable(): boolean {
  return getLanguageModel() !== undefined;
}

/**
 * Create a LanguageModel session pre-loaded with the Q&A system prompt.
 * Returns null if the API is unavailable. The caller owns the lifecycle and must
 * call session.destroy() when the filing session ends or the session is no longer needed.
 */
export async function createQaSession(
  opts: { onDownloadProgress?: (loaded: number) => void; signal?: AbortSignal } = {},
): Promise<LMSession | null> {
  const LM = getLanguageModel();
  if (!LM) return null;
  try {
    return await LM.create({
      initialPrompts: [{ role: 'system', content: QA_SYSTEM_PROMPT }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => opts.onDownloadProgress?.(e.loaded));
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch {
    return null;
  }
}

// ── prompt construction (pure, unit-tested) ───────────────────────────────────

export const QA_SYSTEM_PROMPT =
  'You are FilingLens, an assistant that answers questions about a specific SEC filing. ' +
  'Answer ONLY using the numbered source passages provided. ' +
  'If the passages do not contain the answer, say so plainly — never invent figures, dates, or facts. ' +
  'Be concise and factual (2–5 sentences). ' +
  'Cite the passages you used inline with bracketed numbers like [1] or [2], matching the source numbers. ' +
  'Do not add a preamble or restate the question.';

/** A retrieved passage plus a human-readable section label for citation display. */
export interface QaPassage extends RetrievalResult {
  sectionLabel: string;
}

const MAX_PASSAGE_CHARS = 600;

function trunc(s: string, n = MAX_PASSAGE_CHARS): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Build the grounded user prompt: the question + numbered source passages. */
export function buildQaPrompt(question: string, passages: QaPassage[]): string {
  const sources = passages
    .map((p, i) => `[${i + 1}] (${p.sectionLabel})\n${trunc(p.text)}`)
    .join('\n\n');
  return [
    `Question: ${question.trim()}`,
    '',
    'Source passages:',
    sources || '(no passages found)',
    '',
    'Answer the question using only these passages, citing sources as [n].',
  ].join('\n');
}

/**
 * Extract the unique 1-based source numbers cited in an answer, in first-mention
 * order, ignoring any out-of-range citations the model may hallucinate.
 */
export function parseCitations(answer: string, passageCount: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= passageCount && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ── templated extractive answer ───────────────────────────────────────────────

const MAX_QUOTE_CHARS = 180;

/**
 * Build a deterministic, no-model answer from retrieved passages.
 * Mirrors the templatedChangeSummary pattern: pure template, no inference.
 * Includes [n] citation markers that AnswerText renders as Custom Highlight
 * deep-link buttons, so citations still highlight source passages.
 */
export function templatedQaAnswer(passages: QaPassage[]): string {
  if (passages.length === 0) return '';

  const top = passages[0]!;
  const raw = top.text.trim().replace(/\s+/g, ' ');
  const quote = raw.length > MAX_QUOTE_CHARS ? raw.slice(0, MAX_QUOTE_CHARS) + '…' : raw;

  const pCount = passages.length;
  const countPhrase = pCount === 1 ? 'the retrieved passage' : `${pCount} retrieved passages`;
  const lead =
    `Based on ${countPhrase}, the filing states in ${top.sectionLabel}: "${quote}" [1].`;

  if (pCount === 1) return lead;

  const others = passages
    .slice(1)
    .map((_, i) => `[${i + 2}]`)
    .join('');
  return `${lead} Additional context is in ${others} below.`;
}

// ── streaming synthesis ────────────────────────────────────────────────────────

export interface StreamHandlers {
  /** Called with the full accumulated answer text on each chunk. */
  onToken: (fullText: string) => void;
  onDownloadProgress?: (loaded: number) => void;
  signal?: AbortSignal;
  /**
   * Optionally provide a pre-created LM session (from `createQaSession`) to reuse
   * across sequential Q&A calls within one filing session and skip per-call warm-up.
   * When provided the caller owns the session lifecycle — it will NOT be destroyed here.
   * When omitted a session is created and destroyed per call (original behaviour).
   */
  session?: LMSession;
}

/**
 * Stream a grounded answer. Resolves with the final text once the stream ends.
 *
 * Chrome's promptStreaming has shipped both "cumulative" (each chunk is the whole
 * answer so far) and "delta" (each chunk is new text) behaviours across versions;
 * we detect which and normalise to an always-growing accumulated string.
 */
export async function streamAnswer(
  question: string,
  passages: QaPassage[],
  handlers: StreamHandlers,
): Promise<string> {
  const { signal } = handlers;
  const ownSession = handlers.session === undefined;

  let session: LMSession;
  if (handlers.session) {
    session = handlers.session;
    console.debug('[FilingLens] QA: reusing pooled session');
  } else {
    const LM = getLanguageModel();
    if (!LM) throw new Error('Chrome Prompt API unavailable on this device.');
    const t0 = performance.now();
    session = await LM.create({
      initialPrompts: [{ role: 'system', content: QA_SYSTEM_PROMPT }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => handlers.onDownloadProgress?.(e.loaded));
      },
      ...(signal !== undefined ? { signal } : {}),
    });
    console.debug(`[FilingLens] QA: session created in ${Math.round(performance.now() - t0)}ms`);
  }

  try {
    const t1 = performance.now();
    const stream = session.promptStreaming(
      buildQaPrompt(question, passages),
      ...(signal !== undefined ? [{ signal }] : []),
    );

    let acc = '';
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (typeof value !== 'string') continue;
      // Normalise cumulative vs delta chunks.
      acc = value.startsWith(acc) && value.length >= acc.length ? value : acc + value;
      handlers.onToken(acc);
    }
    console.debug(`[FilingLens] QA stream complete in ${Math.round(performance.now() - t1)}ms`);
    return acc.trim();
  } finally {
    if (ownSession) session.destroy();
  }
}
