// ============================================================
// Disclora — section/sentence → DOCUMENT-space range lift.
// ------------------------------------------------------------
// The single sanctioned way to convert a [start, end) range that is relative to a
// Section (or any base offset) into DOCUMENT space (offsets into positionMap.text),
// ready for positionMap.toDomRange(). Centralised here so the PositionMap method, the
// ingest façade, and the chunker all share one implementation.
// ============================================================

import type { Section } from '../types/index.js';

/**
 * Lift a section-relative (or base-relative) [start, end) range into DOCUMENT space.
 * `base` is either a Section (uses its charRange[0]) or a raw base offset.
 */
export function toDocRange(
  base: Section | number,
  range: [number, number],
): [number, number] {
  const origin = typeof base === 'number' ? base : base.charRange[0];
  return [origin + range[0], origin + range[1]];
}
