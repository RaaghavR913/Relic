// ============================================================
// Relic — Prior filing parser (Session 6)
// ------------------------------------------------------------
// Runs in the OFFSCREEN document (which has a real DOM + DOMParser). Turns the
// raw HTML of a prior filing's primary document into a DocumentModel by reusing
// the Session 1 ingestion pipeline against a detached, parsed Document.
//
// We only need the text/sections of the prior filing for diffing, so the prior
// PositionMap (live DOM ranges into a detached doc) is intentionally discarded.
// ============================================================

import type { DocumentModel } from '@/types';
import { ingestDocument } from '@/content/ingest';

/**
 * Parse prior-filing HTML into a DocumentModel.
 * @param html  Raw HTML of the prior filing's primary document.
 * @param url   The EDGAR Archives URL (so host/CIK/accession resolve correctly).
 */
export function parsePriorFiling(html: string, url: string): DocumentModel {
  if (typeof DOMParser === 'undefined') {
    throw new Error('parsePriorFiling requires a DOM context (offscreen document).');
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const { model } = ingestDocument({ document: parsed, url });
  return model;
}
