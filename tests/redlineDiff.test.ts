// ============================================================
// Relic — Session 6 tests: section diff engine
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  structuralDiff,
  assembleSectionDiff,
  diffSection,
  wordDiff,
  jaccardSimilarity,
  normForMatch,
  templatedChangeSummary,
  type Similarity,
} from '../src/redline/diff';

// ── normForMatch ────────────────────────────────────────────────────────────────

describe('normForMatch', () => {
  it('lowercases, collapses whitespace, and strips punctuation', () => {
    expect(normForMatch('The   Company’s  Risk!')).toBe('the company s risk');
  });
  it('keeps $, %, and decimal points (financial tokens)', () => {
    expect(normForMatch('$1.2 billion, up 12%')).toBe('$1.2 billion up 12%');
  });
});

// ── structuralDiff ──────────────────────────────────────────────────────────────

describe('structuralDiff', () => {
  it('detects a genuinely added sentence', () => {
    const prior = 'We face competition. Our margins may decline.';
    const current =
      'We face competition. A new cybersecurity risk could disrupt operations. Our margins may decline.';
    const td = structuralDiff(current, prior);
    expect(td.addedIdx.length).toBe(1);
    expect(td.removedIdx.length).toBe(0);
    const addedText = td.currentSentences[td.addedIdx[0]!]!.text;
    expect(addedText).toContain('cybersecurity');
  });

  it('detects a removed sentence', () => {
    const prior =
      'We face competition. We rely on a single supplier in Asia. Our margins may decline.';
    const current = 'We face competition. Our margins may decline.';
    const td = structuralDiff(current, prior);
    expect(td.removedIdx.length).toBe(1);
    expect(td.addedIdx.length).toBe(0);
    expect(td.priorSentences[td.removedIdx[0]!]!.text).toContain('single supplier');
  });

  it('treats unchanged sections as no added/removed', () => {
    const text = 'Revenue grew this year. Costs were stable. Outlook remains positive.';
    const td = structuralDiff(text, text);
    expect(td.addedIdx).toEqual([]);
    expect(td.removedIdx).toEqual([]);
  });
});

// ── wordDiff ────────────────────────────────────────────────────────────────────

describe('wordDiff', () => {
  it('extracts the changed words between two similar sentences', () => {
    const cur = 'Our supply chain faces significant and growing geopolitical risk';
    const pri = 'Our supply chain faces geopolitical risk';
    const wd = wordDiff(cur, pri);
    const addedText = wd.added.map((r) => r.text).join(' ');
    expect(addedText).toContain('significant');
    expect(addedText).toContain('growing');
    expect(wd.removed.length).toBe(0);
  });

  it('ranges round-trip to the exact source substring', () => {
    const cur = 'The Company increased its workforce by twenty percent this year';
    const pri = 'The Company increased its workforce this year';
    const wd = wordDiff(cur, pri);
    for (const run of wd.added) {
      expect(cur.slice(run.start, run.end)).toBe(run.text);
    }
  });
});

// ── jaccardSimilarity ───────────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('is 1 for identical text and lower for divergent text', () => {
    expect(jaccardSimilarity('a b c', 'a b c')).toBe(1);
    expect(jaccardSimilarity('the supply chain risk', 'the supply chain risk grew')).toBeGreaterThan(0.5);
    expect(jaccardSimilarity('apples oranges', 'rockets spaceships')).toBe(0);
  });
});

// ── assembleSectionDiff: pairing / reword / cosmetic ────────────────────────────

