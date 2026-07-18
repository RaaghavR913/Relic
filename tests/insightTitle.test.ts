/**
 * Insight titles must be topic labels unique to each card — never truncated
 * body text, never PDF chrome ("28 Table of Contents …").
 */
import { describe, it, expect } from 'vitest';
import {
  ensureInsightTitle,
  isBadInsightTitle,
  topicTitleFromText,
  stripFilingNoise,
} from '@/analyst/insightTitle';
import { finalizeInsight } from '@/analyst/evidence';
import type { DocumentModel, FilingInsight, Section } from '@/types';

function section(id: string, label: string, text: string): Section {
  return { id, label, order: 1, text, charRange: [0, text.length] };
}

function docWith(text: string): DocumentModel {
  return {
    source: { url: 'https://www.sec.gov/x', host: 'edgar', category: 'edgar_filing' },
    filingType: '10-Q',
    filingTypeConfidence: 'high',
    sections: [section('item_1a_risk_factors', 'Risk Factors', text)],
    rawTextHash: 't',
  };
}

const base: Omit<FilingInsight, 'title' | 'summary'> = {
  label: 'Watch Item',
  category: 'Risk',
  whyItMatters: 'x',
  investorMeaning: 'y',
  severity: 'Medium',
  timeHorizon: 'Medium-term',
  confidence: 'Medium',
};

describe('insightTitle', () => {
  it('strips Table of Contents page-header chrome', () => {
    const raw =
      '28 Table of Contents We continue to monitor the environment for potential impacts on supply and demand.';
    expect(stripFilingNoise(raw)).toMatch(/^We continue to monitor/);
    expect(stripFilingNoise(raw)).not.toMatch(/Table of Contents/);
  });

  it('flags truncated body prefixes and TOC titles as bad', () => {
    const summary =
      '28 Table of Contents We continue to monitor the environment for potential impacts on supply and demand.';
    expect(isBadInsightTitle('28 Table of Contents We continue to monitor the environment for...', summary)).toBe(true);
    expect(
      isBadInsightTitle(
        'May 2, 2026 consisted of approximately $3.8 billion of cash and cas',
        'See also Part II. Liquidity. May 2, 2026 consisted of approximately $3.8 billion of cash and cash equivalents.',
      ),
    ).toBe(true);
    expect(isBadInsightTitle('Supply & demand conditions', summary)).toBe(false);
  });

  it('builds topic labels for the NVIDIA-style risk cards in the bug report', () => {
    expect(
      topicTitleFromText(
        '28 Table of Contents We continue to monitor the environment for potential impacts on supply and demand.',
        'Risk',
      ),
    ).toBe('Supply & demand conditions');

    expect(
      topicTitleFromText(
        'Liquidity and Capital Resources Our principal source of liquidity as of May 2, 2026 consisted of approximately $3.8 billion of cash and cash equivalents.',
        'Risk',
      ),
    ).toMatch(/Liquidity position/);

    expect(
      topicTitleFromText(
        '34 Table of Contents Future payment of a regular quarterly cash dividend on our common and preferred stock is subject to declaration.',
        'Risk',
      ),
    ).toBe('Dividend policy');
  });

  it('rewrites a quoted LM title via ensureInsightTitle', () => {
    const summary =
      '28 Table of Contents We continue to monitor the environment for potential impacts on supply and demand.';
    const fixed = ensureInsightTitle(
      '28 Table of Contents We continue to monitor the environment for...',
      summary,
      'Risk',
    );
    expect(fixed).toBe('Supply & demand conditions');
    expect(summary.toLowerCase().startsWith(fixed.toLowerCase())).toBe(false);
  });
});

describe('finalizeInsight title guard (all analyst sections)', () => {
  it('rewrites prefix-of-body titles before they reach the UI', () => {
    const summary =
      '34 Table of Contents Future payment of a regular quarterly cash dividend on our common stock is subject to declaration by the Board.';
    const ins = finalizeInsight(docWith(summary), {
      ...base,
      title: '34 Table of Contents Future payment of a regular quarterly cash...',
      summary,
    });
    expect(ins).not.toBeNull();
    expect(ins!.title).toBe('Dividend policy');
    expect(ins!.title).not.toMatch(/Table of Contents/);
    expect(summary.toLowerCase().startsWith(ins!.title.toLowerCase())).toBe(false);
  });
});
