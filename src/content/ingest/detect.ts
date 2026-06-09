/**
 * Filing type detection for the ingest pipeline.
 * Accepts an options object; XBRL dei:DocumentType takes highest priority.
 */

import type { FilingType } from '../../types/index.js';

export interface DetectFilingTypeOptions {
  text: string;
  doc?: Document;
  url?: string;
  host?: 'edgar' | 'ir' | 'transcript';
}

/**
 * Confidence of a filing-type detection:
 *   'high'   — authoritative XBRL dei:DocumentType fact (or known transcript host)
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
  if (s === 'S-1' || s === 'S-11') return 'S-1';
  if (s === 'DEF 14A' || s === 'DEF14A' || s === 'DEFA14A') return 'DEF 14A';
  return 'UNKNOWN';
}

const URL_PATTERNS: ReadonlyArray<[RegExp, FilingType]> = [
  [/[/_-]10-k[/_A.]/i, '10-K'],
  [/[/_-]10-q[/_A.]/i, '10-Q'],
  [/[/_-]8-k[/_A.]/i,  '8-K'],
  [/[/_-]20-f[/_A.]/i, '20-F'],
  [/[/_-]s-1[/_A.]/i,  'S-1'],
  [/def[_-]?14a/i,     'DEF 14A'],
];

function heuristicFromText(head: string): FilingType {
  const h = head.toUpperCase();
  if (/ANNUAL REPORT\s*(?:ON\s*)?FORM\s*10-K|FORM\s+10-K\b/.test(h)) return '10-K';
  if (/QUARTERLY REPORT\s*(?:ON\s*)?FORM\s*10-Q|FORM\s+10-Q\b/.test(h)) return '10-Q';
  if (/CURRENT REPORT\s*(?:ON\s*)?FORM\s*8-K|FORM\s+8-K\b/.test(h)) return '8-K';
  if (/ANNUAL REPORT\s*(?:ON\s*)?FORM\s*20-F|FORM\s+20-F\b/.test(h)) return '20-F';
  if (/NOTICE OF ANNUAL|PROXY STATEMENT|DEF\s*14A/.test(h)) return 'DEF 14A';
  if (/REGISTRATION STATEMENT|(?:FORM\s+)?S-1/.test(h)) return 'S-1';
  if (isTranscriptHead(h)) return 'TRANSCRIPT';
  return 'UNKNOWN';
}

function isTranscriptHead(head: string): boolean {
  let score = 0;
  const h = head.slice(0, 6000);
  if (/\bOPERATOR\b/m.test(h)) score += 3;
  if (/EARNINGS\s+(?:CALL|CONFERENCE\s+CALL)/im.test(h)) score += 3;
  if (/\bPREPARED\s+REMARKS\b/im.test(h)) score += 2;
  if (/QUESTIONS?\s+AND\s+ANSWERS?/im.test(h)) score += 2;
  if (/Q\s*[-–]\s*[A-Z]/m.test(h)) score += 1;
  return score >= 4;
}

/** Detect the filing type along with a confidence signal for its source. */
export function detectFilingTypeWithConfidence({
  text,
  doc,
  url,
  host,
}: DetectFilingTypeOptions): FilingTypeDetection {
  if (host === 'transcript') return { type: 'TRANSCRIPT', confidence: 'high' };

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
