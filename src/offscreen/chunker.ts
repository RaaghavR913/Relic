// ============================================================
// FilingLens — section-aware chunker (Session 2)
// ------------------------------------------------------------
// Splits a DocumentModel into chunks suitable for embedding:
//   - NEVER straddles section boundaries
//   - Target: ~300–400 tokens (~1 200–1 600 chars); hard cap 2 048 chars
//   - Overlap: ~15 % of chunk size (~180–240 chars)
//   - Each chunk carries a DOCUMENT-space charRange (offsets into positionMap.text)
//     so retrieve() results can round-trip through positionMap.toDomRange().
//
// Token counting heuristic: 4.2 chars/token (conservative for financial prose).
// ============================================================

import type { DocumentModel, Section } from '@/types';
import { toDocRange } from '@/lib/docRange';

export interface Chunk {
  chunkId: string;
  sectionId: string;
  /** DOCUMENT-space [start, end) range into positionMap.text (=== section.charRange offset space). */
  charRange: [number, number];
  /** Normalized text of this chunk (trimmed). */
  text: string;
}

// ── tuning ────────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4.2;
const TARGET_TOKENS = 350;
const MAX_TOKENS = 480;
const OVERLAP_TOKENS = 52; // ~15 % of 350

const TARGET_CHARS = Math.round(TARGET_TOKENS * CHARS_PER_TOKEN); // ~1 470
const MAX_CHARS = Math.round(MAX_TOKENS * CHARS_PER_TOKEN);        // ~2 016
const OVERLAP_CHARS = Math.round(OVERLAP_TOKENS * CHARS_PER_TOKEN); // ~218

// Sentence / paragraph boundaries we prefer to split at (highest → lowest priority).
const SPLIT_BOUNDARIES = ['\n\n', '. ', '! ', '? ', '.\n', '\n'];

function findSplitPoint(text: string, fromIdx: number, windowSize: number): number {
  const end = Math.min(fromIdx + windowSize, text.length);
  // Walk backwards from `end` looking for a natural boundary.
  for (const sep of SPLIT_BOUNDARIES) {
    const idx = text.lastIndexOf(sep, end - 1);
    if (idx > fromIdx + Math.floor(windowSize * 0.4)) {
      return idx + sep.length;
    }
  }
  // No good boundary found — hard split at end.
  return end;
}

function chunksForSection(section: Section): Chunk[] {
  const sectionText = section.text;

  if (sectionText.length === 0) return [];

  const chunks: Chunk[] = [];
  let localStart = 0; // offset within sectionText
  let chunkIdx = 0;

  while (localStart < sectionText.length) {
    const remaining = sectionText.length - localStart;

    let localEnd: number;
    let isFinal: boolean;
    if (remaining <= MAX_CHARS) {
      // Final chunk: take everything left, then stop the loop. (Re-entering for the
      // residual tail is what caused the 1-char-advance chunk explosion.)
      localEnd = sectionText.length;
      isFinal = true;
    } else {
      localEnd = findSplitPoint(sectionText, localStart, TARGET_CHARS);
      // Safety: don't exceed MAX_CHARS.
      if (localEnd - localStart > MAX_CHARS) localEnd = localStart + MAX_CHARS;
      // Safety: always advance at least 1 char to avoid infinite loops.
      if (localEnd <= localStart) localEnd = localStart + 1;
      isFinal = localEnd >= sectionText.length;
    }

    // Trim-align: shrink [localStart, localEnd) to the visible run so the stored
    // charRange brackets EXACTLY chunk.text (no leading/trailing whitespace drift).
    let s = localStart;
    let e = localEnd;
    while (s < e && isWs(sectionText[s]!)) s++;
    while (e > s && isWs(sectionText[e - 1]!)) e--;

    if (e > s) {
      chunks.push({
        chunkId: `${section.id}:${chunkIdx}`,
        sectionId: section.id,
        // section-relative [s, e) lifted into DOCUMENT space.
        charRange: toDocRange(section, [s, e]),
        text: sectionText.slice(s, e),
      });
      chunkIdx++;
    }

    if (isFinal) break;

    // Advance with a bounded overlap measured from this chunk's span. Because we break
    // on the final chunk, the residual tail can never trigger a 1-char-advance spiral.
    const advance = Math.max(1, localEnd - localStart - OVERLAP_CHARS);
    localStart += advance;
  }

  return chunks;
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Chunk all sections of a DocumentModel.
 * Sections with fewer than 20 chars of text are silently skipped.
 */
export function chunkDocument(doc: DocumentModel): Chunk[] {
  const all: Chunk[] = [];
  for (const section of doc.sections) {
    if (section.text.trim().length < 20) continue;
    all.push(...chunksForSection(section));
  }
  return all;
}

/**
 * Split text into sequential chunks of at most `maxChars` each, using natural
 * paragraph/sentence boundaries where possible. No overlap — intended for
 * sequential summarization, not embedding retrieval.
 *
 * Returns `[text]` unchanged when `text.length <= maxChars`.
 */
export function splitTextForSummarization(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= maxChars) {
      const chunk = text.slice(start).trim();
      if (chunk.length > 0) chunks.push(chunk);
      break;
    }
    const end = findSplitPoint(text, start, maxChars);
    // Safety: always advance at least 1 char to avoid infinite loops.
    const splitAt = Math.max(end, start + 1);
    const chunk = text.slice(start, splitAt).trim();
    if (chunk.length > 0) chunks.push(chunk);
    start = splitAt;
  }
  return chunks;
}
