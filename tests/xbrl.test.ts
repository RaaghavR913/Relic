/**
 * Unit tests for the inline-XBRL fundamentals extractor (src/content/ingest/xbrl.ts).
 *
 * A compact but structurally-real iXBRL facsimile exercises: value normalization
 * (scale/sign), consolidated-vs-dimensional context filtering, current/prior
 * period selection, YoY + margin computation, and positionMap range attachment.
 */

import { describe, it, expect } from 'vitest';
import { extractXbrlFacts, parseFactValue } from '@/content/ingest/xbrl';
import { buildNormalizedText } from '@/content/ingest/position-map';

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

// Contexts: FY2023 (current, annual), FY2022 (prior, annual), a dimensional
// FY2023 (per-segment — must be excluded), plus instant balance-sheet dates.
const RESOURCES = `
  <ix:header>
    <ix:hidden>
      <ix:nonNumeric name="dei:DocumentType" contextRef="dur_2023">10-K</ix:nonNumeric>
    </ix:hidden>
    <ix:resources>
      <xbrli:context id="dur_2023">
        <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000320193</xbrli:identifier></xbrli:entity>
        <xbrli:period><xbrli:startDate>2022-09-25</xbrli:startDate><xbrli:endDate>2023-09-30</xbrli:endDate></xbrli:period>
      </xbrli:context>
      <xbrli:context id="dur_2022">
        <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000320193</xbrli:identifier></xbrli:entity>
        <xbrli:period><xbrli:startDate>2021-09-26</xbrli:startDate><xbrli:endDate>2022-09-24</xbrli:endDate></xbrli:period>
      </xbrli:context>
      <xbrli:context id="dur_2023_seg">
        <xbrli:entity>
          <xbrli:identifier scheme="http://www.sec.gov/CIK">0000320193</xbrli:identifier>
          <xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">Americas</xbrldi:explicitMember></xbrli:segment>
        </xbrli:entity>
        <xbrli:period><xbrli:startDate>2022-09-25</xbrli:startDate><xbrli:endDate>2023-09-30</xbrli:endDate></xbrli:period>
      </xbrli:context>
      <xbrli:context id="inst_2023"><xbrli:period><xbrli:instant>2023-09-30</xbrli:instant></xbrli:period></xbrli:context>
      <xbrli:context id="inst_2022"><xbrli:period><xbrli:instant>2022-09-24</xbrli:instant></xbrli:period></xbrli:context>
      <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
      <xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
      <xbrli:unit id="eps"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>
    </ix:resources>
  </ix:header>
`;

// Values are shown in millions (scale=6). Revenue 383,285M = $383.285B; prior
// 394,328M. Net income has a sign="-" negative-check via operating loss line.
const FACTS = `
  <p>Revenue
    <ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" contextRef="dur_2023" unitRef="usd" scale="6" decimals="-6">383,285</ix:nonFraction>
    <ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" contextRef="dur_2022" unitRef="usd" scale="6" decimals="-6">394,328</ix:nonFraction>
    <ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" contextRef="dur_2023_seg" unitRef="usd" scale="6" decimals="-6">162,560</ix:nonFraction>
  </p>
  <p>Gross profit
    <ix:nonFraction name="us-gaap:GrossProfit" contextRef="dur_2023" unitRef="usd" scale="6">169,148</ix:nonFraction>
    <ix:nonFraction name="us-gaap:GrossProfit" contextRef="dur_2022" unitRef="usd" scale="6">170,782</ix:nonFraction>
  </p>
  <p>Net income
    <ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="dur_2023" unitRef="usd" scale="6">96,995</ix:nonFraction>
    <ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="dur_2022" unitRef="usd" scale="6">99,803</ix:nonFraction>
  </p>
  <p>Diluted EPS
    <ix:nonFraction name="us-gaap:EarningsPerShareDiluted" contextRef="dur_2023" unitRef="eps" decimals="2">6.13</ix:nonFraction>
  </p>
  <p>Total assets
    <ix:nonFraction name="us-gaap:Assets" contextRef="inst_2023" unitRef="usd" scale="6">352,583</ix:nonFraction>
    <ix:nonFraction name="us-gaap:Assets" contextRef="inst_2022" unitRef="usd" scale="6">352,755</ix:nonFraction>
  </p>
  <p>Shares outstanding
    <ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" contextRef="inst_2023" unitRef="shares" decimals="-3">15,552,752,000</ix:nonFraction>
  </p>
`;

