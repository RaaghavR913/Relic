// ============================================================
// Relic — export data model + shared helpers
// ------------------------------------------------------------
// The artifacts gathered from the on-device caches (by ./collect.ts) and the
// pure helpers shared by the PDF renderer (./pdf.ts) and the metadata stamper
// (./metadata.ts): data presence, filename, text folding, label tone, summary
// flattening, and the sentiment aggregate/consensus. No chrome.* and no
// rendering here, so this stays trivially unit-testable.
// ============================================================

import type {
  DocumentModel,
  FilingAnalysis,
  InsightLabel,
  OverallRead,
  Section,
  SentenceSentiment,
} from '@/types';
import type { SummaryEntry } from '@/summarizer/summaryStore';
import type { RedlineEntry } from '@/redline/redlineStore';
import { fmtCalendarDate } from '@/lib/date';

/** Everything the report renders — gathered from caches by ./collect.ts. */
export interface FilingExportData {
  doc: DocumentModel;
  /** ms epoch the report was generated. */
  generatedAt: number;
  /** Extension version, for the footer (passed in so this module stays chrome-free). */
  appVersion: string;
  analysis: FilingAnalysis | null;
  /** Section summaries, in document order, only those present in cache. */
  summaries: Array<{ section: Section; entry: SummaryEntry }>;
  sentiment: SentenceSentiment[] | null;
  redline: RedlineEntry | null;
}

/** True when there is at least one analysis artifact worth exporting. */
export function hasExportableData(d: FilingExportData): boolean {
  return Boolean(
    d.analysis ||
      d.summaries.length > 0 ||
      (d.sentiment && d.sentiment.length > 0) ||
      (d.redline && (d.redline.diffs.length > 0 || d.redline.alignment.length > 0)) ||
      (d.doc.xbrl && d.doc.xbrl.facts.length > 0),
  );
}

/** Safe download filename, e.g. `Relic-MU-10-Q-2026-05-28.pdf`. */
export function reportFilename(d: FilingExportData, ext = 'pdf'): string {
  const id = d.doc.ticker || d.doc.companyName || 'filing';
  const period = d.doc.periodOfReport ? d.doc.periodOfReport.slice(0, 10) : '';
  const safe = ['Relic', id, d.doc.filingType, period]
    .filter(Boolean)
    .join('-')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${safe || 'Relic-report'}.${ext}`;
}

// ── text ───────────────────────────────────────────────────────────────────

/**
 * Fold the unicode punctuation filings use into CP1252-safe equivalents and
 * collapse whitespace runs.
 *
 * The whitespace collapse matters for prose fields (evidence quotes, summaries,
 * extractive anchors) that slice verbatim from the filing: SEC tables extract to
 * text as one cell per line, often with blank lines between. The browser folds
 * that to single spaces when the panels render it in a `<p>`, but jsPDF's
 * `splitTextToSize` honours embedded newlines, so the raw runs would otherwise
 * spew one short cell per line down the page. Callers that want multiple lines
 * (e.g. section summaries) split before calling in, so no intentional break is
 * lost here.
 */
export function clean(s: string): string {
  return (s ?? '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/•/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[‐‑]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── dates ────────────────────────────────────────────────────────────────────

export function fmtDate(iso?: string): string {
  return fmtCalendarDate(iso, 'long');
}

export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── label tone ───────────────────────────────────────────────────────────────

/** Semantic tone an insight/read maps to — keys the PDF colour palette. */
export type Tone = 'pos' | 'neg' | 'warn' | 'info' | 'mut';

/** The internal 'Neutral' label is shown to users as 'Info' (mirrors AnalystPanel). */
export function labelText(label: string): string {
  return label === 'Neutral' ? 'Info' : label;
}

export const LABEL_TONE: Record<InsightLabel, Tone> = {
  Bullish: 'pos',
  Bearish: 'neg',
  Mixed: 'warn',
  Neutral: 'mut',
  'Watch Item': 'info',
  'Red Flag': 'neg',
  'Quality Signal': 'pos',
  'Weakness Signal': 'warn',
  Unclear: 'mut',
};

export const READ_TONE: Record<OverallRead, Tone> = {
  Bullish: 'pos',
  Bearish: 'neg',
  Mixed: 'warn',
  Neutral: 'mut',
};

// ── section summaries ────────────────────────────────────────────────────────

export interface SummaryItem {
  bullet: boolean;
  text: string;
}

/**
 * Flatten a cached section summary into display lines: the builtin analyst note
 * (lightweight markdown — bullets + **bold** stripped) or, for the extractive /
 * fallback register, the cached key sentences sliced from the section text.
 */
export function summaryItems(section: Section, entry: SummaryEntry): SummaryItem[] {
  if (entry.register === 'builtin' && entry.analyst.trim()) {
    return entry.analyst
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({
        bullet: /^[*\-•]\s+/.test(line),
        text: line.replace(/^[*\-•]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1'),
      }));
  }
  const anchors = entry.plainAnchors ?? [];
  if (anchors.length > 0) {
    return anchors.map(([start, end]) => ({ bullet: true, text: section.text.slice(start, end) }));
  }
  return entry.analyst ? [{ bullet: false, text: entry.analyst }] : [];
}

// ── sentiment ────────────────────────────────────────────────────────────────

export interface SentimentAgg {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

export function aggregateSentiment(results: SentenceSentiment[]): SentimentAgg {
  let positive = 0, negative = 0, neutral = 0;
  for (const r of results) {
    if (r.label === 'positive') positive++;
    else if (r.label === 'negative') negative++;
    else neutral++;
  }
  return { positive, negative, neutral, total: results.length };
}

export function pctOf(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

/** Plain-language read of the aggregate (mirrors SentimentPanel.consensusSummary). */
export function sentimentConsensus(agg: SentimentAgg): string {
  const { positive, negative, neutral, total } = agg;
  if (total === 0) return '';
  const posP = pctOf(positive, total), negP = pctOf(negative, total), neuP = pctOf(neutral, total);
  const net = posP - negP;
  const composition =
    neuP >= 60 ? 'overwhelmingly neutral, as is typical of measured disclosure language'
    : neuP >= 40 ? 'largely neutral, with pockets of directional tone'
    : 'unusually opinionated for a filing, with little neutral language';
  const lean =
    net >= 8 ? `Positive statements (${posP}%) outweigh negative ones (${negP}%), giving the filing an optimistic tilt.`
    : net <= -8 ? `Negative statements (${negP}%) outweigh positive ones (${posP}%), pointing to a cautious, risk-heavy tone.`
    : `Positive (${posP}%) and negative (${negP}%) statements are roughly balanced, leaving no strong directional bias.`;
  return `The filing's tone is ${composition}. ${lean}`;
}
