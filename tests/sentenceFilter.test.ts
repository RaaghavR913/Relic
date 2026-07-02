// ============================================================
// Relic — regression tests for table-aware sentence filtering
// Bug: sentiment `sentenceIdx` was taken into the post-filter array instead of
// the original `sentences` array, so highlight offsets drifted on any section
// containing a table.
// ============================================================

import { describe, it, expect } from 'vitest';
import { filterNonTableSentences } from '@/lib/sentenceFilter';

interface Sent {
  text: string;
  range: [number, number];
}

describe('filterNonTableSentences', () => {
  it('returns every sentence with sequential origIdx when there are no tables', () => {
    const sentences: Sent[] = [
      { text: 'a', range: [0, 10] },
      { text: 'b', range: [10, 20] },
      { text: 'c', range: [20, 30] },
    ];
    const out = filterNonTableSentences(sentences, 0, undefined);
    expect(out.map((o) => o.origIdx)).toEqual([0, 1, 2]);
    expect(out.map((o) => o.sent.text)).toEqual(['a', 'b', 'c']);

    // An empty tables array behaves the same as "no tables".
    expect(filterNonTableSentences(sentences, 0, []).map((o) => o.origIdx)).toEqual([0, 1, 2]);
  });

  it('preserves original indices when a middle sentence is a table (regression)', () => {
    const charStart = 1000;
    const sentences: Sent[] = [
      { text: 's0', range: [0, 50] },
      { text: 's1-table', range: [50, 120] }, // overlaps the table region
      { text: 's2', range: [120, 200] },
      { text: 's3', range: [200, 260] },
    ];
    // Document-space table range covering s1 only (doc [1050, 1120]).
    const tables: [number, number][] = [[1050, 1120]];

    const out = filterNonTableSentences(sentences, charStart, tables);

    // s1 dropped; survivors keep their ORIGINAL indices (0, 2, 3) — NOT the
    // post-filter positions (0, 1, 2) that caused the drift.
    expect(out.map((o) => o.sent.text)).toEqual(['s0', 's2', 's3']);
    expect(out.map((o) => o.origIdx)).toEqual([0, 2, 3]);
  });

  it('handles multiple interleaved tables', () => {
    const sentences: Sent[] = [
      { text: 'p0', range: [0, 40] },
      { text: 't1', range: [40, 80] },
      { text: 'p2', range: [80, 120] },
      { text: 't3', range: [120, 160] },
      { text: 'p4', range: [160, 200] },
    ];
    // Two table regions covering t1 and t3 (section-space == doc-space here).
    const tables: [number, number][] = [
      [40, 80],
      [120, 160],
    ];
    const out = filterNonTableSentences(sentences, 0, tables);
    expect(out.map((o) => o.sent.text)).toEqual(['p0', 'p2', 'p4']);
    expect(out.map((o) => o.origIdx)).toEqual([0, 2, 4]);
  });
});
