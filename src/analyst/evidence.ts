// ============================================================
// FilingLens — Analyst pipeline: evidence verification + advice scrubbing
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
// ============================================================

import type { DocumentModel, FilingInsight } from '@/types';

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

// ── insight finalization ──────────────────────────────────────────────────────

/**
 * Apply both guards to a model-produced insight. Returns null when scrubbing
 * leaves the insight without substance.
 */
export function finalizeInsight(doc: DocumentModel, insight: FilingInsight): FilingInsight | null {
  const summary = scrubAdvice(insight.summary);
  const whyItMatters = scrubAdvice(insight.whyItMatters);
  const investorMeaning = scrubAdvice(insight.investorMeaning);
  if (!summary && !investorMeaning) return null;

  const base: FilingInsight = {
    label: insight.label,
    category: insight.category,
    title: scrubAdvice(insight.title) || insight.category,
    summary,
    whyItMatters,
    investorMeaning,
    severity: insight.severity,
    timeHorizon: insight.timeHorizon,
    confidence: insight.confidence,
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
