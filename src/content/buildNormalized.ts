/**
 * buildNormalizedText — public entry point for Session 1 document ingestion.
 *
 * Wraps buildPositionMap and also provides toDocRange(), a helper that
 * lifts section-relative or sentence-relative [start, end) ranges to the
 * document-level coordinate space of positionMap.text.
 *
 * Usage:
 *   const { positionMap, tableRanges } = buildNormalizedText(root);
 *   const docRange = toDocRange(section, [0, 50]); // first 50 chars of section
 *   const domRange = positionMap.toDomRange(docRange);
 */

import { buildPositionMap } from './positionMap.js';
import { toDocRange as liftToDocRange } from '../lib/docRange.js';
import type { BuildResult, Section } from '../types/index.js';

export { buildPositionMap };

/** Re-export for consumers who want the clean public name. */
export function buildNormalizedText(root: Element | Document): BuildResult {
  return buildPositionMap(root);
}

/**
 * Lift a section-relative [start, end) byte range to document-space coordinates.
 * Both inputs are offsets within section.text (or within the same section's
 * positionMap.text slice); the return value is ready for positionMap.toDomRange().
 *
 * Example — highlight first sentence of a section:
 *   const docRange = toDocRange(section, [0, firstSentenceLen]);
 *   positionMap.toDomRange(docRange)
 */
export function toDocRange(section: Section, range: [number, number]): [number, number] {
  return liftToDocRange(section, range);
}

/**
 * Convenience: given any [charStart, charEnd) already in document space (e.g. from
 * SentenceSentiment.range which is stored as document-space offsets), pass through
 * unchanged.  Provides a clear name at call sites.
 */
export function docRange(r: [number, number]): [number, number] {
  return r;
}
