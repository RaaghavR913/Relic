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

function classifyHost(url: string | undefined): 'edgar' | 'ir' {
  if (!url) return 'ir';
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'ir'; }
  if (/(?:^|\.)sec\.gov$/i.test(host)) return 'edgar';
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

  const sections = segmentSections(text, { filingType, tableRanges });

  const filingTypeConfidence: NonNullable<DocumentModel['filingTypeConfidence']> =
    detection.confidence;

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
    filingType,
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
