// ============================================================
// Relic — table-aware sentence filtering (shared)
// ------------------------------------------------------------
// Pure, side-effect-free. Sentiment, relevance scoring, and other prose
// pipelines use this to drop sentences that overlap section.tables ranges
// (document-space table regions attached at segmentation time).
//
// Splitting tables out of the prose stream must NOT renumber the surviving
// sentences when downstream code indexes into the ORIGINAL array — each
// survivor carries its original index via IndexedSentence.origIdx.
// ============================================================

export interface IndexedSentence<S> {
  sent: S;
  /** Index into the ORIGINAL (pre-filter) `sentences` array. */
  origIdx: number;
}

/**
 * True when a section-space sentence span overlaps any document-space table range.
 * `charStart` is section.charRange[0].
 */
export function sentenceOverlapsTable(
  range: readonly [number, number],
  charStart: number,
  tables: ReadonlyArray<readonly [number, number]> | undefined,
): boolean {
  if (!tables || tables.length === 0) return false;
  const docStart = charStart + range[0];
  const docEnd = charStart + range[1];
  return tables.some(([ts, te]) => docStart < te && docEnd > ts);
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
    .filter(({ sent }) => !sentenceOverlapsTable(sent.range, charStart, tables));
}
