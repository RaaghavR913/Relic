// ============================================================
// FilingLens — Ask-the-filing retrieval client (Session 7)
// ------------------------------------------------------------
// Thin side-panel wrapper over Session 2's SW message bus: ensures the RAG index
// exists (BUILD_INDEX is idempotent — skips if already embedded) and runs a
// top-k retrieve(). Both tiers share this; only the synthesis step differs.
// ============================================================

import type { DocumentModel, Section } from '@/types';
import type {
  BuildIndexMsg,
  RetrieveMsg,
  IndexResponse,
  RetrieveResponse,
  RetrievalResult,
  HighlightRangeMsg,
  ClearHighlightsMsg,
} from '@/messages/types';
import type { QaPassage } from './synthesize';

/** Build (or confirm) the vector index for this filing. Returns chunk count. */
export async function ensureIndex(doc: DocumentModel): Promise<number> {
  const msg: BuildIndexMsg = { target: 'sw', type: 'BUILD_INDEX', doc };
  const resp = (await chrome.runtime.sendMessage(msg)) as IndexResponse;
  if (!resp.ok) throw new Error(resp.error);
  return resp.chunkCount;
}

/** Retrieve the top-k passages for a query. */
export async function retrievePassages(
  rawTextHash: string,
  query: string,
  k: number,
): Promise<RetrievalResult[]> {
  const msg: RetrieveMsg = { target: 'sw', type: 'RETRIEVE', rawTextHash, query, k };
  const resp = (await chrome.runtime.sendMessage(msg)) as RetrieveResponse;
  if (!resp.ok) throw new Error(resp.error);
  return resp.results;
}

/** Attach human-readable section labels so citations read naturally. */
export function toPassages(results: RetrievalResult[], sections: Section[]): QaPassage[] {
  const labelById = new Map(sections.map((s) => [s.id, s.label]));
  return results.map((r) => ({
    ...r,
    sectionLabel: labelById.get(r.sectionId) ?? r.sectionId.replace(/_/g, ' '),
  }));
}

// ── on-page deep-linking (via positionMap, routed through the SW) ─────────────

/** Highlight a document-space char range in the filing and scroll it into view. */
export async function highlightInFiling(charRange: [number, number]): Promise<void> {
  const msg: HighlightRangeMsg = { target: 'sw', type: 'HIGHLIGHT_RANGE', charRange };
  await chrome.runtime.sendMessage(msg).catch(() => {});
}

export async function clearFilingHighlights(): Promise<void> {
  const msg: ClearHighlightsMsg = { target: 'sw', type: 'CLEAR_HIGHLIGHTS' };
  await chrome.runtime.sendMessage(msg).catch(() => {});
}
