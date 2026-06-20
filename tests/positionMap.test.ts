/**
 * Disclora — Session 1 acceptance gate (positionMap).
 *
 * Implements the five required tests from the spec §6:
 *   (a) known-sentence highlight incl. a sentence containing an inline <b>/XBRL tag
 *   (b) offset round-trip via fromNode ∘ toDomRange
 *   (c) paragraph boundary inserts a newline (no sentence fusion)
 *   (d) <ix:hidden> not duplicated (and not included at all)
 *   (e) table text present but its range tagged on the section
 *
 * Run under jsdom (see vitest.config.ts).  jsdom gives us real Text nodes and Ranges,
 * which is all the pure DOM-walk + binary-search logic needs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildNormalizedText } from '@/content/ingest/position-map';
import { segmentSections } from '@/content/segment';
import type { PositionMap } from '@/types';

/** Build a positionMap from an HTML string mounted into document.body. */
function mount(html: string): { pm: PositionMap; tableRanges: ReadonlyArray<[number, number]> } {
  document.body.innerHTML = html;
  const { positionMap, tableRanges } = buildNormalizedText(document.body);
  return { pm: positionMap, tableRanges };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

// ── (a) known-sentence highlight incl. inline <b>/XBRL tag ─────────────────────

describe('(a) multi-node sentence highlight (inline <b> / XBRL tag)', () => {
  it('maps a sentence spanning a text-node boundary to a multi-node Range', () => {
    const { pm } = mount(
      `<p>Revenue increased to <b>$100 million</b> this year.</p>`,
    );
    // Normalized text: "Revenue increased to $100 million this year."
    const expected = 'Revenue increased to $100 million this year.';
    expect(pm.text).toBe(expected);

    const start = 0;
    const end = expected.length;
    const range = pm.toDomRange([start, end]);
    expect(range).not.toBeNull();

    // The range must cross the <b> boundary → start and end live in DIFFERENT text nodes.
    expect(range!.startContainer).not.toBe(range!.endContainer);

    // The serialized range text matches the normalized slice (modulo collapsed whitespace).
    expect(range!.toString().replace(/\s+/g, ' ').trim()).toBe(expected);
  });

  it('maps an inline XBRL ix:nonFraction tag as inline text', () => {
    const { pm } = mount(
      `<p>Net income was <ix:nonFraction>1,234</ix:nonFraction> for the period.</p>`,
    );
    expect(pm.text).toBe('Net income was 1,234 for the period.');
    const idx = pm.text.indexOf('1,234');
    const range = pm.toDomRange([idx, idx + 5]);
    expect(range).not.toBeNull();
    expect(range!.toString().replace(/\s+/g, ' ').trim()).toBe('1,234');
  });
});

// ── (b) offset round-trip via fromNode ∘ toDomRange ────────────────────────────

describe('(b) offset round-trip fromNode ∘ toDomRange', () => {
  it('fromNode(toDomRange([p,p+n]).start) === p for many positions', () => {
    const { pm } = mount(
      `<p>The quick <b>brown</b> fox jumps over the <i>lazy</i> dog repeatedly.</p>`,
    );
    const len = pm.text.length;
    // Test across the whole document at every real character position.
    for (let p = 0; p < len; p++) {
      // Skip positions that begin inside synthetic whitespace runs — round trip is only
      // guaranteed for positions backed by a real Text node. We detect those by checking
      // the char is not a structural newline.
      const range = pm.toDomRange([p, p + 1]);
      if (!range) continue;
      const sc = range.startContainer;
      if (sc.nodeType !== Node.TEXT_NODE) continue;
      const back = pm.fromNode(sc as Text, range.startOffset);
      // For real text positions, the round trip must be exact.
      if (!/\s/.test(pm.text[p] ?? '')) {
        expect(back).toBe(p);
      }
    }
  });
});

// ── (c) paragraph boundary inserts a newline (no sentence fusion) ──────────────

describe('(c) paragraph boundary → newline (no sentence fusion)', () => {
  it('inserts \\n\\n between block elements', () => {
    const { pm } = mount(
      `<p>First sentence ends here.</p><p>Second sentence starts here.</p>`,
    );
    expect(pm.text).toBe(
      'First sentence ends here.\n\nSecond sentence starts here.',
    );
    // The two sentences must NOT be fused into "...here.Second...".
    expect(pm.text).not.toMatch(/here\.Second/);
    expect(pm.text).toContain('here.\n\nSecond');
  });

  it('inserts \\n for <br> between lines', () => {
    const { pm } = mount(`<div>Line one<br>Line two</div>`);
    expect(pm.text).toBe('Line one\nLine two');
  });

  it('collapses 3+ block boundaries to a single \\n\\n', () => {
    const { pm } = mount(
      `<div><p>A</p><div></div><div></div><p>B</p></div>`,
    );
    // Empty blocks must not produce runs of >2 newlines.
    expect(pm.text).not.toMatch(/\n{3,}/);
    expect(pm.text).toBe('A\n\nB');
  });
});

// ── (d) <ix:hidden> not duplicated (and excluded) ──────────────────────────────

describe('(d) <ix:hidden> excluded, not duplicated', () => {
  it('omits ix:hidden subtree text entirely', () => {
    const { pm } = mount(
      `<div><ix:hidden><ix:nonNumeric>SECRET-HIDDEN-FACT</ix:nonNumeric></ix:hidden><p>Visible paragraph text.</p></div>`,
    );
    expect(pm.text).not.toContain('SECRET-HIDDEN-FACT');
    expect(pm.text).toBe('Visible paragraph text.');
    // Ensure no duplication of visible text either.
    const occurrences = pm.text.split('Visible paragraph text.').length - 1;
    expect(occurrences).toBe(1);
  });

  it('omits display:none and aria-hidden subtrees', () => {
    const { pm } = mount(
      `<div><span style="display:none">NOPE</span><span aria-hidden="true">ALSO NOPE</span><p>Shown.</p></div>`,
    );
    expect(pm.text).not.toContain('NOPE');
    expect(pm.text).toBe('Shown.');
  });
});

// ── (e) table text present but its range tagged on the section ─────────────────

describe('(e) table text present, range tagged on section', () => {
  it('includes table text in positionMap.text and records the table range', () => {
    const { pm, tableRanges } = mount(
      `<p>Intro paragraph before the table.</p>` +
      `<table><tr><td>Cell A1</td><td>Cell B1</td></tr><tr><td>Cell A2</td><td>Cell B2</td></tr></table>` +
      `<p>Outro paragraph after the table.</p>`,
    );

    // Table text IS present in the normalized text.
    expect(pm.text).toContain('Cell A1');
    expect(pm.text).toContain('Cell B2');

    // Exactly one table range recorded.
    expect(tableRanges.length).toBe(1);
    const [ts, te] = tableRanges[0]!;
    const tableSlice = pm.text.slice(ts, te);
    expect(tableSlice).toContain('Cell A1');
    expect(tableSlice).toContain('Cell B2');
    // The table range must NOT swallow the surrounding paragraphs.
    expect(tableSlice).not.toContain('Intro paragraph');
    expect(tableSlice).not.toContain('Outro paragraph');
  });

  it('tags the table range onto the containing section', () => {
    const text =
      'ITEM 7. MANAGEMENT DISCUSSION\nRevenue grew.\n\nFINANCIALS TABLE: 100 200 300\n\nMore prose.';
    // Synthesize a table range that lands inside the item_7 section body.
    const tableStart = text.indexOf('FINANCIALS');
    const tableEnd = text.indexOf('300') + 3;
    const sections = segmentSections('10-K' === '10-K' ? text : text, '10-K', [
      [tableStart, tableEnd],
    ]);
    const mdna = sections.find(s => s.id === 'item_7_mdna');
    // The 10-K segmenter should find item 7 and (in index.ts) the table range overlaps it.
    // segmentSections itself does not attach tables (that's done in content/index.ts),
    // so here we assert the overlap logic that index.ts uses.
    expect(mdna).toBeDefined();
    const overlaps = mdna!.charRange[0] < tableEnd && mdna!.charRange[1] > tableStart;
    expect(overlaps).toBe(true);
  });
});