const FILING = `<!doctype html><html><body>${RESOURCES}${FACTS}</body></html>`;

describe('parseFactValue', () => {
  it('applies scale (×10^n)', () => {
    expect(parseFactValue('383,285', '6', null)).toBe(383_285_000_000);
  });
  it('applies sign="-" as negation', () => {
    expect(parseFactValue('1,234', '6', '-')).toBe(-1_234_000_000);
  });
  it('parses decimals without scale', () => {
    expect(parseFactValue('6.13', null, null)).toBeCloseTo(6.13, 5);
  });
  it('returns null for non-numeric / empty', () => {
    expect(parseFactValue('', null, null)).toBeNull();
    expect(parseFactValue('n/a', null, null)).toBeNull();
  });
});

describe('extractXbrlFacts', () => {
  it('returns null when there is no inline XBRL', () => {
    const doc = docFrom('<!doctype html><html><body><p>No facts here.</p></body></html>');
    expect(extractXbrlFacts(doc, null, undefined)).toBeNull();
  });

  it('extracts curated facts with correct scale-normalized current values', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, '2023-09-30');
    expect(f).not.toBeNull();
    const rev = f!.facts.find((x) => x.label === 'Revenue')!;
    expect(rev.currentValue).toBe(383_285_000_000);
    expect(rev.priorValue).toBe(394_328_000_000);
    const eps = f!.facts.find((x) => x.label === 'Diluted EPS')!;
    expect(eps.currentValue).toBeCloseTo(6.13, 5);
    expect(eps.unit).toBe('USD/shares');
  });

  it('computes year-over-year deltas', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    const rev = f.facts.find((x) => x.label === 'Revenue')!;
    // (383,285 − 394,328) / 394,328 ≈ −2.8%
    expect(rev.yoyPct).toBeCloseTo((383285 - 394328) / 394328, 5);
  });

  it('excludes dimensional (per-segment) contexts from consolidated totals', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    const rev = f.facts.find((x) => x.label === 'Revenue')!;
    // The 162,560 Americas-segment fact must NOT win the current period.
    expect(rev.currentValue).not.toBe(162_560_000_000);
  });

  it('selects the instant-dated current value for balance-sheet items', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    const assets = f.facts.find((x) => x.label === 'Total assets')!;
    expect(assets.currentValue).toBe(352_583_000_000);
    expect(assets.priorValue).toBe(352_755_000_000);
  });

  it('derives gross and net margins as fractions', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    const gross = f.metrics.find((m) => m.label === 'Gross margin')!;
    expect(gross.current).toBeCloseTo(169148 / 383285, 5);
    const net = f.metrics.find((m) => m.label === 'Net margin')!;
    expect(net.current).toBeCloseTo(96995 / 383285, 5);
  });

  it('falls back to the latest period when periodOfReport is omitted', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, undefined)!;
    const rev = f.facts.find((x) => x.label === 'Revenue')!;
    expect(rev.currentValue).toBe(383_285_000_000); // 2023 is the latest end date
  });

  it('attaches a DOCUMENT-space range when a positionMap is supplied', () => {
    const doc = docFrom(FILING);
    const { positionMap } = buildNormalizedText(doc.body);
    const f = extractXbrlFacts(doc, positionMap, '2023-09-30')!;
    const rev = f.facts.find((x) => x.label === 'Revenue')!;
    expect(rev.range).toBeDefined();
    expect(rev.range![1]).toBeGreaterThan(rev.range![0]);
  });
});
