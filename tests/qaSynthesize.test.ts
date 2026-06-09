/**
 * FilingLens — Session 7 unit tests for Ask-the-filing grounded synthesis helpers.
 *
 * Covers the PURE logic that does not require the Chrome Prompt API:
 *   (a) buildQaPrompt embeds the question + numbered, labelled, truncated passages
 *   (b) parseCitations returns unique in-range source numbers in first-mention order
 *   (c) parseCitations ignores out-of-range / hallucinated citations
 */

import { describe, it, expect } from 'vitest';
import {
  buildQaPrompt,
  parseCitations,
  templatedQaAnswer,
  QA_SYSTEM_PROMPT,
  type QaPassage,
} from '@/sidepanel/qa/synthesize';

function passage(n: number, sectionLabel: string, text: string): QaPassage {
  return {
    chunkId: `c${n}`,
    sectionId: `item_${n}`,
    sectionLabel,
    charRange: [n * 100, n * 100 + text.length],
    text,
    score: 1 - n * 0.1,
  };
}

describe('buildQaPrompt', () => {
  it('includes the question and numbers each source with its section label', () => {
    const passages = [
      passage(1, 'Risk Factors', 'Supply chain disruptions may adversely affect results.'),
      passage(2, 'MD&A', 'Revenue increased 12% year over year.'),
    ];
    const prompt = buildQaPrompt('How did revenue change?', passages);

    expect(prompt).toContain('Question: How did revenue change?');
    expect(prompt).toContain('[1] (Risk Factors)');
    expect(prompt).toContain('[2] (MD&A)');
    expect(prompt).toContain('Revenue increased 12% year over year.');
  });

  it('truncates very long passages and collapses whitespace', () => {
    const long = 'word '.repeat(400); // 2000 chars
    const prompt = buildQaPrompt('q', [passage(1, 'Business', long)]);
    // The truncated source should be far shorter than the raw passage.
    expect(prompt).toContain('…');
    expect(prompt.length).toBeLessThan(long.length);
    expect(prompt).not.toContain('  '); // whitespace collapsed
  });

  it('handles the empty-passage case gracefully', () => {
    const prompt = buildQaPrompt('anything', []);
    expect(prompt).toContain('(no passages found)');
  });
});

describe('parseCitations', () => {
  it('extracts unique in-range citations in first-mention order', () => {
    const answer = 'Revenue rose [2], driven by demand [1]. Risks remain [2].';
    expect(parseCitations(answer, 3)).toEqual([2, 1]);
  });

  it('drops citations outside the passage count', () => {
    const answer = 'See [1] and [5] and [9].';
    expect(parseCitations(answer, 3)).toEqual([1]);
  });

  it('returns an empty array when there are no citations', () => {
    expect(parseCitations('No sources here.', 4)).toEqual([]);
  });
});

describe('templatedQaAnswer', () => {
  it('returns empty string for no passages', () => {
    expect(templatedQaAnswer([])).toBe('');
  });

  it('produces a readable sentence with [1] citation for a single passage', () => {
    const result = templatedQaAnswer([passage(1, 'Risk Factors', 'Supply chain disruptions may adversely affect results.')]);
    expect(result).toContain('[1]');
    expect(result).toContain('Risk Factors');
    expect(result).toContain('Supply chain disruptions');
    expect(result).toMatch(/^Based on the retrieved passage/);
  });

  it('includes additional [n] citations for multiple passages', () => {
    const passages = [
      passage(1, 'Risk Factors', 'Supply chain disruptions may adversely affect results.'),
      passage(2, 'MD&A', 'Revenue increased 12% year over year.'),
      passage(3, 'Business', 'We operate in more than 50 countries.'),
    ];
    const result = templatedQaAnswer(passages);
    expect(result).toContain('[1]');
    expect(result).toContain('[2]');
    expect(result).toContain('[3]');
    expect(result).toMatch(/^Based on 3 retrieved passages/);
  });

  it('truncates very long top passages at 180 chars with an ellipsis', () => {
    const longText = 'A '.repeat(200); // 400 chars
    const result = templatedQaAnswer([passage(1, 'Business', longText)]);
    expect(result).toContain('…');
    // The quoted excerpt should not exceed 180 chars (plus the trailing ellipsis char)
    const quoteMatch = result.match(/"([^"]+)"/);
    expect(quoteMatch).not.toBeNull();
    expect(quoteMatch![1].replace('…', '').length).toBeLessThanOrEqual(180);
  });

  it('is fully deterministic — same input always produces same output', () => {
    const passages = [
      passage(1, 'Risk Factors', 'Regulatory changes may impact operations.'),
      passage(2, 'MD&A', 'Operating margins declined 2 percentage points.'),
    ];
    expect(templatedQaAnswer(passages)).toBe(templatedQaAnswer(passages));
  });
});

describe('QA_SYSTEM_PROMPT', () => {
  it('instructs the model to ground answers and cite sources', () => {
    expect(QA_SYSTEM_PROMPT).toMatch(/only/i);
    expect(QA_SYSTEM_PROMPT).toMatch(/cite/i);
  });
});
