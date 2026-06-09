// ============================================================
// FilingLens — table-aware sentence filtering for sentiment scoring
// ------------------------------------------------------------
// Pure, side-effect-free so it is unit-testable without the offscreen document's
// chrome/worker runtime. Splitting tables out of the prose stream must NOT
// renumber the surviving sentences: downstream `sentenceIdx` values address the
// ORIGINAL sentence array, so each survivor carries its original index.
// ============================================================

export interface IndexedSentence<S> {
  sent: S;
  /** Index into the ORIGINAL (pre-filter) `sentences` array. */
  origIdx: number;
}

/**
 * Keep only sentences that do NOT overlap a table region, preserving each
 * survivor's index into the original `sentences` array.
 *
 * Coordinate spaces: sentence `range`s are SECTION-space; `charStart`
 * (section.charRange[0]) maps them into DOCUMENT space so they can be compared
 * against the document-space `tables` ranges.
 */
export function filterNonTableSentences<S extends { range: [number, number] }>(
  sentences: S[],
  charStart: number,
  tables: ReadonlyArray<readonly [number, number]> | undefined,
): IndexedSentence<S>[] {
  return sentences
    .map((sent, origIdx) => ({ sent, origIdx }))
    .filter(({ sent }) => {
      if (!tables || tables.length === 0) return true;
      const docStart = charStart + sent.range[0];
      const docEnd = charStart + sent.range[1];
      return !tables.some(([ts, te]) => docStart < te && docEnd > ts);
    });
}
