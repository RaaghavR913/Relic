// ============================================================
// FilingLens — Tier-aware change summary (Session 6)
// ------------------------------------------------------------
// Runs in the SIDE PANEL (has Chrome AI APIs). The offscreen diff already
// attached a TEMPLATED summary to every SectionDiff; on the 'builtin' tier we
// upgrade it to a natural-language summary via the Prompt API (Gemini Nano),
// driven purely by the diff STATS and a few sample added/removed snippets — the
// model is never asked to re-read the full filing.
//
// Privacy: only short on-device snippets are sent to the on-device model.
// ============================================================

import { LANGUAGE_MODEL_LANGUAGE, type GenerationTier } from '@/runtime/capabilities';
import type { SectionDiff } from '@/types';
import { templatedChangeSummary, type DiffStats } from './diff';

export interface LMSession {
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
interface LMMonitor {
  addEventListener(type: 'downloadprogress', cb: (e: { loaded: number }) => void): void;
}
interface LMCtor {
  create(opts: {
    outputLanguage?: string;
    initialPrompts?: Array<{ role: string; content: string }>;
    monitor?: (m: LMMonitor) => void;
    signal?: AbortSignal;
  }): Promise<LMSession>;
}

function getLanguageModel(): LMCtor | undefined {
  return (globalThis as Record<string, unknown>)['LanguageModel'] as LMCtor | undefined;
}

const REDLINE_SYSTEM_PROMPT =
  'You are a senior equity research analyst comparing two consecutive annual SEC filings. ' +
  'Given a structured summary of what changed in one section between last year and this year, ' +
  'write 2–3 short, factual sentences describing the substantive changes for an investor. ' +
  'Mention counts of new vs. removed items and any notable shift in emphasis (e.g. ' +
  '“supply-chain language strengthened”, “removed reference to X”). ' +
  'Do not invent specifics that are not in the provided snippets. No preamble, no bullet points.';

/**
 * Create a LanguageModel session pre-loaded with the redline system prompt.
 * Returns null if the API is unavailable. The caller is responsible for calling
 * session.destroy() when the filing session ends.
 */
export async function createChangeSummarySession(signal?: AbortSignal): Promise<LMSession | null> {
  const LM = getLanguageModel();
  if (!LM) return null;
  try {
    return await LM.create({
      ...LANGUAGE_MODEL_LANGUAGE,
      initialPrompts: [{ role: 'system', content: REDLINE_SYSTEM_PROMPT }],
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    return null;
  }
}

const MAX_SNIPPET = 280;
const MAX_SNIPPETS = 4;

function buildPrompt(label: string, stats: DiffStats, diff: SectionDiff): string {
  const added = diff.added.slice(0, MAX_SNIPPETS).map((s) => `+ ${trunc(s.text)}`);
  const removed = diff.removed.slice(0, MAX_SNIPPETS).map((s) => `- ${trunc(s.text)}`);
  return [
    `Section: ${label}`,
    `Stats: ${stats.addedSentences} new sentence(s), ${stats.removedSentences} removed, ` +
      `${stats.rewordedSentences} reworded; ~${stats.pctChanged}% of text changed.`,
    added.length ? `Added passages:\n${added.join('\n')}` : 'Added passages: none.',
    removed.length ? `Removed passages:\n${removed.join('\n')}` : 'Removed passages: none.',
    'Write the change summary now.',
  ].join('\n\n');
}

function trunc(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > MAX_SNIPPET ? t.slice(0, MAX_SNIPPET) + '…' : t;
}

/**
 * Produce the change summary for one section diff.
 *   - 'extractive': returns the deterministic templated summary (no model).
 *   - 'builtin':    asks the Prompt API; on any failure, falls back to templated.
 *
 * Pass `opts.session` (from `createChangeSummarySession`) to reuse a pooled session
 * across sequential calls within one filing session and skip per-call warm-up.
 * When a pooled session is provided the caller owns its lifecycle; this function
 * will NOT destroy it. When no session is provided one is created and destroyed
 * per call (original behaviour, preserved for backward compatibility).
 */
export async function generateChangeSummary(
  label: string,
  diff: SectionDiff,
  stats: DiffStats,
  opts: { tier: GenerationTier; signal?: AbortSignal; session?: LMSession },
): Promise<string> {
  const templated = templatedChangeSummary(stats);
  if (opts.tier !== 'builtin') return templated;

  // Nothing substantive changed — don't spend a model call.
  if (stats.addedSentences === 0 && stats.removedSentences === 0 && stats.rewordedSentences === 0) {
    return templated;
  }

  const sig = opts.signal;
  const ownSession = opts.session === undefined;

  let session: LMSession;
  if (opts.session) {
    session = opts.session;
  } else {
    const LM = getLanguageModel();
    if (!LM) return templated;
    try {
      const t0 = performance.now();
      session = await LM.create({
        ...LANGUAGE_MODEL_LANGUAGE,
        initialPrompts: [{ role: 'system', content: REDLINE_SYSTEM_PROMPT }],
        ...(sig !== undefined ? { signal: sig } : {}),
      });
      console.debug(`[FilingLens] changeSummary: session created in ${Math.round(performance.now() - t0)}ms`);
    } catch {
      return templated;
    }
  }

  try {
    const t1 = performance.now();
    const out = await session.prompt(
      buildPrompt(label, stats, diff),
      ...(sig !== undefined ? [{ signal: sig }] : []),
    );
    console.debug(
      `[FilingLens] changeSummary prompt (${ownSession ? 'new session' : 'pooled'}): ${Math.round(performance.now() - t1)}ms`,
    );
    const cleaned = out.trim();
    return cleaned.length > 0 ? cleaned : templated;
  } catch {
    return templated;
  } finally {
    if (ownSession) session.destroy();
  }
}
