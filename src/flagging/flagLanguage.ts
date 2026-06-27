// ============================================================
// Relic — Hedging/uncertainty language flagging (Session 5)
// ------------------------------------------------------------
// flagSection()     → scan one section's normalised text → LanguageFlag[]
// flagAllSections() → scan all sections, return in document order
//
// INVARIANT: all ranges in returned LanguageFlag[] are DOCUMENT-space
// (offsets into positionMap.text). Never return section-space ranges.
//
// Privacy: runs entirely on-device, no text leaves the machine.
// ============================================================

import type { Section, LanguageFlag, PositionMap } from '@/types';
import { loadCompiledLexicons, type FlagType, type LexiconOverrides } from './lexiconLoader';
import { splitSentences } from '@/summarizer/extractive';

// ── helpers ───────────────────────────────────────────────────────────────────

/** True when [start, end) falls entirely inside one of the table regions. */
function inTable(start: number, end: number, tables: ReadonlyArray<[number, number]>): boolean {
  return tables.some(([ts, te]) => start >= ts && end <= te);
}

// Forward-looking / safe-harbor boilerplate copied into nearly every filing. A
// match whose sentence reads as this disclaimer carries low marginal signal.
const BOILERPLATE_RE =
  /(forward[- ]looking statements?|private securities litigation reform act|safe[- ]harbor|within the meaning of section 27a|undertake no (?:obligation|duty) to (?:update|revise)|actual results (?:could|may|might) differ materially|these forward-looking statements)/i;

/** Section-space char ranges of sentences that read as safe-harbor boilerplate. */
function boilerplateRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const s of splitSentences(text)) {
    if (BOILERPLATE_RE.test(s.text)) ranges.push(s.range);
  }
  return ranges;
}

/** True when `pos` falls inside one of the (section-space) boilerplate ranges. */
function inBoilerplate(pos: number, ranges: ReadonlyArray<[number, number]>): boolean {
  return ranges.some(([a, b]) => pos >= a && pos < b);
}

// ── core ──────────────────────────────────────────────────────────────────────

/**
 * Scan a single section's normalised text for hedging/uncertainty language.
 *
 * Matching is word-boundary-aware and multi-word phrase aware (handled by the
 * compiled regexes in lexiconLoader). Each hit is lifted from section-space
 * into document-space via positionMap.toDocRange() before being returned.
 *
 * Table regions (section.tables) are excluded: a match that falls entirely
 * within a table row is dropped because financial tables are expected to
 * contain many of these terms in context (e.g. "net loss" column headers).
 *
 * @param section     Section with normalised text and document-space charRange.
 * @param positionMap Shared PositionMap — used only for toDocRange() lifting.
 * @param overrides   Optional Pro custom dictionary additions.
 * @returns LanguageFlag[] sorted ascending by document-space range start.
 */
export function flagSection(
  section: Section,
  positionMap: PositionMap,
  overrides?: LexiconOverrides,
): LanguageFlag[] {
  if (!section.text) return [];

  const lexicons = loadCompiledLexicons(overrides);
  const tables   = section.tables ?? [];
  const bpRanges = boilerplateRanges(section.text);
  const flags: LanguageFlag[] = [];

  for (const type of Object.keys(lexicons) as FlagType[]) {
    for (const entry of lexicons[type]!) {
      // Reset lastIndex before each exec loop — regex has 'g' flag.
      entry.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = entry.regex.exec(section.text)) !== null) {
        const secStart = match.index;
        const secEnd   = secStart + match[0].length;

        // Lift to document-space BEFORE table exclusion (table ranges are doc-space).
        const docRange = positionMap.toDocRange(section, [secStart, secEnd]);

        if (inTable(docRange[0], docRange[1], tables)) continue;

        flags.push({
          type,
          range:     docRange,
          sectionId: section.id,
          term:      match[0],
          note:      entry.note,
          // Marked, not dropped: callers retain boilerplate flags but hide them
          // from the on-page overlay by default (low marginal signal).
          ...(inBoilerplate(secStart, bpRanges) ? { boilerplate: true } : {}),
        });
      }
    }
  }

  // Sort by document-space position for deterministic, document-order output.
  flags.sort((a, b) => a.range[0] - b.range[0]);
  return flags;
}

/**
 * Scan all sections in a document and return flags in document order.
 *
 * Sections may be passed in any order; results are always sorted by the
 * document-space position of each flag's matched term.
 *
 * @param sections    All sections from the DocumentModel.
 * @param positionMap Shared PositionMap for the document.
 * @param overrides   Optional Pro custom dictionary additions.
 */
export function flagAllSections(
  sections: ReadonlyArray<Section>,
  positionMap: PositionMap,
  overrides?: LexiconOverrides,
): LanguageFlag[] {
  const sorted = [...sections].sort((a, b) => a.order - b.order);
  const all: LanguageFlag[] = [];
  for (const section of sorted) {
    for (const flag of flagSection(section, positionMap, overrides)) {
      all.push(flag);
    }
  }
  // Individual sections are already sorted; merge-preserve overall document order.
  return all;
}

// ── Extension point ───────────────────────────────────────────────────────────
//
// ML_CLASSIFIER_EXTENSION_POINT (Pro — not implemented):
//
// After flagAllSections(), pass the output through an ML classifier to suppress
// boilerplate matches that appear in every filing and carry low marginal signal
// (e.g. generic safe-harbor paragraphs copied from legal templates).
//
// Suggested Pro interface:
//
//   async function filterBoilerplate(
//     flags:       LanguageFlag[],
//     doc:         DocumentModel,
//     positionMap: PositionMap,
//     session:     OnnxSession,           // downloaded on Pro activation only
//   ): Promise<Array<LanguageFlag & { boilerplate: boolean }>>
//
// The classifier would run inside a Web Worker via Transformers.js, consistent
// with the encoder architecture (Session 2). It must NEVER send text off-device.
// Boilerplate-flagged items are hidden in the UI but retained in AnalysisArtifacts
// so the side panel can offer a "show boilerplate" toggle.
//
// ─────────────────────────────────────────────────────────────────────────────
