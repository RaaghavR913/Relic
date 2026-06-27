// ============================================================
// Relic — gather cached analysis artifacts for export
// ------------------------------------------------------------
// Reads everything Relic has already computed for the current filing out of
// the on-device IndexedDB caches (no recomputation, no network) and hands it to
// the pure report builder in ./report.ts.
//
// Tier note: the analysis + summary stores key on a register ('builtin' when
// Gemini Nano produced the result, otherwise 'extractive'). We don't re-derive
// which tier ran — we read 'builtin' first and fall back to 'extractive', so the
// export picks up whichever the panels actually cached.
// ============================================================

import type { DocumentModel, FilingAnalysis, Section } from '@/types';
import { getCachedAnalysis } from '@/analyst/analysisStore';
import { getCachedSummary, type SummaryEntry } from '@/summarizer/summaryStore';
import { getSentimentCache } from '@/db/sentimentStore';
import { getCachedRedline } from '@/redline/redlineStore';
import type { FilingExportData } from './report';

// Must match FINBERT_MODEL_ID in offscreen.ts / AnalystPanel.tsx (not imported —
// those modules host workers / the panel and must not be pulled in here).
const FINBERT_MODEL_ID = 'Xenova/finbert';

/** Read both registers, preferring the richer builtin result. */
async function bestAnalysis(hash: string): Promise<FilingAnalysis | null> {
  const builtin = await getCachedAnalysis(hash, 'builtin').catch(() => null);
  if (builtin) return builtin;
  return getCachedAnalysis(hash, 'extractive').catch(() => null);
}

async function bestSummary(hash: string, sectionId: string): Promise<SummaryEntry | null> {
  const builtin = await getCachedSummary(hash, sectionId, 'builtin').catch(() => null);
  if (builtin) return builtin;
  return getCachedSummary(hash, sectionId, 'extractive').catch(() => null);
}

/**
 * Collect every cached artifact for `doc` into a FilingExportData. Best-effort:
 * any store that misses or errors simply contributes nothing, so a partial
 * analysis still exports cleanly.
 */
export async function collectFilingExportData(doc: DocumentModel): Promise<FilingExportData> {
  const hash = doc.rawTextHash;
  const orderedSections: Section[] = [...doc.sections].sort((s1, s2) => s1.order - s2.order);

  const [analysis, sentiment, redline] = await Promise.all([
    bestAnalysis(hash),
    getSentimentCache(hash, FINBERT_MODEL_ID).catch(() => null),
    getCachedRedline(hash).catch(() => null),
  ]);

  const summaries: FilingExportData['summaries'] = [];
  for (const section of orderedSections) {
    const entry = await bestSummary(hash, section.id);
    if (entry) summaries.push({ section, entry });
  }

  const appVersion =
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : '';

  return { doc, generatedAt: Date.now(), appVersion, analysis, summaries, sentiment, redline };
}
