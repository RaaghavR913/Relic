/**
 * Form-awareness for Tier 2–5 filings (20-F, 8-K, S-1, DEF 14A, 6-K).
 *
 * Two contracts pinned here:
 *   1. IMPROVEMENT — non-Tier-1 forms get relevance priority, supplemental
 *      keywords, honest document-type labels, and per-form prompt guidance.
 *   2. INERTNESS — 10-K / 10-Q behavior is provably unchanged: identical
 *      priority ranks, the very same KEYWORDS object, and prompts with no
 *      form-guidance block.
 */

import { describe, it, expect } from 'vitest';
import {
  sectionPriority,
  keywordsFor,
  sentenceDimensions,
  KEYWORDS,
} from '@/analyst/relevance';
import { buildStagePrompt, formGuidance, DOC_TYPES } from '@/analyst/prompts';
import { mapDocumentType, deterministicAnalysis } from '@/analyst/deterministic';
import type { AnalysisStage, DocumentModel, FilingType, Section } from '@/types';

function sec(id: string): Section {
  return { id, label: id, order: 1, text: 'Placeholder text.', charRange: [0, 17] };
}

function doc(filingType: FilingType): DocumentModel {
  return {
    source: { url: 'https://www.sec.gov/Archives/edgar/data/1/doc.htm', host: 'edgar', category: 'edgar_filing' },
    companyName: 'Acme Industries, Inc.',
    ticker: 'ACME',
    filingType,
    sections: [],
    rawTextHash: 'hash-form-awareness',
  };
}

const ALL_STAGES: AnalysisStage[] = [
  'snapshot', 'takeaways', 'whatChanged', 'revenue', 'margins',
  'cashflow', 'shares', 'risks', 'narrative', 'synthesis',
];

// ── section priority ──────────────────────────────────────────────────────────

describe('sectionPriority — form-aware ranks', () => {
  it('keeps the exact Tier-1 (10-K/10-Q) ranks — append-only invariant', () => {
    expect(sectionPriority(sec('item_7_mdna'))).toBe(0);
    expect(sectionPriority(sec('item_2_mdna'))).toBe(2);
    expect(sectionPriority(sec('item_1a_risk_factors'))).toBe(3);
    expect(sectionPriority(sec('part_ii_item_1a_risk_factors'))).toBe(5);
    expect(sectionPriority(sec('item_8_financial_statements'))).toBe(6);
    expect(sectionPriority(sec('item_1_business'))).toBe(7);
  });

  it('ranks 20-F investor sections (incl. the 5.x subitems) above unlisted ones', () => {
    const unlisted = sectionPriority(sec('20f_item_2_offer_statistics'));
    expect(sectionPriority(sec('20f_item_5_operating_review'))).toBeLessThan(unlisted);
    expect(sectionPriority(sec('20f_item_5a_operating_results'))).toBeLessThan(unlisted);
    expect(sectionPriority(sec('20f_item_3d_risk_factors'))).toBeLessThan(unlisted);
  });

  it('ranks S-1 offering-economics and DEF 14A compensation sections', () => {
    const unlisted = sectionPriority(sec('s1_experts'));
    expect(sectionPriority(sec('s1_mdna'))).toBeLessThan(unlisted);
    expect(sectionPriority(sec('s1_use_of_proceeds'))).toBeLessThan(unlisted);
    expect(sectionPriority(sec('s1_dilution'))).toBeLessThan(unlisted);
    expect(sectionPriority(sec('proxy_cd_a'))).toBeLessThan(sectionPriority(sec('proxy_notice')));
  });

  it('ranks every 6-K section via the 6k_ catch-all, narrative first', () => {
    const anySixK = sectionPriority(sec('6k_dividend'));
    expect(anySixK).toBeLessThan(sectionPriority(sec('some_random_section')));
    expect(sectionPriority(sec('6k_results'))).toBeLessThan(anySixK);
    expect(sectionPriority(sec('6k_mdna'))).toBeLessThan(anySixK);
  });

  it('ranks the key 8-K items', () => {
    const unlisted = sectionPriority(sec('item_5_05_amendment_code_ethics'));
    expect(sectionPriority(sec('item_2_02_results_of_operations'))).toBeLessThan(unlisted);
    expect(sectionPriority(sec('item_1_01_material_agreements'))).toBeLessThan(unlisted);
    expect(sectionPriority(sec('item_7_01_reg_fd'))).toBeLessThan(unlisted);
  });
});

// ── form-supplemental keywords ────────────────────────────────────────────────

