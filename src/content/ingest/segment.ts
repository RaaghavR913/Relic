/**
 * Section segmentation wrapper for the ingest pipeline.
 * Delegates to src/content/segment.ts and attaches table ranges to sections.
 */

import type { FilingType, Section } from '../../types/index.js';
import { segmentSections as flatSegment } from '../segment.js';

export interface SegmentOptions {
  filingType: FilingType;
  tableRanges?: ReadonlyArray<[number, number]>;
}

export function segmentSections(text: string, opts: SegmentOptions): Section[] {
  const { filingType, tableRanges = [] } = opts;
  // flatSegment attaches overlapping table ranges onto each Section via makeSection,
  // so no separate attach pass is needed here.
  return flatSegment(text, filingType, tableRanges);
}
