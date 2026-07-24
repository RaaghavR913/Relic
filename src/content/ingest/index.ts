/**
 * Relic ingestion orchestrator (Session 1).
 *
 * ingestDocument({ document?, url? }) ties together:
 *   frame/root selection → normalized text + PositionMap → filing-type detection →
 *   section segmentation → metadata → DocumentModel + IngestResult.
 */

import type {
  DocumentModel,
  FilingType,
  IngestResult,
  PageCategory,
  PositionMap,
} from '../../types/index.js';
import { cyrb53 } from '../../lib/hash.js';
import { debugLog } from '../../lib/debug.js';
import { pickFilingRoot, type FilingRoot } from './dom-root.js';
import { buildNormalizedText } from './position-map.js';
import { detectFilingTypeWithConfidence } from './detect.js';
import { extractCompanyMeta } from './meta.js';
import { segmentSections } from './segment.js';
import { assessSegmentationConfidence } from '../segment.js';
import { classifyPage, hostForCategory, isReadableNonFiling } from './classify.js';
import { segmentByHeadings, readablePageName } from './readable.js';
import { extractXbrlFacts } from './xbrl.js';

export interface IngestOptions {
  document?: Document;
  url?: string;
}

export function ingestDocument(opts: IngestOptions = {}): IngestResult {
  const srcDoc = opts.document ?? (globalThis as { document?: Document }).document!;
  const picked = pickFilingRoot(srcDoc);
  const url = opts.url ?? picked.document.location?.href ?? '';

  const category: PageCategory = classifyPage(picked.document, url);
  const host = hostForCategory(category);

  const { positionMap, tableRanges } = buildNormalizedText(picked.root);
  const text = positionMap.text;

  // Readable non-filing pages (sec.gov data/research/info, EDGAR search) bypass
  // the filing path entirely: no registrant required, heading-based sections,
  // named by H1/title, typed as DATA_REPORT.
  if (isReadableNonFiling(category)) {
    return ingestReadablePage(picked, url, host, category, positionMap, tableRanges);
  }

  const detection = detectFilingTypeWithConfidence({
    text,
    doc: picked.document,
    url,
    host,
  });
  const filingType: FilingType = detection.type;

  let sections = segmentSections(text, { filingType, tableRanges });

  const filingTypeConfidence: NonNullable<DocumentModel['filingTypeConfidence']> =
    detection.confidence;
  // Did the segmenter bound the sections sensibly? A mis-bound filing (e.g. an
  // empty Risk-Factors section swallowed by a neighbour) must surface the
  // low-confidence UI even on an authoritative EDGAR page. Assessed on the FORM
  // segmentation, before any heading fallback below, so its semantics are
  // unchanged by the substitution.
  const segmentationConfidence = assessSegmentationConfidence(sections, filingType);

  // Off-SEC financial pages (IR press releases, transcripts, news) rarely carry
  // filing item headers, so form segmentation collapses to one document_body
  // blob. Rebuild sections from DOM headings — the same extractor sec.gov data
  // pages already use — so the Summary tab gets real per-section coverage. The
  // sectionSource marker keeps isLowConfidenceGeneric treating the page as a
  // non-filing (heading sections must not masquerade as form items). EDGAR
  // categories never take this branch.
  let sectionSource: DocumentModel['sectionSource'];
  if (category === 'ir_or_financial' && sections.length <= 1) {
    const headingSections = segmentByHeadings(picked.root, positionMap, tableRanges);
    if (headingSections.length > 1) {
      sections = headingSections;
      sectionSource = 'headings';
    }
  }

  const meta = extractCompanyMeta(picked.document, url);

  // Deterministic fundamentals from the filing's inline XBRL (exact us-gaap/dei
  // facts, no network, no LM). Best-effort: any parse issue leaves xbrl undefined.
  let xbrl;
  try {
    xbrl = extractXbrlFacts(picked.document, positionMap, meta.periodOfReport) ?? undefined;
  } catch (err) {
    debugLog('[Relic] XBRL extraction skipped:', err);
  }

  const model: DocumentModel = {
    source: {
      url,
      host,
      category,
      ...(meta.accessionNo ? { accessionNo: meta.accessionNo } : {}),
      ...(meta.cik ? { cik: meta.cik } : {}),
    },
    ...(meta.ticker ? { ticker: meta.ticker } : {}),
    ...(meta.companyName ? { companyName: meta.companyName } : {}),
    filingType,
    filingTypeConfidence,
    segmentationConfidence,
    ...(sectionSource ? { sectionSource } : {}),
    ...(meta.periodOfReport ? { periodOfReport: meta.periodOfReport } : {}),
    ...(meta.filedAt ? { filedAt: meta.filedAt } : {}),
    sections,
    ...(xbrl ? { xbrl } : {}),
    rawTextHash: cyrb53(text),
  };

  return { model, positionMap, tableRanges };
}

/**
 * Build a DocumentModel for a readable, non-filing page. Document name comes from
 * the H1/title (never a registrant), sections come from DOM headings, and the
 * type is DATA_REPORT so the UI presents a regulatory/data report rather than a
 * company filing with phantom metadata.
 */
function ingestReadablePage(
  picked: FilingRoot,
  url: string,
  host: 'edgar' | 'ir',
  category: PageCategory,
  positionMap: PositionMap,
  tableRanges: ReadonlyArray<[number, number]>,
): IngestResult {
  const text = positionMap.text;
  const sections = segmentByHeadings(picked.root, positionMap, tableRanges);
  const docName = readablePageName(picked.document);

  const model: DocumentModel = {
    source: { url, host, category },
    ...(docName ? { companyName: docName } : {}),
    filingType: 'DATA_REPORT',
    filingTypeConfidence: 'high', // category is authoritative — this IS a data report
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
export { classifyPage } from './classify.js';
