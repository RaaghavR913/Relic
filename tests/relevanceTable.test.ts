/**
 * Relevance scoring must exclude tabular text — the same table regions that
 * sentiment and flagging skip. Otherwise flattened HTML tables (one cell per
 * line) score highly on numeric keywords and become deterministic insight cards.
 */

import { describe, it, expect } from 'vitest';
import { scoreSentences, topRelevantSentences } from '@/analyst/relevance';
import type { DocumentModel, Section } from '@/types';

const PROSE =
  'Net income increased during the quarter as operating income grew and margins expanded across our core segments.';

/** Flattened MD&A table: block tags become double-newlines at ingest time. */
const TABLE_TEXT = [
  'Total Other Income, Net',
  'Three Months Ended',
  'Apr 26, 2026',
  'Apr 27, 2025',
  'Change',
  '($ in millions)',
  'Interest income',
  '$',
  '540',
  '$',
  '515',
  '$',
  '25',
  'Interest expense',
  '(102)',
  '(63)',
  '(39)',
].join('\n\n');

function mdnaSection(text: string, tables?: Section['tables']): Section {
  const section: Section = {
    id: 'item_2_mdna',
    label: "Management's Discussion and Analysis",
    order: 2,
    text,
    charRange: [0, text.length],
  };
  if (tables) section.tables = tables;
  return section;
}

function doc(section: Section): DocumentModel {
  return {
    source: { url: 'https://www.sec.gov/x.htm', host: 'edgar' },
    companyName: 'Example Corp',
    filingType: '10-Q',
    sections: [section],
    rawTextHash: 'relevance-table-test',
  };
}

describe('scoreSentences — table exclusion', () => {
  it('does not surface flattened table text when section.tables tags the region', () => {
    const combined = `${PROSE}\n\n${TABLE_TEXT}`;
    const tableStart = combined.indexOf('Total Other Income');
    const tables: [number, number][] = [[tableStart, combined.length]];
    const model = doc(mdnaSection(combined, tables));

    const scored = scoreSentences(model, ['margins', 'cashflow']);
    const texts = scored.map((s) => s.text);

    expect(texts.some((t) => t.includes('Total Other Income, Net'))).toBe(false);
    expect(texts.some((t) => t.includes('Interest income') && t.includes('540'))).toBe(false);
    expect(texts.some((t) => t.includes('Net income increased'))).toBe(true);
  });

  it('topRelevantSentences never returns a table-overlapping span', () => {
    const combined = `${PROSE}\n\n${TABLE_TEXT}`;
    const tableStart = combined.indexOf('Total Other Income');
    const model = doc(mdnaSection(combined, [[tableStart, combined.length]]));

    const top = topRelevantSentences(model, ['margins'], 5);
    for (const s of top) {
      expect(s.text).not.toMatch(/^\$\s*$/);
      expect(s.text).not.toContain('Three Months Ended');
    }
  });
});