describe('keywordsFor — form supplements', () => {
  it('returns the base KEYWORDS object itself for 10-K / 10-Q / undefined (identity)', () => {
    expect(keywordsFor('10-K')).toBe(KEYWORDS);
    expect(keywordsFor('10-Q')).toBe(KEYWORDS);
    expect(keywordsFor(undefined)).toBe(KEYWORDS);
    expect(keywordsFor('UNKNOWN')).toBe(KEYWORDS);
  });

  it('is stable per form (built once, cached)', () => {
    expect(keywordsFor('DEF 14A')).toBe(keywordsFor('DEF 14A'));
  });

  it('matches proxy compensation vocabulary the base regexes miss', () => {
    const s = 'The committee set base salary and granted PSUs after the say-on-pay vote.';
    expect(KEYWORDS.management.test(s)).toBe(false);
    expect(keywordsFor('DEF 14A').management.test(s)).toBe(true);
  });

  it('keeps the base terms inside the merged regex', () => {
    const s = 'We expect continued momentum in the second half.';
    expect(keywordsFor('DEF 14A').management.test(s)).toBe(true);
  });

  it('matches IFRS phrasing for 20-F / 6-K margins', () => {
    const s = 'Profit for the year rose to 6.0 billion on lower finance costs.';
    expect(KEYWORDS.margins.test(s)).toBe(false);
    expect(keywordsFor('20-F').margins.test(s)).toBe(true);
    expect(keywordsFor('6-K').margins.test(s)).toBe(true);
  });

  it('matches S-1 offering economics under shares/risk', () => {
    const s = 'We intend to use the net proceeds for working capital; the lock-up expires in 180 days.';
    expect(keywordsFor('S-1').shares.test(s)).toBe(true);
    expect(keywordsFor('S-1').risk.test(s)).toBe(true);
  });

  it('sentenceDimensions labels a form-matched sentence when given the filing type', () => {
    const s = 'The peer group informed the annual incentive design and clawback policy.';
    expect(sentenceDimensions(s)).toEqual([]);
    expect(sentenceDimensions(s, 'DEF 14A')).toContain('management');
  });
});

// ── prompt guidance ───────────────────────────────────────────────────────────

describe('formGuidance / buildStagePrompt', () => {
  it('adds NO form note for 10-K or 10-Q at any stage (Tier-1 prompts unchanged)', () => {
    for (const ft of ['10-K', '10-Q'] as const) {
      for (const stage of ALL_STAGES) {
        expect(formGuidance(ft, stage)).toBe('');
        const p = buildStagePrompt(stage, doc(ft), 'Excerpts.');
        expect(p).not.toContain('Form note:');
        // Nor the general-financial-page framing (middle tier) — EDGAR filings
        // must always be presented to the model as their real form.
        expect(p).not.toContain('general financial web page');
      }
    }
    // Head shape is untouched: TASK line, then the doc header, then the body.
    const p = buildStagePrompt('snapshot', doc('10-K'), 'Excerpts.');
    expect(p.startsWith('TASK: snapshot\nCompany: Acme Industries, Inc. · Ticker: ACME · Filing type (detected): 10-K\n')).toBe(true);
  });

  it('scopes 8-K guidance to snapshot/takeaways/risks', () => {
    expect(buildStagePrompt('snapshot', doc('8-K'), 'x')).toContain('8-K current report');
    expect(buildStagePrompt('risks', doc('8-K'), 'x')).toContain('8-K current report');
    expect(buildStagePrompt('margins', doc('8-K'), 'x')).not.toContain('Form note:');
  });

  it('adds IFRS guidance on every 20-F / 6-K stage', () => {
    for (const ft of ['20-F', '6-K'] as const) {
      expect(buildStagePrompt('margins', doc(ft), 'x')).toContain('IFRS');
      expect(buildStagePrompt('snapshot', doc(ft), 'x')).toContain('non-USD');
    }
  });

  it('scopes S-1 guidance to takeaways/shares/risks', () => {
    expect(buildStagePrompt('shares', doc('S-1'), 'x')).toContain('IPO registration');
    expect(buildStagePrompt('revenue', doc('S-1'), 'x')).not.toContain('Form note:');
  });

  it('scopes DEF 14A guidance to takeaways/risks/narrative', () => {
    expect(buildStagePrompt('takeaways', doc('DEF 14A'), 'x')).toContain('proxy statement');
    expect(buildStagePrompt('narrative', doc('DEF 14A'), 'x')).toContain('pay-for-performance');
    expect(buildStagePrompt('revenue', doc('DEF 14A'), 'x')).not.toContain('Form note:');
  });
});

// ── honest document types ─────────────────────────────────────────────────────

describe('document-type labels', () => {
  it('maps every form to its real name', () => {
    expect(mapDocumentType('10-K')).toBe('10-K');
    expect(mapDocumentType('10-Q')).toBe('10-Q');
    expect(mapDocumentType('8-K')).toBe('8-K');
    expect(mapDocumentType('20-F')).toBe('20-F');
    expect(mapDocumentType('6-K')).toBe('6-K');
    expect(mapDocumentType('S-1')).toBe('S-1');
    expect(mapDocumentType('DEF 14A')).toBe('Proxy Statement');
    expect(mapDocumentType('UNKNOWN')).toBe('Other');
    expect(mapDocumentType('DATA_REPORT')).toBe('Other');
  });

  it('exposes the new labels in the snapshot schema enum', () => {
    for (const t of ['20-F', '6-K', 'S-1', 'Proxy Statement']) {
      expect(DOC_TYPES).toContain(t);
    }
  });

  it('deterministic snapshot uses the per-form key question and horizon', () => {
    const twentyF = deterministicAnalysis(doc('20-F'), {});
    expect(twentyF.documentType).toBe('20-F');
    expect(twentyF.investorSnapshot.timeHorizon).toBe('Long-term');
    expect(twentyF.investorSnapshot.mostImportantInvestorQuestion).toMatch(/prior year/);

    const proxy = deterministicAnalysis(doc('DEF 14A'), {});
    expect(proxy.documentType).toBe('Proxy Statement');
    expect(proxy.investorSnapshot.mostImportantInvestorQuestion).toMatch(/pay aligned with performance/);

    const s1 = deterministicAnalysis(doc('S-1'), {});
    expect(s1.documentType).toBe('S-1');
    expect(s1.investorSnapshot.mostImportantInvestorQuestion).toMatch(/dilution/);
  });
});
