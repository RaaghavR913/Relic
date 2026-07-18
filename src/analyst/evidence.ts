// ============================================================
// Relic — Analyst pipeline: evidence verification + advice scrubbing
// ------------------------------------------------------------
// Two hallucination/compliance guards applied to every model output:
//
//  1. verifyEvidence — an insight's `evidence` quote must actually appear in
//     the source document (whitespace/quote-mark tolerant). Verified quotes
//     get a DOCUMENT-space range for jump-to-source; unverified quotes are
//     DROPPED and the insight's confidence is downgraded to 'Low'.
//
//  2. scrubAdvice — removes sentences that read as direct investment advice
//     ("you should buy…", "we recommend selling…", "the stock will go up").
//     Careful analyst language ("may be viewed positively…") passes through.
//
//  3. normalizeFiscalLabels — strips the year from the model's fiscal-quarter
//     shorthand ("Q1 2027" → "Q1"). A filer's fiscal year can lead the calendar
//     (NVIDIA's FY2027 quarter ends Apr 2026), so a model-asserted year reads as a
//     future/wrong quarter beside the period date; the period on the page carries
//     the year instead. Applied ONLY to model-authored prose, never to verbatim
//     quotes — and it targets only the shorthand, so spelled-out references
//     ("second half of fiscal year 2027") keep their year.
// ============================================================

import type { DocumentModel, FilingInsight } from '@/types';
import { ensureInsightTitle } from './insightTitle';

// ── evidence verification ─────────────────────────────────────────────────────

const MAX_EVIDENCE_CHARS = 240;
const MIN_EVIDENCE_CHARS = 12;

/** Escape regex metacharacters in a literal token. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a whitespace-tolerant regex for a quote: tokens must appear in order,
 * separated by any whitespace; straight/curly quotes and dashes are normalized.
 */
function quoteToRegex(quote: string): RegExp | null {
  const cleaned = quote
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, '-')
    .trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const body = tokens
    .map((t) => escapeRe(t).replace(/"/g, '["“”]').replace(/'/g, "['‘’]").replace(/-/g, '[—–-]'))
    .join('\\s+');
  try {
    return new RegExp(body, 'i');
  } catch {
    return null;
  }
}

export interface EvidenceMatch {
  sectionId: string;
  /** DOCUMENT-space char range of the matched quote. */
  range: [number, number];
}

/**
 * Locate a quote in the document. Returns the DOCUMENT-space range of the
 * first match, or null when the quote does not appear in the source.
 */
export function verifyEvidence(doc: DocumentModel, quote: string): EvidenceMatch | null {
  const trimmed = quote.trim().slice(0, MAX_EVIDENCE_CHARS);
  if (trimmed.length < MIN_EVIDENCE_CHARS) return null;
  const re = quoteToRegex(trimmed);
  if (!re) return null;

  for (const section of doc.sections) {
    const m = re.exec(section.text);
    if (m && m.index >= 0) {
      const start = section.charRange[0] + m.index;
      return { sectionId: section.id, range: [start, start + m[0].length] };
    }
  }
  return null;
}

// ── advice scrubbing ─────────────────────────────────────────────────────────

// Direct-advice constructions. Deliberately narrow: "the company sells
// products" or "management bought back shares" must NOT match.
const ADVICE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:you|investors?|readers?)\s+should\s+(?:buy|sell|short|avoid|dump|hold)\b/i,
  /\b(?:we|i)\s+(?:recommend|advise|suggest)\s+(?:buying|selling|shorting|holding|that you)/i,
  /\bstrong\s+(?:buy|sell)\b/i,
  /\b(?:buy|sell|short)\s+(?:the|this)\s+(?:stock|shares?)\b/i,
  /\b(?:the\s+)?(?:stock|shares?|price)\s+will\s+(?:go\s+up|go\s+down|rise|fall|drop|soar|crash)\b/i,
];

/** Remove sentences containing direct investment advice from a text field. */
export function scrubAdvice(text: string): string {
  if (!ADVICE_PATTERNS.some((re) => re.test(text))) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !ADVICE_PATTERNS.some((re) => re.test(s)));
  return kept.join(' ').trim();
}

// The model's fiscal-quarter shorthand: a quarter token plus an (optionally
// "FY"-prefixed) 4-digit year — "Q1 2027", "Q1 FY2027", "Q1 FY 2027". Only this
// shorthand matches; spelled-out references ("first quarter of fiscal year 2027",
// "second half of fiscal year 2027") don't, so verbatim quotes and genuine
// forward-looking guidance keep their years.
const QUARTER_YEAR = /\bQ([1-4])[\s -]+(?:FY\s*)?(?:19|20)\d{2}\b/gi;

