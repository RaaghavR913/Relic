/**
 * Disclora — Session 2 chunker regression gates.
 *
 * Locks in the two bugs found in the audit:
 *   1. No trailing-chunk explosion (advance never collapses to a 1-char spiral).
 *   2. chunk.charRange is trim-aligned with chunk.text (no whitespace/off-by drift),
 *      so retrieve() provenance round-trips cleanly through positionMap.toDomRange().
 */

import { describe, it, expect } from 'vitest';
import { chunkDocument, splitTextForSummarization } from '@/offscreen/chunker';
import type { DocumentModel, Section } from '@/types';

function model(sections: Section[]): DocumentModel {
  return {
    source: { url: 'https://www.sec.gov/x', host: 'edgar' },
    filingType: '10-K',
    sections,
    rawTextHash: 'deadbeef',
  };
}

describe('chunker — no trailing-chunk explosion', () => {
  it('a ~3,000-char section yields a handful of chunks, not hundreds', () => {
    const para =
      'The Company faces competition across all markets in which it operates and competition may intensify. ';
    const body = para.repeat(30).trim(); // ~3,000 chars, no internal block boundaries
    const sections: Section[] = [
      { id: 'item_1a_risk_factors', label: 'Risk', order: 20, text: body, charRange: [0, body.length] },
    ];
    const chunks = chunkDocument(model(sections));

    // Before the fix this produced ~220 chunks. A sane chunker emits only a few.
    expect(chunks.length).toBeLessThan(8);
    expect(chunks.length).toBeGreaterThan(0);

    // No degenerate fragments like ".", "y.", "fy." (the old tail spiral).
    expect(chunks.every((c) => c.text.length >= 20)).toBe(true);
  });

  it('a short section produces exactly one chunk', () => {
    const body = 'Short risk paragraph that is well under the target size.';
    const sections: Section[] = [
      { id: 'item_1a_risk_factors', label: 'Risk', order: 20, text: body, charRange: [100, 100 + body.length] },
    ];
    const chunks = chunkDocument(model(sections));
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe(body);
  });
});

describe('chunker — charRange is trim-aligned with chunk.text (document space)', () => {
  it('every chunk charRange brackets exactly its text', () => {
    // Build a multi-paragraph section with leading/trailing whitespace per paragraph.
    const docText =
      '   leading pad   ' +
      Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} discusses customers and revenue concentration in detail.`).join('\n\n');
    const sectionStart = 17; // pretend the section begins after some document prefix
    const full = 'x'.repeat(sectionStart) + docText;
    const sections: Section[] = [
      { id: 'item_7_mdna', label: 'MD&A', order: 90, text: docText.trim(), charRange: [sectionStart, full.length] },
    ];
    const chunks = chunkDocument(model(sections));
    expect(chunks.length).toBeGreaterThan(1);

    const sectionText = sections[0]!.text;
    const base = sections[0]!.charRange[0];
    for (const c of chunks) {
      // 1. charRange is within the section bounds.
      expect(c.charRange[0]).toBeGreaterThanOrEqual(base);
      expect(c.charRange[1]).toBeLessThanOrEqual(base + sectionText.length);
      // 2. The slice of the section text at the (section-relative) range equals chunk.text.
      const rel: [number, number] = [c.charRange[0] - base, c.charRange[1] - base];
      expect(sectionText.slice(rel[0], rel[1])).toBe(c.text);
      // 3. No leading/trailing whitespace on the stored text.
      expect(c.text).toBe(c.text.trim());
    }
  });

  it('consecutive chunks overlap (context continuity) without duplicating', () => {
    const para = 'Customer concentration remained significant during the period under review. ';
    const body = para.repeat(40).trim();
    const sections: Section[] = [
      { id: 'item_7_mdna', label: 'MD&A', order: 90, text: body, charRange: [0, body.length] },
    ];
    const chunks = chunkDocument(model(sections));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      // Overlap: each chunk starts before the previous one ends.
      expect(chunks[i]!.charRange[0]).toBeLessThan(chunks[i - 1]!.charRange[1]);
      // But it still advances.
      expect(chunks[i]!.charRange[0]).toBeGreaterThan(chunks[i - 1]!.charRange[0]);
    }
  });
});

// ── splitTextForSummarization ─────────────────────────────────────────────────

describe('splitTextForSummarization', () => {
  it('returns the original text as a single-element array when under cap', () => {
    const text = 'Short text.';
    const chunks = splitTextForSummarization(text, 8_000);
    expect(chunks).toEqual([text]);
  });

  it('returns a single element for text exactly at the cap', () => {
    const text = 'x'.repeat(8_000);
    expect(splitTextForSummarization(text, 8_000)).toHaveLength(1);
  });

  it('splits text over the cap into multiple chunks', () => {
    // 24,000 chars → at least 3 chunks under an 8,000-char cap
    const para = 'The company faces competition and regulatory risk across all its markets. ';
    const text = para.repeat(340).trim(); // ~24,480 chars
    const chunks = splitTextForSummarization(text, 8_000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // No chunk exceeds the cap
    expect(chunks.every((c) => c.length <= 8_000)).toBe(true);
  });

  it('reconstructed chunks contain all content from the original (no loss)', () => {
    const para = 'Risk factors include supply chain disruption and currency headwinds. ';
    const text = para.repeat(200).trim(); // ~13,800 chars
    const chunks = splitTextForSummarization(text, 8_000);
    // The joined chunks should contain all non-whitespace content.
    const original = text.replace(/\s+/g, ' ');
    const rejoined = chunks.join(' ').replace(/\s+/g, ' ');
    expect(rejoined).toBe(original);
  });

  it('no chunk is empty', () => {
    const text = '\n\n'.repeat(5) + 'Significant risk factors exist. '.repeat(500).trim();
    const chunks = splitTextForSummarization(text, 8_000);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it('prefers splitting at paragraph boundaries over mid-sentence', () => {
    // Build text where there is a clear \n\n boundary near the target split point.
    const firstPara = 'A'.repeat(7_900) + '\n\n';
    const secondPara = 'B'.repeat(7_900);
    const text = firstPara + secondPara;
    const chunks = splitTextForSummarization(text, 8_000);
    // Should produce exactly 2 chunks; the first ends at the paragraph break
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('A'.repeat(7_900));
    expect(chunks[1]).toBe('B'.repeat(7_900));
  });
});
