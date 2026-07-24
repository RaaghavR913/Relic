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

// ── financial-sector concepts (Session F2) ────────────────────────────────────
// Banks/insurers/REITs don't report the commercial revenue concepts; these
// facsimiles reuse the shared RESOURCES contexts with sector-specific facts.

const BANK_FACTS = `
  <p>Total revenue net of interest expense
    <ix:nonFraction name="us-gaap:RevenuesNetOfInterestExpense" contextRef="dur_2023" unitRef="usd" scale="6">158,000</ix:nonFraction>
    <ix:nonFraction name="us-gaap:RevenuesNetOfInterestExpense" contextRef="dur_2022" unitRef="usd" scale="6">128,000</ix:nonFraction>
  </p>
  <p>Net interest income
    <ix:nonFraction name="us-gaap:InterestIncomeExpenseNet" contextRef="dur_2023" unitRef="usd" scale="6">89,000</ix:nonFraction>
  </p>
  <p>Noninterest income
    <ix:nonFraction name="us-gaap:NoninterestIncome" contextRef="dur_2023" unitRef="usd" scale="6">69,000</ix:nonFraction>
  </p>
  <p>Net income
    <ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="dur_2023" unitRef="usd" scale="6">49,000</ix:nonFraction>
  </p>
`;

const INSURER_FACTS = `
  <p>Total revenues
    <ix:nonFraction name="us-gaap:Revenues" contextRef="dur_2023" unitRef="usd" scale="6">92,000</ix:nonFraction>
  </p>
  <p>Premiums earned, net
    <ix:nonFraction name="us-gaap:PremiumsEarnedNet" contextRef="dur_2023" unitRef="usd" scale="6">63,000</ix:nonFraction>
  </p>
  <p>Net income
    <ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="dur_2023" unitRef="usd" scale="6">9,000</ix:nonFraction>
  </p>
`;

describe('extractXbrlFacts — fiscal-year focus', () => {
  it('captures dei:DocumentFiscalYearFocus when tagged', () => {
    // NVIDIA-style offset filer: period ends Sep 2023 but the filer labels it FY2024.
    const focus = `<ix:nonNumeric name="dei:DocumentFiscalYearFocus" contextRef="dur_2023">2024</ix:nonNumeric>`;
    const doc = docFrom(`<!doctype html><html><body>${RESOURCES}${focus}${FACTS}</body></html>`);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    expect(f.fiscalYearFocus).toBe(2024);
  });

  it('leaves fiscalYearFocus absent when the fact is not tagged', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    expect(f.fiscalYearFocus).toBeUndefined();
  });
});

describe('extractXbrlFacts — financial-sector concepts', () => {
  it('populates Revenue + net/noninterest income for a bank filing', () => {
    const doc = docFrom(`<!doctype html><html><body>${RESOURCES}${BANK_FACTS}</body></html>`);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    expect(f).not.toBeNull();
    // No commercial revenue concept present → Revenue falls through to the bank line.
    expect(f.facts.find((x) => x.label === 'Revenue')?.currentValue).toBe(158_000_000_000);
    expect(f.facts.find((x) => x.label === 'Net interest income')?.currentValue).toBe(89_000_000_000);
    expect(f.facts.find((x) => x.label === 'Noninterest income')?.currentValue).toBe(69_000_000_000);
  });

  it('computes YoY on the bank total-revenue concept', () => {
    const doc = docFrom(`<!doctype html><html><body>${RESOURCES}${BANK_FACTS}</body></html>`);
    const rev = extractXbrlFacts(doc, null, '2023-09-30')!.facts.find((x) => x.label === 'Revenue')!;
    expect(rev.yoyPct).toBeCloseTo((158000 - 128000) / 128000, 5);
  });

  it('populates Revenue + premiums earned for an insurer filing', () => {
    const doc = docFrom(`<!doctype html><html><body>${RESOURCES}${INSURER_FACTS}</body></html>`);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    // Insurers usually tag total revenue as us-gaap:Revenues; premiums are a detail row.
    expect(f.facts.find((x) => x.label === 'Revenue')?.currentValue).toBe(92_000_000_000);
    expect(f.facts.find((x) => x.label === 'Premiums earned')?.currentValue).toBe(63_000_000_000);
  });

  it('leaves the financial-sector rows absent for a standard commercial filing', () => {
    const doc = docFrom(FILING);
    const f = extractXbrlFacts(doc, null, '2023-09-30')!;
    expect(f.facts.find((x) => x.label === 'Net interest income')).toBeUndefined();
    expect(f.facts.find((x) => x.label === 'Premiums earned')).toBeUndefined();
    expect(f.facts.find((x) => x.label === 'Rental revenue')).toBeUndefined();
  });
});

// ── IFRS (foreign private issuer) + currency handling ─────────────────────────

