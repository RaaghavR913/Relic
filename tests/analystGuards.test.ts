/**
 * FilingLens — Analyst guard-rail unit tests: evidence verification,
 * advice scrubbing, and relevance-driven excerpt selection.
 */

import { describe, it, expect } from 'vitest';
import type { DocumentModel, Section } from '@/types';
import { verifyEvidence, scrubAdvice } from '@/analyst/evidence';
import { selectRelevantText, selectOverviewText, splitSentences } from '@/analyst/relevance';

function docWith(sections: Array<Pick<Section, 'id' | 'label' | 'text'>>): DocumentModel {
  let offset = 0;
  const built: Section[] = sections.map((s, i) => {
    const sec: Section = {
      id: s.id, label: s.label, order: i, text: s.text,
      charRange: [offset, offset + s.text.length],
    };
    offset += s.text.length + 1;
    return sec;
  });
  return {
    source: { url: 'https://www.sec.gov/x', host: 'edgar' },
    filingType: '10-K',
    sections: built,
    rawTextHash: 'h',
  };
}

// ── verifyEvidence ───────────────────────────────────────────────────────────

describe('verifyEvidence', () => {
  const doc = docWith([
    { id: 'a', label: 'A', text: 'Preamble text here. Revenue increased 15% to $4.2 billion in fiscal 2025.' },
    { id: 'b', label: 'B', text: 'Gross margin — under pressure — contracted to 41% during the year.' },
  ]);

  it('finds an exact quote and returns a DOCUMENT-space range', () => {
    const m = verifyEvidence(doc, 'Revenue increased 15% to $4.2 billion');
    expect(m).not.toBeNull();
    expect(m!.sectionId).toBe('a');
    const sec = doc.sections[0]!;
    expect(sec.text.slice(m!.range[0] - sec.charRange[0], m!.range[1] - sec.charRange[0]))
      .toBe('Revenue increased 15% to $4.2 billion');
  });

  it('offsets ranges for later sections', () => {
    const m = verifyEvidence(doc, 'contracted to 41% during the year');
    expect(m).not.toBeNull();
    expect(m!.sectionId).toBe('b');
    expect(m!.range[0]).toBeGreaterThanOrEqual(doc.sections[1]!.charRange[0]);
  });

  it('tolerates whitespace and dash variants', () => {
    expect(verifyEvidence(doc, 'Gross margin - under  pressure - contracted')).not.toBeNull();
  });

  it('rejects fabricated quotes and too-short quotes', () => {
    expect(verifyEvidence(doc, 'Revenue reached $99 trillion this quarter')).toBeNull();
    expect(verifyEvidence(doc, 'Revenue')).toBeNull();
  });
});

// ── scrubAdvice ──────────────────────────────────────────────────────────────

describe('scrubAdvice', () => {
  it('removes direct-advice sentences, keeps analysis', () => {
    const out = scrubAdvice('Margins fell five points. You should sell the stock now. Revenue grew 15%.');
    expect(out).not.toMatch(/sell the stock/);
    expect(out).toMatch(/Margins fell/);
    expect(out).toMatch(/Revenue grew/);
  });

  it('removes price predictions', () => {
    expect(scrubAdvice('The stock will go up after this report.')).toBe('');
    expect(scrubAdvice('We recommend buying before earnings.')).toBe('');
  });

  it('does not scrub business language or careful analyst phrasing', () => {
    const business = 'The company sells products to enterprises and bought back shares.';
    expect(scrubAdvice(business)).toBe(business);
    const careful = 'This may be viewed positively by investors because margins expanded.';
    expect(scrubAdvice(careful)).toBe(careful);
  });
});

// ── relevance selection ──────────────────────────────────────────────────────

describe('selectRelevantText', () => {
  const doc = docWith([
    {
      id: 'item_7_mdna', label: 'MD&A',
      text:
        'Total revenue increased 15% to $4.2 billion driven by data-center demand growing rapidly. ' +
        'The weather in Boise was unremarkable throughout the reporting period in question. ' +
        'Gross margin contracted to 41% from 46% reflecting elevated input costs this year. ' +
        'Cash flow from operating activities was $890 million for the full fiscal year period.',
    },
  ]);

  it('selects only sentences matching the dimension keywords', () => {
    const out = selectRelevantText(doc, ['revenue'], 2000);
    expect(out).toMatch(/revenue increased 15%/i);
    expect(out).not.toMatch(/weather in Boise/);
    expect(out).not.toMatch(/Cash flow from operating/);
  });

  it('returns empty string when nothing matches (sparse doc gate)', () => {
    const sparse = docWith([
      { id: 'x', label: 'X', text: 'Signature of the reporting person was provided on the form.' },
    ]);
    expect(selectRelevantText(sparse, ['cashflow'], 2000)).toBe('');
  });

  it('respects the character budget', () => {
    const out = selectRelevantText(doc, ['revenue', 'margins', 'cashflow'], 120);
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

describe('selectOverviewText / splitSentences', () => {
  it('labels section leads and respects the cap', () => {
    const doc = docWith([
      { id: 'item_7_mdna', label: 'MD&A', text: 'A'.repeat(5000) },
      { id: 'item_1a_risk', label: 'Risks', text: 'B'.repeat(5000) },
    ]);
    const out = selectOverviewText(doc, 1200);
    expect(out).toMatch(/\[MD&A\]/);
    expect(out.length).toBeLessThanOrEqual(1400); // cap + labels/ellipses headroom
  });

  it('splitSentences drops fragments and over-long runs', () => {
    const sents = splitSentences('Short. This sentence is comfortably long enough to be kept by the splitter. ' + 'C'.repeat(700) + '.');
    expect(sents).toHaveLength(1);
  });
});