/**
 * Drop the fabricated year from the model's quarter shorthand: "Q1 2027" → "Q1".
 * A filer's fiscal year can lead the calendar (NVIDIA's FY2027 quarter ends Apr
 * 2026), so the model's "Q1 2027" reads like a future/wrong quarter next to the
 * period date the reader sees. Rather than assert a year in prose, we strip it and
 * let the ONE authoritative period on the page — doc.periodOfReport, shown in the
 * header — carry the year. Applied only to model-authored prose, never to the
 * verified verbatim `evidence` quote.
 */
export function normalizeFiscalLabels(text: string): string {
  return text.replace(QUARTER_YEAR, (_m, q: string) => `Q${q}`);
}

// ── number / figure verification ──────────────────────────────────────────────

/**
 * Extract the "digit cores" of financially significant figures from a text:
 * dollar amounts, percentages, decimals, and 4+ digit numbers. Commas are
 * stripped so "$1,234.5" and "1234.5" compare equal; scale words ("billion",
 * "M") are ignored so "$1.1 billion" and "$1.1B" both yield "1.1". Bare 1–3
 * digit counts (e.g. "3 segments") are skipped to avoid noise.
 */
function figureCores(text: string): string[] {
  const cores: string[] = [];
  const re = /(\$\s?)?(\d[\d,]*(?:\.\d+)?)(\s?%)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const core = m[2]!.replace(/,/g, '');
    const digits = core.replace(/\D/g, '').length;
    const significant = Boolean(m[1]) || Boolean(m[3]) || core.includes('.') || digits >= 4;
    if (significant) cores.push(core);
  }
  return cores;
}

// Source figures are stable per document; memoize so each insight doesn't re-scan.
const _sourceFiguresCache = new WeakMap<DocumentModel, Set<string>>();
function sourceFigures(doc: DocumentModel): Set<string> {
  let set = _sourceFiguresCache.get(doc);
  if (!set) {
    set = new Set<string>();
    for (const section of doc.sections) for (const c of figureCores(section.text)) set.add(c);
    _sourceFiguresCache.set(doc, set);
  }
  return set;
}

/**
 * Drop sentences containing a financial figure that does not appear ANYWHERE in
 * the source document — a guard against the model restating or inventing numbers
 * in its prose (only the `evidence` quote was verified before). Conservative: a
 * figure whose digits appear anywhere in source is accepted (formatting / scale
 * tolerant), so only clear fabrications are cut. Verbatim extractive summaries —
 * whose figures are by construction from the document — pass through unchanged.
 */
export function scrubUnverifiedFigures(
  text: string,
  doc: DocumentModel,
): { text: string; stripped: boolean } {
  if (!text) return { text, stripped: false };
  const figs = sourceFigures(doc);
  let stripped = false;
  const kept = text.split(/(?<=[.!?])\s+/).filter((sentence) => {
    const bad = figureCores(sentence).some((c) => !figs.has(c));
    if (bad) stripped = true;
    return !bad;
  });
  return { text: kept.join(' ').trim(), stripped };
}

// ── insight finalization ──────────────────────────────────────────────────────

/**
 * Apply the guards to a model-produced insight: advice scrubbing, figure
 * verification (fabricated numbers stripped → confidence downgraded), and
 * evidence-quote verification. Returns null when scrubbing leaves the insight
 * without substance. A caller-provided `evidenceRange` (the deterministic tier,
 * whose summary IS a verbatim source sentence) is preserved for jump-to-source.
 */
export function finalizeInsight(doc: DocumentModel, insight: FilingInsight): FilingInsight | null {
  const clean = (t: string) => normalizeFiscalLabels(scrubAdvice(t));
  const sum = scrubUnverifiedFigures(clean(insight.summary), doc);
  const why = scrubUnverifiedFigures(clean(insight.whyItMatters), doc);
  const inv = scrubUnverifiedFigures(clean(insight.investorMeaning), doc);
  const summary = sum.text;
  const whyItMatters = why.text;
  const investorMeaning = inv.text;
  if (!summary && !investorMeaning) return null;
  const figuresStripped = sum.stripped || why.stripped || inv.stripped;

  const base: FilingInsight = {
    label: insight.label,
    category: insight.category,
    // Titles must be topic labels unique to this card — never a truncated copy
    // of the summary (LM and legacy deterministic paths both fail this).
    title: ensureInsightTitle(
      normalizeFiscalLabels(scrubAdvice(insight.title)),
      summary,
      insight.category,
    ),
    summary,
    whyItMatters,
    investorMeaning,
    severity: insight.severity,
    timeHorizon: insight.timeHorizon,
    confidence: figuresStripped ? 'Low' : insight.confidence,
    ...(insight.evidenceRange ? { evidenceRange: insight.evidenceRange } : {}),
  };

  if (insight.evidence) {
    const match = verifyEvidence(doc, insight.evidence);
    if (match) {
      return { ...base, evidence: insight.evidence.trim(), evidenceRange: match.range };
    }
    // Unverifiable quote: drop it and stop trusting the insight's certainty.
    return { ...base, confidence: 'Low' };
  }
  return base;
}
