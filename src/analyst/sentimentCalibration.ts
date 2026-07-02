// ============================================================
// Relic — Sentiment aggregation/display calibration
// ------------------------------------------------------------
// FinBERT reads dense legal/forward-looking hedging as negative, so Risk
// Factors sections paint red in nearly every filing — noise, not signal.
// This module recalibrates sentiment for AGGREGATION AND DISPLAY ONLY: the
// raw per-sentence SentenceSentiment stays exactly as cached (cache
// compatibility), and callers derive display counts from these pure
// functions instead of counting raw labels directly.
//
//   • dampBoilerplate    — sentences inside a boilerplate-flagged language
//     flag (safe-harbor / forward-looking disclaimers, src/flagging/
//     flagLanguage.ts) are relabeled neutral before counting.
//   • baselineAdjustedNet — a Risk Factors section's net (positive minus
//     negative) tone is reported relative to a typical baseline for that
//     section type, since some negative-leaning hedge language is normal
//     there and an absolute-zero comparison always reads red.
// ============================================================

import type { SentenceSentiment, LanguageFlag } from '@/types';

/** Same substring convention used by categoryForSection() in deterministic.ts. */
export function isRiskSectionId(sectionId: string): boolean {
  return sectionId.includes('risk');
}

export interface SentimentCounts {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

function tally(labels: Array<SentenceSentiment['label']>): SentimentCounts {
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const label of labels) {
    if (label === 'positive') positive++;
    else if (label === 'negative') negative++;
    else neutral++;
  }
  return { positive, negative, neutral, total: labels.length };
}

/**
 * Relabel sentences whose range overlaps a boilerplate-flagged language flag
 * as neutral, so safe-harbor / forward-looking disclaimers don't drive the
 * displayed sentiment. Returns new objects; never mutates the input (the
 * raw cached scores must stay untouched for cache compatibility).
 */
export function dampBoilerplate(
  sentiments: readonly SentenceSentiment[],
  flags: readonly LanguageFlag[],
): SentenceSentiment[] {
  const boilerplateRanges = flags.filter((f) => f.boilerplate).map((f) => f.range);
  if (boilerplateRanges.length === 0) return sentiments.slice();
  return sentiments.map((s) => {
    const overlapsBoilerplate = boilerplateRanges.some(
      ([a, b]) => s.range[0] < b && s.range[1] > a,
    );
    return overlapsBoilerplate ? { ...s, label: 'neutral' as const } : s;
  });
}

/** Boilerplate-damped positive/negative/neutral counts for display. */
export function calibratedCounts(
  sentiments: readonly SentenceSentiment[],
  flags: readonly LanguageFlag[],
): SentimentCounts {
  return tally(dampBoilerplate(sentiments, flags).map((s) => s.label));
}

/**
 * Typical net (positive − negative) share for boilerplate-heavy Risk Factors
 * language. FinBERT systematically reads hedged, litigious legal prose as
 * negative, so a risk section's raw net skews well below zero even when
 * nothing unusual is being said — this baseline is what "ordinary" risk
 * language reads as, so a section's calibrated net is reported as a delta
 * against it rather than against an uninformative absolute zero.
 */
export const RISK_SECTION_BASELINE_NET = -0.35;

/**
 * Net (positive − negative) share, adjusted against the Risk Factors
 * baseline for risk-category sections. Non-risk sections are unaffected.
 */
export function baselineAdjustedNet(counts: SentimentCounts, sectionId: string): number {
  if (counts.total === 0) return 0;
  const rawNet = (counts.positive - counts.negative) / counts.total;
  return isRiskSectionId(sectionId) ? rawNet - RISK_SECTION_BASELINE_NET : rawNet;
}
