// ============================================================
// Relic — Analyst pipeline: lexicon tone proxy
// ------------------------------------------------------------
// A fast, model-free tone signal for the deterministic Analyst. FinBERT sentiment
// is a manual, on-demand pass, so on first view the analyst would otherwise read a
// flat "Neutral" with no skew labels. This proxy gives it an immediate read:
//   • negative tone REUSES the already-computed cautionary-language flags
//     (negative / litigious) — no extra work;
//   • positive tone is a small bundled financial-positive word scan.
// FinBERT sentiment, when present, always takes precedence over this (see
// deterministic.ts). Zero-egress, no model.
// ============================================================

import type { DocumentModel, InsightLabel, LanguageFlag, OverallRead } from '@/types';

export interface SectionTone {
  label: InsightLabel;
  /** Signed polarity in [-1, 1]. */
  net: number;
  /** Number of polarity hits (positive words + cautionary flags) in the section. */
  n: number;
}

export interface ToneSignal {
  overall: OverallRead;
  bySection: Map<string, SectionTone>;
}

// Curated financial-positive words. Kept deliberately narrow to financial
// improvement language so generic prose doesn't skew the read.
const POSITIVE_RE =
  /\b(grew|grow(?:th|ing)?|increas\w+|improv\w+|record|strong\w*|robust|exceed\w+|outperform\w+|expansion|expand\w+|gain(?:s|ed)?|higher|rose|surg\w+|accelerat\w+|favorab\w+|profitab\w+|momentum|resilien\w+|solid|upside|tailwind|raised|strengthen\w+)\b/gi;

function readFrom(pos: number, neg: number): OverallRead {
  const n = pos + neg;
  if (n < 4) return 'Neutral';
  const p = pos / n;
  const q = neg / n;
  if (p > q * 1.5 && p > 0.1) return 'Bullish';
  if (q > p * 1.5 && q > 0.1) return 'Bearish';
  if (p > 0.2 && q > 0.2) return 'Mixed';
  return 'Neutral';
}

function sectionToneFrom(pos: number, neg: number): SectionTone {
  const n = pos + neg;
  if (n < 3) return { label: 'Neutral', net: 0, n };
  const net = (pos - neg) / n;
  let label: InsightLabel = 'Neutral';
  if (net > 0.2) label = 'Bullish';
  else if (net < -0.2) label = 'Bearish';
  else if (pos > 0 && neg > 0) label = 'Mixed';
  return { label, net, n };
}

/**
 * Compute a per-section + overall tone signal from cautionary-language flags
 * (negative side) and a positive-word scan (positive side). Intended as the
 * deterministic Analyst's fallback when FinBERT sentiment is not yet available.
 */
export function computeLexiconTone(
  doc: DocumentModel,
  flags: ReadonlyArray<LanguageFlag>,
): ToneSignal {
  const negBySection = new Map<string, number>();
  for (const f of flags) {
    if (f.type === 'negative' || f.type === 'litigious') {
      negBySection.set(f.sectionId, (negBySection.get(f.sectionId) ?? 0) + 1);
    }
  }

  const bySection = new Map<string, SectionTone>();
  let totalPos = 0;
  let totalNeg = 0;
  for (const section of doc.sections) {
    const pos = (section.text.match(POSITIVE_RE) ?? []).length;
    const neg = negBySection.get(section.id) ?? 0;
    totalPos += pos;
    totalNeg += neg;
    bySection.set(section.id, sectionToneFrom(pos, neg));
  }

  return { overall: readFrom(totalPos, totalNeg), bySection };
}
