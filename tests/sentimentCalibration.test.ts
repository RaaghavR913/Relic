import { describe, it, expect } from 'vitest';
import type { LanguageFlag, SentenceSentiment } from '@/types';
import {
  isRiskSectionId,
  dampBoilerplate,
  calibratedCounts,
  baselineAdjustedNet,
  RISK_SECTION_BASELINE_NET,
} from '@/analyst/sentimentCalibration';

function sentence(
  sectionId: string,
  label: SentenceSentiment['label'],
  range: [number, number],
): SentenceSentiment {
  return { sectionId, sentenceIdx: 0, label, score: 0.9, range };
}

function flag(sectionId: string, range: [number, number], boilerplate = true): LanguageFlag {
  return { type: 'uncertainty', range, sectionId, term: 'x', note: '', ...(boilerplate ? { boilerplate: true } : {}) };
}

describe('isRiskSectionId', () => {
  it('matches canonical risk-factors section ids', () => {
    expect(isRiskSectionId('item_1a_risk_factors')).toBe(true);
    expect(isRiskSectionId('part_ii_item_1a_risk_factors')).toBe(true);
  });

  it('does not match unrelated sections', () => {
    expect(isRiskSectionId('item_7_mdna')).toBe(false);
  });
});

describe('dampBoilerplate', () => {
  it('relabels a sentence overlapping a boilerplate flag as neutral', () => {
    const sentiments = [sentence('risk', 'negative', [100, 150])];
    const flags = [flag('risk', [110, 130])];
    const out = dampBoilerplate(sentiments, flags);
    expect(out[0]!.label).toBe('neutral');
  });

  it('leaves a sentence untouched when it does not overlap boilerplate', () => {
    const sentiments = [sentence('risk', 'negative', [100, 150])];
    const flags = [flag('risk', [500, 550])];
    const out = dampBoilerplate(sentiments, flags);
    expect(out[0]!.label).toBe('negative');
  });

  it('ignores non-boilerplate flags even if they overlap', () => {
    const sentiments = [sentence('risk', 'negative', [100, 150])];
    const flags = [flag('risk', [110, 130], false)];
    const out = dampBoilerplate(sentiments, flags);
    expect(out[0]!.label).toBe('negative');
  });

  it('does not mutate the input array or its sentence objects', () => {
    const original = sentence('risk', 'negative', [100, 150]);
    const sentiments = [original];
    const flags = [flag('risk', [110, 130])];
    const out = dampBoilerplate(sentiments, flags);
    expect(original.label).toBe('negative');
    expect(out).not.toBe(sentiments);
  });

  it('is a no-op when there are no boilerplate flags', () => {
    const sentiments = [sentence('risk', 'positive', [0, 10]), sentence('risk', 'negative', [10, 20])];
    const out = dampBoilerplate(sentiments, []);
    expect(out.map((s) => s.label)).toEqual(['positive', 'negative']);
  });
});

describe('calibratedCounts', () => {
  it('excludes boilerplate-damped sentences from the negative/positive tally', () => {
    const sentiments = [
      sentence('risk', 'negative', [0, 20]),   // boilerplate → neutral
      sentence('risk', 'negative', [100, 120]), // real negative
      sentence('risk', 'positive', [200, 220]),
    ];
    const flags = [flag('risk', [0, 20])];
    const counts = calibratedCounts(sentiments, flags);
    expect(counts).toEqual({ positive: 1, negative: 1, neutral: 1, total: 3 });
  });
});

describe('baselineAdjustedNet', () => {
  it('returns the raw net for non-risk sections', () => {
    const counts = { positive: 6, negative: 2, neutral: 2, total: 10 };
    expect(baselineAdjustedNet(counts, 'item_7_mdna')).toBeCloseTo(0.4);
  });

  it('adjusts a risk section net against the typical-risk baseline', () => {
    // Raw net exactly at the baseline should read as ~0 once adjusted.
    const total = 100;
    const negShare = (1 - RISK_SECTION_BASELINE_NET) / 2; // solves pos-neg = baseline for pos+neg=total fraction
    const posShare = negShare + RISK_SECTION_BASELINE_NET;
    const counts = {
      positive: Math.round(posShare * total),
      negative: Math.round(negShare * total),
      neutral: total - Math.round(posShare * total) - Math.round(negShare * total),
      total,
    };
    expect(baselineAdjustedNet(counts, 'item_1a_risk_factors')).toBeCloseTo(0, 1);
  });

  it('reports a risk section as more negative than typical when it exceeds the baseline', () => {
    const counts = { positive: 0, negative: 100, neutral: 0, total: 100 };
    const net = baselineAdjustedNet(counts, 'item_1a_risk_factors');
    expect(net).toBeLessThan(0);
  });

  it('returns 0 for an empty section', () => {
    expect(baselineAdjustedNet({ positive: 0, negative: 0, neutral: 0, total: 0 }, 'item_1a_risk_factors')).toBe(0);
  });
});