describe('assembleSectionDiff', () => {
  it('pairs a reworded sentence (jaccard) and reports word-level spans', () => {
    const prior = 'Our supply chain faces geopolitical risk. We compete on price.';
    const current =
      'Our supply chain faces significant and growing geopolitical risk. We compete on price.';
    const core = assembleSectionDiff(structuralDiff(current, prior));
    expect(core.stats.rewordedSentences).toBe(1);
    expect(core.stats.addedSentences).toBe(0);
    expect(core.stats.removedSentences).toBe(0);
    // word-level: "significant", "growing" added
    const addedText = core.added.map((s) => s.text).join(' ');
    expect(addedText).toContain('significant');
  });

  it('added ranges round-trip into the current section text', () => {
    const prior = 'Alpha beta gamma. Old sentence about widgets here.';
    const current = 'Alpha beta gamma. A brand new sentence about regulatory exposure now exists.';
    const core = assembleSectionDiff(structuralDiff(current, prior));
    for (const span of core.added) {
      expect(current.slice(span.range[0], span.range[1])).toBe(span.text);
    }
  });

  it('drops cosmetic near-duplicates when cosmeticMin is set (semantic path)', () => {
    // Two leftover sentences that an embedding matcher rates as near-identical.
    const prior = 'Common opener sentence here. We rely on third party vendors for logistics.';
    const current = 'Common opener sentence here. We depend on third-party vendors for logistics.';
    const td = structuralDiff(current, prior);
    expect(td.addedIdx.length).toBe(1);
    expect(td.removedIdx.length).toBe(1);

    // Fake "semantic" matcher: the leftover pair is cosmetic (0.99).
    const sim: Similarity = () => 0.99;
    const core = assembleSectionDiff(td, { similarity: sim, rewordMin: 0.82, cosmeticMin: 0.97 });
    expect(core.stats.cosmeticDropped).toBe(1);
    expect(core.stats.rewordedSentences).toBe(0);
    expect(core.added).toEqual([]);
    expect(core.removed).toEqual([]);
    expect(core.magnitude).toBe(0);
  });

  it('classifies a meaning-changing reword (mid similarity) as reworded, not cosmetic', () => {
    const prior = 'Common opener sentence here. We expect demand to increase next year.';
    const current = 'Common opener sentence here. We expect demand to decline sharply next year.';
    const td = structuralDiff(current, prior);
    const sim: Similarity = () => 0.88; // meaning-changing reword band
    const core = assembleSectionDiff(td, { similarity: sim, rewordMin: 0.82, cosmeticMin: 0.97 });
    expect(core.stats.rewordedSentences).toBe(1);
    expect(core.stats.cosmeticDropped).toBe(0);
  });

  it('computes magnitude as a fraction in [0,1]', () => {
    const prior = 'One. Two. Three.';
    const current = 'One. Two. Three. This is a brand new and fairly long added sentence here.';
    const core = diffSection(current, prior);
    expect(core.magnitude).toBeGreaterThan(0);
    expect(core.magnitude).toBeLessThanOrEqual(1);
    expect(core.stats.pctChanged).toBe(Math.round(core.magnitude * 100));
  });

  it('handles a new section (empty prior) as all-added', () => {
    const current = 'First risk factor sentence. Second risk factor sentence here.';
    const core = diffSection(current, '');
    expect(core.stats.removedSentences).toBe(0);
    expect(core.added.length).toBeGreaterThan(0);
    expect(core.magnitude).toBeCloseTo(1, 1);
  });
});

// ── templatedChangeSummary ──────────────────────────────────────────────────────

describe('templatedChangeSummary', () => {
  it('summarizes additions, removals and percentage', () => {
    const prior = 'Kept sentence one here. Old removed sentence about supplier risk.';
    const current =
      'Kept sentence one here. A new risk factor regarding regulation appears now. Another new disclosure about taxes.';
    const core = diffSection(current, prior);
    const summary = templatedChangeSummary(core.stats);
    expect(summary).toMatch(/addition/);
    expect(summary).toMatch(/% of section text changed/);
  });

  it('reports no changes for identical sections', () => {
    const text = 'Nothing changed here at all. Same as before.';
    const core = diffSection(text, text);
    expect(templatedChangeSummary(core.stats)).toMatch(/No substantive changes/);
  });
});