// An IFRS 20-F facsimile reporting in EUR: ifrs-full concepts only, a eur unit,
// and a per-share divide unit whose numerator is EUR.
const IFRS_RESOURCES = `
  <ix:header>
    <ix:hidden>
      <ix:nonNumeric name="dei:DocumentType" contextRef="ifrs_2023">20-F</ix:nonNumeric>
    </ix:hidden>
    <ix:resources>
      <xbrli:context id="ifrs_2023">
        <xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2023-12-31</xbrli:endDate></xbrli:period>
      </xbrli:context>
      <xbrli:context id="ifrs_2022">
        <xbrli:period><xbrli:startDate>2022-01-01</xbrli:startDate><xbrli:endDate>2022-12-31</xbrli:endDate></xbrli:period>
      </xbrli:context>
      <xbrli:unit id="eur"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>
      <xbrli:unit id="gbp"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>
      <xbrli:unit id="eps_eur"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>
    </ix:resources>
  </ix:header>
`;

const IFRS_FACTS = `
  <p>Revenue
    <ix:nonFraction name="ifrs-full:Revenue" contextRef="ifrs_2023" unitRef="eur" scale="6">30,000</ix:nonFraction>
    <ix:nonFraction name="ifrs-full:Revenue" contextRef="ifrs_2022" unitRef="eur" scale="6">25,000</ix:nonFraction>
  </p>
  <p>Gross profit
    <ix:nonFraction name="ifrs-full:GrossProfit" contextRef="ifrs_2023" unitRef="eur" scale="6">21,000</ix:nonFraction>
  </p>
  <p>Profit for the year
    <ix:nonFraction name="ifrs-full:ProfitLoss" contextRef="ifrs_2023" unitRef="eur" scale="6">6,000</ix:nonFraction>
    <ix:nonFraction name="ifrs-full:ProfitLoss" contextRef="ifrs_2022" unitRef="eur" scale="6">5,000</ix:nonFraction>
  </p>
  <p>Diluted EPS
    <ix:nonFraction name="ifrs-full:DilutedEarningsLossPerShare" contextRef="ifrs_2023" unitRef="eps_eur" decimals="2">4.92</ix:nonFraction>
  </p>
`;

describe('extractXbrlFacts — IFRS concepts + currency (20-F)', () => {
  const doc = () => docFrom(`<!doctype html><html><body>${IFRS_RESOURCES}${IFRS_FACTS}</body></html>`);

  it('populates the curated rows from ifrs-full concepts', () => {
    const f = extractXbrlFacts(doc(), null, '2023-12-31')!;
    expect(f).not.toBeNull();
    expect(f.facts.find((x) => x.label === 'Revenue')?.currentValue).toBe(30_000_000_000);
    expect(f.facts.find((x) => x.label === 'Gross profit')?.currentValue).toBe(21_000_000_000);
    expect(f.facts.find((x) => x.label === 'Net income')?.currentValue).toBe(6_000_000_000);
    expect(f.facts.find((x) => x.label === 'Diluted EPS')?.currentValue).toBeCloseTo(4.92, 5);
  });

  it('flags non-USD monetary facts with their ISO currency (incl. per-share divide units)', () => {
    const f = extractXbrlFacts(doc(), null, '2023-12-31')!;
    expect(f.facts.find((x) => x.label === 'Revenue')?.currencyCode).toBe('EUR');
    expect(f.facts.find((x) => x.label === 'Diluted EPS')?.currencyCode).toBe('EUR');
  });

  it('computes YoY and derives margins within the single reporting currency', () => {
    const f = extractXbrlFacts(doc(), null, '2023-12-31')!;
    expect(f.facts.find((x) => x.label === 'Revenue')?.yoyPct).toBeCloseTo(0.2, 5);
    expect(f.metrics.find((m) => m.label === 'Gross margin')?.current).toBeCloseTo(0.7, 5);
    expect(f.metrics.find((m) => m.label === 'Net margin')?.current).toBeCloseTo(0.2, 5);
  });

  it('never pairs a prior period reported in a DIFFERENT currency', () => {
    const mixed = `
      <p>Revenue
        <ix:nonFraction name="ifrs-full:Revenue" contextRef="ifrs_2023" unitRef="eur" scale="6">30,000</ix:nonFraction>
        <ix:nonFraction name="ifrs-full:Revenue" contextRef="ifrs_2022" unitRef="gbp" scale="6">22,000</ix:nonFraction>
      </p>
    `;
    const f = extractXbrlFacts(
      docFrom(`<!doctype html><html><body>${IFRS_RESOURCES}${mixed}</body></html>`),
      null,
      '2023-12-31',
    )!;
    const rev = f.facts.find((x) => x.label === 'Revenue')!;
    expect(rev.currentValue).toBe(30_000_000_000);
    expect(rev.priorValue).toBeUndefined();
    expect(rev.yoyPct).toBeUndefined();
  });

  it('leaves currencyCode absent on a USD (us-gaap) filing — Tier-1 output unchanged', () => {
    const f = extractXbrlFacts(docFrom(FILING), null, '2023-09-30')!;
    for (const fact of f.facts) expect(fact.currencyCode).toBeUndefined();
  });
});
