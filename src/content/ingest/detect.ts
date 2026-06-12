/**
 * Filing type detection for the ingest pipeline.
 * Accepts an options object; XBRL dei:DocumentType takes highest priority.
 */

import type { FilingType, PageCategory } from '../../types/index.js';

export interface DetectFilingTypeOptions {
  text: string;
  doc?: Document;
  url?: string;
  host?: 'edgar' | 'ir';
}

/**
 * Confidence of a filing-type detection:
 *   'high'   — authoritative XBRL dei:DocumentType fact
 *   'medium' — matched the EDGAR URL path pattern
 *   'low'    — fell back to a first-page text heuristic (or UNKNOWN)
 */
export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface FilingTypeDetection {
  type: FilingType;
  confidence: DetectionConfidence;
}

export function queryXbrlFact(doc: Document, name: string): string | undefined {
  try {
    const el =
      doc.querySelector(`[name="${name}"]`) ??
      doc.querySelector(`[name="${name.toLowerCase()}"]`);
    return el?.textContent?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function normaliseType(raw: string): FilingType {
  const s = raw.toUpperCase().trim().replace(/\/A$/, '');
  if (s === '10-K') return '10-K';
  if (s === '10-Q') return '10-Q';
  if (s.startsWith('8-K')) return '8-K';
  if (s === '20-F') return '20-F';
  if (s.startsWith('6-K')) return '6-K';
  if (s === 'S-1' || s === 'S-11') return 'S-1';
  if (s === 'DEF 14A' || s === 'DEF14A' || s === 'DEFA14A') return 'DEF 14A';
  return 'UNKNOWN';
}

const URL_PATTERNS: ReadonlyArray<[RegExp, FilingType]> = [
  [/[/_-]10-k[/_A.]/i, '10-K'],
  [/[/_-]10-q[/_A.]/i, '10-Q'],
  [/[/_-]8-k[/_A.]/i,  '8-K'],
  [/[/_-]20-f[/_A.]/i, '20-F'],
  [/[/_-]6-k[/_A.]/i,  '6-K'],
  [/[/_-]s-1[/_A.]/i,  'S-1'],
  [/def[_-]?14a/i,     'DEF 14A'],
];

function heuristicFromText(head: string): FilingType {
  const h = head.toUpperCase();
  if (/ANNUAL REPORT\s*(?:ON\s*)?FORM\s*10-K|FORM\s+10-K\b/.test(h)) return '10-K';
  if (/QUARTERLY REPORT\s*(?:ON\s*)?FORM\s*10-Q|FORM\s+10-Q\b/.test(h)) return '10-Q';
  if (/CURRENT REPORT\s*(?:ON\s*)?FORM\s*8-K|FORM\s+8-K\b/.test(h)) return '8-K';
  if (/ANNUAL REPORT\s*(?:ON\s*)?FORM\s*20-F|FORM\s+20-F\b/.test(h)) return '20-F';
  if (/REPORT OF FOREIGN (?:PRIVATE )?ISSUER|FORM\s+6-K\b/.test(h)) return '6-K';
  if (/NOTICE OF ANNUAL|PROXY STATEMENT|DEF\s*14A/.test(h)) return 'DEF 14A';
  // Require an actual S-1 form reference or a registration-statement phrase — never
  // a bare "S-1" substring, which appears incidentally on data pages that merely
  // enumerate EDGAR form types (the BDC dataset page misfired exactly this way).
  if (/REGISTRATION STATEMENT\s+(?:UNDER|ON FORM)|\b(?:ON\s+)?FORM\s+S-1\b|\bFORM\s+S-11\b/.test(h))
    return 'S-1';
  return 'UNKNOWN';
}

/** Detect the filing type along with a confidence signal for its source. */
export function detectFilingTypeWithConfidence({
  text,
  doc,
  url,
}: DetectFilingTypeOptions): FilingTypeDetection {
  // 1. XBRL dei:DocumentType — highest priority
  if (doc) {
    const xbrl =
      queryXbrlFact(doc, 'dei:DocumentType') ??
      queryXbrlFact(doc, 'dei:documenttype');
    if (xbrl) {
      const n = normaliseType(xbrl);
      if (n !== 'UNKNOWN') return { type: n, confidence: 'high' };
    }
  }

  // 2. URL path pattern
  if (url) {
    for (const [re, type] of URL_PATTERNS) {
      if (re.test(url)) return { type, confidence: 'medium' };
    }
  }

  // 3. Text heuristic on first 8 000 chars
  return { type: heuristicFromText(text.slice(0, 8000)), confidence: 'low' };
}

export function detectFilingType(opts: DetectFilingTypeOptions): FilingType {
  return detectFilingTypeWithConfidence(opts).type;
}

/**
 * Confidence gate for on-demand analysis. On a low-confidence generic page the
 * on-page flag overlay stays hidden until the user opts in, and the side panel
 * shows a "doesn't look like a filing" warning.
 *
 * This now keys off the page CATEGORY, not a binary host string. A genuine EDGAR
 * filing (edgar_filing / edgar_ixbrl) is always trusted; a DATA_REPORT is an
 * intentional, correctly-classified readable page (not a misdetected filing) so
 * it is never flagged. Everything else is low-confidence generic when:
 *   • type detection fell through to UNKNOWN, OR
 *   • a multi-item form was claimed (10-K/10-Q/8-K/20-F/etc.) but the document
 *     never segmented into its items — it collapsed to the single fallback
 *     section. This catches generic pages that merely *mention* a form name
 *     (e.g. a press release referencing "the Company's Annual Report on Form
 *     10-K"), which the text heuristic otherwise misreads as that form.
 *
 * Falls back to the old host check when `category` is absent (persisted models).
 */
export function isLowConfidenceGeneric(model: {
  source: { host: 'edgar' | 'ir'; category?: PageCategory };
  filingType: FilingType;
  sections: ReadonlyArray<unknown>;
}): boolean {
  const category = model.source.category;
  if (category) {
    // Authoritative filings are trusted; data reports are intentionally readable.
    if (category === 'edgar_filing' || category === 'edgar_ixbrl') return false;
    if (model.filingType === 'DATA_REPORT') return false;
  } else if (model.source.host === 'edgar') {
    // Back-compat: pre-category models only carried host.
    return false;
  }
  if (model.filingType === 'DATA_REPORT') return false;
  if (model.filingType === 'UNKNOWN') return true;
  // Recognized a form but it didn't actually segment into items → misdetection.
  return model.sections.length <= 1;
}
