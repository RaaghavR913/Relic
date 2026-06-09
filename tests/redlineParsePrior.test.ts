// ============================================================
// FilingLens — Session 6 tests: prior parse → align → diff (integration)
// ------------------------------------------------------------
// Exercises the real ingest pipeline on two synthetic 10-K documents and
// confirms a new risk factor is detected as added and a dropped one as removed.
// ============================================================

import { describe, it, expect } from 'vitest';
import { parsePriorFiling } from '../src/redline/parsePrior';
import { alignSections } from '../src/redline/align';
import { diffSection } from '../src/redline/diff';

const URL = 'https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm';

function tenK(riskParagraph: string): string {
  return `<!doctype html><html><head><title>Acme Corp 10-K</title></head><body>
    <span name="dei:DocumentType">10-K</span>
    <span name="dei:EntityRegistrantName">Acme Corp</span>
    <p>Annual Report on Form 10-K</p>
    <p>ITEM 1A. RISK FACTORS</p>
    <p>${riskParagraph}</p>
    <p>ITEM 7. MANAGEMENT'S DISCUSSION AND ANALYSIS</p>
    <p>Revenue increased during the fiscal year and margins were broadly stable.</p>
  </body></html>`;
}

describe('parsePriorFiling → align → diff', () => {
  const PRIOR_RISK =
    'We face intense competition across all of our markets. ' +
    'Our supply chain depends heavily on a single overseas supplier. ' +
    'We are subject to significant foreign currency fluctuation risk.';

  const CURRENT_RISK =
    'We face intense competition across all of our markets. ' +
    'Our supply chain depends heavily on a single overseas supplier. ' +
    'A cybersecurity breach of our systems could materially harm our business.';

  it('parses a 10-K into a DocumentModel with canonical sections', () => {
    const model = parsePriorFiling(tenK(PRIOR_RISK), URL);
    expect(model.filingType).toBe('10-K');
    const ids = model.sections.map((s) => s.id);
    expect(ids).toContain('item_1a_risk_factors');
    expect(ids).toContain('item_7_mdna');
  });

  it('detects a newly added risk factor and a removed one', () => {
    const current = parsePriorFiling(tenK(CURRENT_RISK), URL);
    const prior = parsePriorFiling(tenK(PRIOR_RISK), URL);

    const aligned = alignSections(current.sections, prior.sections);
    const rf = aligned.find((a) => a.id === 'item_1a_risk_factors');
    expect(rf?.status).toBe('matched');
    expect(rf?.current && rf?.prior).toBeTruthy();

    const core = diffSection(rf!.current!.text, rf!.prior!.text);
    const addedText = core.added.map((s) => s.text).join(' ').toLowerCase();
    const removedText = core.removed.map((s) => s.text).join(' ').toLowerCase();

    expect(addedText).toContain('cybersecurity');
    expect(removedText).toContain('currency');
    expect(core.magnitude).toBeGreaterThan(0);
  });

  it('reports no risk-factor changes when the section is unchanged', () => {
    const a = parsePriorFiling(tenK(PRIOR_RISK), URL);
    const b = parsePriorFiling(tenK(PRIOR_RISK), URL);
    const aligned = alignSections(a.sections, b.sections);
    const rf = aligned.find((x) => x.id === 'item_1a_risk_factors')!;
    const core = diffSection(rf.current!.text, rf.prior!.text);
    expect(core.added).toEqual([]);
    expect(core.removed).toEqual([]);
  });
});
