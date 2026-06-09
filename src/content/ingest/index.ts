/**
 * FilingLens ingestion orchestrator (Session 1).
 *
 * ingestDocument({ document?, url? }) ties together:
 *   frame/root selection → normalized text + PositionMap → filing-type detection →
 *   section segmentation → metadata → DocumentModel + IngestResult.
 */

import type { DocumentModel, FilingType, IngestResult } from '../../types/index.js';
import { cyrb53 } from '../../lib/hash.js';
import { pickFilingRoot } from './dom-root.js';
import { buildNormalizedText } from './position-map.js';
import { detectFilingTypeWithConfidence } from './detect.js';
import { extractCompanyMeta } from './meta.js';
import { segmentSections } from './segment.js';
import { segmentTranscript, isTranscript } from '../transcript.js';

const TRANSCRIPT_HOSTS = [
  /(^|\.)fool\.com$/i,
  /(^|\.)seekingalpha\.com$/i,
  /(^|\.)motleyfool\.com$/i,
];

function classifyHost(url: string | undefined): 'edgar' | 'ir' | 'transcript' {
  if (!url) return 'ir';
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'ir'; }
  if (/(?:^|\.)sec\.gov$/i.test(host)) return 'edgar';
  if (TRANSCRIPT_HOSTS.some((re) => re.test(host))) return 'transcript';
  return 'ir';
}

export interface IngestOptions {
  document?: Document;
  url?: string;
}

export function ingestDocument(opts: IngestOptions = {}): IngestResult {
  const srcDoc = opts.document ?? (globalThis as { document?: Document }).document!;
  const picked = pickFilingRoot(srcDoc);
  const url = opts.url ?? picked.document.location?.href ?? '';
  const host = classifyHost(url);

  const { positionMap, tableRanges } = buildNormalizedText(picked.root);
  const text = positionMap.text;

  const detection = detectFilingTypeWithConfidence({
    text,
    doc: picked.document,
    url,
    host,
  });
  const filingType: FilingType = detection.type;

  const useTranscript = filingType === 'TRANSCRIPT' || host === 'transcript' || isTranscript(text);
  const sections = useTranscript
    ? segmentTranscript(text, tableRanges)
    : segmentSections(text, { filingType, tableRanges });

  // Confidence for the FINAL filing type. A text-heuristic transcript override (detected
  // only via isTranscript on the body, not the host or an explicit TRANSCRIPT type) is low
  // confidence; a known transcript host is high.
  const filingTypeConfidence: NonNullable<DocumentModel['filingTypeConfidence']> =
    host === 'transcript'
      ? 'high'
      : useTranscript && detection.type !== 'TRANSCRIPT'
        ? 'low'
        : detection.confidence;

  const meta = extractCompanyMeta(picked.document, url);

  const model: DocumentModel = {
    source: {
      url,
      host,
      ...(meta.accessionNo ? { accessionNo: meta.accessionNo } : {}),
      ...(meta.cik ? { cik: meta.cik } : {}),
    },
    ...(meta.ticker ? { ticker: meta.ticker } : {}),
    ...(meta.companyName ? { companyName: meta.companyName } : {}),
    filingType: useTranscript ? 'TRANSCRIPT' : filingType,
    filingTypeConfidence,
    ...(meta.periodOfReport ? { periodOfReport: meta.periodOfReport } : {}),
    ...(meta.filedAt ? { filedAt: meta.filedAt } : {}),
    sections,
    rawTextHash: cyrb53(text),
  };

  return { model, positionMap, tableRanges };
}

// Re-exports for convenience
export { pickFilingRoot } from './dom-root.js';
export { buildNormalizedText, DomPositionMap } from './position-map.js';
export { detectFilingType } from './detect.js';
export { extractCompanyMeta } from './meta.js';
export { segmentSections } from './segment.js';
export { segmentTranscript } from '../transcript.js';
