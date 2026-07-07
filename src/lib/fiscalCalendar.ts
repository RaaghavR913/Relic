// ============================================================
// Relic — fiscal-vs-calendar year offset detection (shared)
// ------------------------------------------------------------
// Many filers' fiscal years are offset from the calendar year: NVIDIA's fiscal
// 2027 began late January 2026, so its Q1 FY2027 10-Q covers a quarter ended
// April 2026. Verbatim takeaways quoting "fiscal year 2027" beside a 2026
// period date then read as a hallucination to users who assume calendar years —
// the text is correct, but it needs explaining. Detect the offset so the UI can
// show a one-line fiscal-calendar note.
//
// Signals, most authoritative first:
//   1. dei:DocumentFiscalYearFocus from inline XBRL — the filer's own label.
//   2. The dominant "fiscal (year) YYYY" mention across the document text
//      (covers PDFs and non-iXBRL docs). Accepted only when clearly dominant —
//      at least 3 mentions and at least twice the runner-up — so a one-off
//      forward-guidance year ("through fiscal 2028") can't trigger the note.
//
// Either way the offset must be exactly ±1 year: fiscal labels only ever lead
// or trail the period's calendar year by one, so anything else is a parsing
// artifact and the note is suppressed.
// ============================================================

import type { DocumentModel } from '@/types';

export interface FiscalCalendarOffset {
  /** The fiscal year the filing labels the current period with (e.g. 2027). */
  fiscalYear: number;
  /** The calendar year of the period-of-report end date (e.g. 2026). */
  calendarYear: number;
  /** ISO period end the calendar year was read from (for display). */
  periodEnd: string;
}

const FISCAL_YEAR_RE = /\bfiscal\s+(?:years?\s+)?((?:19|20)\d{2})\b/gi;

/** Most-mentioned fiscal year in the text, when it clearly dominates; else null. */
function dominantTextFiscalYear(doc: DocumentModel): number | null {
  const counts = new Map<number, number>();
  for (const section of doc.sections) {
    for (const m of section.text.matchAll(FISCAL_YEAR_RE)) {
      const year = Number(m[1]);
      counts.set(year, (counts.get(year) ?? 0) + 1);
    }
  }
  let bestYear: number | null = null;
  let bestCount = 0;
  let runnerUp = 0;
  for (const [year, n] of counts) {
    if (n > bestCount) {
      runnerUp = bestCount;
      bestYear = year;
      bestCount = n;
    } else if (n > runnerUp) {
      runnerUp = n;
    }
  }
  if (bestYear === null || bestCount < 3 || bestCount < runnerUp * 2) return null;
  return bestYear;
}

/**
 * Detect a filing whose fiscal-year label differs from the calendar year of its
 * reporting period. Returns null when they match, when either side is unknown,
 * or when the evidence is ambiguous — the note only shows on a confident read.
 */
export function detectFiscalCalendarOffset(doc: DocumentModel): FiscalCalendarOffset | null {
  const periodEnd = doc.periodOfReport ?? doc.xbrl?.periodEnd;
  if (!periodEnd) return null;
  const calendarYear = Number(periodEnd.slice(0, 4));
  if (!Number.isFinite(calendarYear)) return null;

  const fiscalYear = doc.xbrl?.fiscalYearFocus ?? dominantTextFiscalYear(doc);
  if (fiscalYear === null || fiscalYear === undefined) return null;
  if (Math.abs(fiscalYear - calendarYear) !== 1) return null;

  return { fiscalYear, calendarYear, periodEnd };
}
