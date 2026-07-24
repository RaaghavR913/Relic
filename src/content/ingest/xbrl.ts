// ============================================================
// Relic — inline-XBRL fundamentals extractor
// ------------------------------------------------------------
// Parses the exact us-gaap / dei facts embedded in an inline-XBRL (iXBRL) EDGAR
// filing straight from the page DOM — no network, no LM, no guessing. The numbers
// ARE the source, so the resulting fundamentals are deterministic and exact.
//
// Runs in the CONTENT SCRIPT during ingestion (the only context with the filing
// DOM). Modern filings embed the current period AND the prior comparable
// period(s) inline, which is enough to compute year-over-year deltas locally —
// keeping Relic's "the only network request is the Redline" guarantee intact.
//
// iXBRL notes that drive the parsing choices below:
//   • Facts are <ix:nonFraction name="us-gaap:Revenues" contextRef="…"> elements.
//     In HTML the tag keeps its prefix (localName 'ix:nonfraction') and attribute
//     names lowercase, so we select by the [contextref] attribute, not the tag.
//   • The displayed text is the ABSOLUTE value; `sign="-"` marks negatives and
//     `scale="6"` means ×10^6. Parentheses are cosmetic — `sign` is authoritative.
//   • Only NON-DIMENSIONAL contexts are consolidated totals; contexts carrying a
//     <xbrli:segment> (explicit/typed members) are per-segment breakdowns we skip.
// ============================================================

import type { PositionMap, XbrlFact, XbrlFundamentals, XbrlMetric, XbrlUnit } from '@/types';

// ── curated concept map (display order) ───────────────────────────────────────
// Each row lists the us-gaap/dei concepts to try, most-preferred first. The first
// concept with usable facts wins, so newer tags (RevenueFromContractWithCustomer…)
// take precedence over legacy ones (Revenues / SalesRevenueNet).

interface ConceptRow {
  readonly label: string;
  readonly concepts: readonly string[];
  readonly unit: XbrlUnit;
}

const CONCEPTS: readonly ConceptRow[] = [
  // ifrs-full:* concepts (foreign private issuers — 20-F, some 6-K) are listed
  // AFTER the us-gaap ones in every row: first-concept-with-facts wins, so a
  // domestic us-gaap filing resolves exactly as before.
  { label: 'Revenue', unit: 'USD', concepts: [
    'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
    'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax',
    'us-gaap:Revenues',
    'us-gaap:SalesRevenueNet',
    // Banks / broker-dealers report a "total revenue net of interest expense" top
    // line; the commercial concepts above are absent from their filings.
    'us-gaap:RevenuesNetOfInterestExpense',
    'ifrs-full:Revenue',
    'ifrs-full:RevenueFromContractsWithCustomers',
  ] },
  // ── financial-sector line items ──────────────────────────────────────────────
  // Populate only for banks, insurers, and REITs — the concepts are absent from
  // standard commercial filings, so a commercial 10-K's Fundamentals table is
  // unchanged (rows with no matching fact are dropped, not shown empty).
  { label: 'Net interest income', unit: 'USD', concepts: [
    'us-gaap:InterestIncomeExpenseNet',
    'us-gaap:InterestIncomeExpenseAfterProvisionForLoanLoss',
  ] },
  { label: 'Noninterest income', unit: 'USD', concepts: ['us-gaap:NoninterestIncome'] },
  { label: 'Premiums earned', unit: 'USD', concepts: ['us-gaap:PremiumsEarnedNet'] },
  { label: 'Rental revenue', unit: 'USD', concepts: [
    'us-gaap:RealEstateRevenueNet',
    'us-gaap:OperatingLeaseLeaseIncome',
  ] },
  { label: 'Gross profit', unit: 'USD', concepts: ['us-gaap:GrossProfit', 'ifrs-full:GrossProfit'] },
  { label: 'Operating income', unit: 'USD', concepts: [
    'us-gaap:OperatingIncomeLoss',
    'ifrs-full:ProfitLossFromOperatingActivities',
  ] },
  { label: 'Net income', unit: 'USD', concepts: [
    'us-gaap:NetIncomeLoss',
    'ifrs-full:ProfitLossAttributableToOwnersOfParent',
    'ifrs-full:ProfitLoss',
  ] },
  { label: 'Diluted EPS', unit: 'USD/shares', concepts: [
    'us-gaap:EarningsPerShareDiluted',
    'ifrs-full:DilutedEarningsLossPerShare',
  ] },
  { label: 'Basic EPS', unit: 'USD/shares', concepts: [
    'us-gaap:EarningsPerShareBasic',
    'ifrs-full:BasicEarningsLossPerShare',
  ] },
  { label: 'Operating cash flow', unit: 'USD', concepts: [
    'us-gaap:NetCashProvidedByUsedInOperatingActivities',
    'ifrs-full:CashFlowsFromUsedInOperatingActivities',
  ] },
  { label: 'Total assets', unit: 'USD', concepts: ['us-gaap:Assets', 'ifrs-full:Assets'] },
  { label: 'Total liabilities', unit: 'USD', concepts: ['us-gaap:Liabilities', 'ifrs-full:Liabilities'] },
  { label: 'Cash & equivalents', unit: 'USD', concepts: [
    'us-gaap:CashAndCashEquivalentsAtCarryingValue',
    'us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    'ifrs-full:CashAndCashEquivalents',
  ] },
  { label: 'Diluted shares', unit: 'shares', concepts: ['us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding'] },
  { label: 'Shares outstanding', unit: 'shares', concepts: ['dei:EntityCommonStockSharesOutstanding'] },
];

/** Every concept we care about, for a fast membership check while scanning facts. */
const WANTED = new Set<string>(CONCEPTS.flatMap((c) => c.concepts));

// ── context / unit resolution ─────────────────────────────────────────────────

interface XbrlContext {
  /** The period end (duration endDate) or the instant date, ISO. */
  periodEnd: string | null;
  /** Duration length in days (0 for instant / unknown) — used to prefer YTD/annual. */
  durationDays: number;
  /** True when the context carries a segment dimension (per-segment, not consolidated). */
  dimensional: boolean;
}

/** Lowercased tag name without the xbrl prefix, e.g. 'xbrli:context' → 'context'. */
function localTag(el: Element): string {
  const t = el.tagName.toLowerCase();
  const i = t.indexOf(':');
  return i === -1 ? t : t.slice(i + 1);
}

/** First matching descendant (or self) by unprefixed tag name. */
function firstByTag(root: Element, tag: string): Element | null {
  if (localTag(root) === tag) return root;
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    if (localTag(el) === tag) return el;
  }
  return null;
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
}

function resolveContext(el: Element): XbrlContext {
  const instant = firstByTag(el, 'instant')?.textContent?.trim() || null;
  const endDate = firstByTag(el, 'enddate')?.textContent?.trim() || null;
  const startDate = firstByTag(el, 'startdate')?.textContent?.trim() || null;
  const periodEnd = instant ?? endDate;
  const durationDays = startDate && endDate ? daysBetween(startDate, endDate) : 0;
  // A segment / explicit- or typed-member makes this a dimensional breakdown.
  const dimensional =
    firstByTag(el, 'segment') !== null ||
    firstByTag(el, 'explicitmember') !== null ||
    firstByTag(el, 'typedmember') !== null;
  return { periodEnd, durationDays, dimensional };
}

/**
 * ISO-4217 currency of a <…:unit> element — 'USD', 'EUR', … — or null for a
 * non-monetary unit (shares, pure). For a divide unit (per-share) the FIRST
 * measure in document order is the numerator, which is the currency.
 * Foreign private issuers (20-F/6-K) report in their home currency, so the
 * curated 'USD' row unit cannot be trusted blindly for IFRS facts.
 */
function currencyOf(el: Element): string | null {
  const measure = firstByTag(el, 'measure')?.textContent?.trim() ?? '';
  const m = /iso4217:([A-Za-z]{3})/.exec(measure);
  return m ? m[1]!.toUpperCase() : null;
}

// ── value parsing ─────────────────────────────────────────────────────────────

/**
 * Parse an iXBRL fact's numeric value. The text is the absolute magnitude; apply
 * `scale` (×10^n) then `sign` (negate on '-'). Returns null when there is no
 * numeric content (e.g. a nil or non-numeric fact).
 */
export function parseFactValue(text: string, scale: string | null, sign: string | null): number | null {
  const digits = text.replace(/[^0-9.]/g, '');
  if (digits === '' || digits === '.') return null;
  let value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) return null;
  const s = scale ? Number.parseInt(scale, 10) : 0;
  if (Number.isFinite(s) && s !== 0) value *= 10 ** s;
  if (sign === '-') value = -value;
  return value;
}

// ── fact collection ───────────────────────────────────────────────────────────

interface RawFact {
  concept: string;
  value: number;
  periodEnd: string | null;
  durationDays: number;
  /** ISO-4217 code from the fact's unitref, or null when unresolvable/non-monetary. */
  currency: string | null;
  node: Element;
}

/** First non-empty descendant Text node of a fact element (for jump-to-source). */
function firstTextNode(el: Element): Text | null {
  const walk = (n: Node): Text | null => {
    for (const child of Array.from(n.childNodes)) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        if ((child.textContent ?? '').trim().length > 0) return child as Text;
      } else {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(el);
}

// ── public entry point ────────────────────────────────────────────────────────

/**
 * Extract deterministic fundamentals from a filing's inline XBRL.
 *
 * @param scope       The filing Document (has the ix:resources contexts/units).
 * @param positionMap Optional — used to attach DOCUMENT-space ranges for jump-to-source.
 * @param periodOfReport Optional ISO date; when absent the latest period end is used.
 * @returns XbrlFundamentals when at least one curated fact is found, else null.
 */
export function extractXbrlFacts(
  scope: Document,
  positionMap: PositionMap | null,
  periodOfReport?: string,
): XbrlFundamentals | null {
  const factEls = Array.from(scope.querySelectorAll('[contextref]'));
  if (factEls.length === 0) return null;

  const contextCache = new Map<string, XbrlContext>();
  const getContext = (id: string): XbrlContext | null => {
    const cached = contextCache.get(id);
    if (cached) return cached;
    const el = scope.getElementById(id);
    if (!el) return null;
    const ctx = resolveContext(el);
    contextCache.set(id, ctx);
    return ctx;
  };

  // unitref → ISO currency (null for shares/pure/unresolvable units).
  const currencyCache = new Map<string, string | null>();
  const getCurrency = (unitRef: string | null): string | null => {
    if (!unitRef) return null;
    if (currencyCache.has(unitRef)) return currencyCache.get(unitRef)!;
    const el = scope.getElementById(unitRef);
    const code = el ? currencyOf(el) : null;
    currencyCache.set(unitRef, code);
    return code;
  };

  // Group raw facts by concept, consolidated (non-dimensional) contexts only.
  const byConcept = new Map<string, RawFact[]>();
  for (const el of factEls) {
    const concept = el.getAttribute('name');
    if (!concept || !WANTED.has(concept)) continue;
    const ctxId = el.getAttribute('contextref');
    if (!ctxId) continue;
    const ctx = getContext(ctxId);
    if (!ctx || ctx.dimensional || !ctx.periodEnd) continue;
    const value = parseFactValue(
      el.textContent ?? '',
      el.getAttribute('scale'),
      el.getAttribute('sign'),
    );
    if (value === null) continue;
    const arr = byConcept.get(concept);
    const raw: RawFact = {
      concept,
      value,
      periodEnd: ctx.periodEnd,
      durationDays: ctx.durationDays,
      currency: getCurrency(el.getAttribute('unitref')),
      node: el,
    };
    if (arr) arr.push(raw);
    else byConcept.set(concept, [raw]);
  }

  // For a set of same-concept facts, pick the current + prior comparable values:
  // collapse to one fact per distinct period end (preferring the longest duration —
  // annual over quarterly, YTD over interim), then take the two most recent ends.
  const pickCurrentPrior = (
    facts: RawFact[],
  ): { current: RawFact; prior?: RawFact } | null => {
    if (facts.length === 0) return null;
    const bestByEnd = new Map<string, RawFact>();
    for (const f of facts) {
      const key = f.periodEnd!;
      const existing = bestByEnd.get(key);
      if (!existing || f.durationDays > existing.durationDays) bestByEnd.set(key, f);
    }
    const ends = Array.from(bestByEnd.keys()).sort((a, b) => Date.parse(b) - Date.parse(a));
    // Current = the period matching periodOfReport when present, else the latest.
    let currentEnd = ends[0]!;
    if (periodOfReport && bestByEnd.has(periodOfReport)) currentEnd = periodOfReport;
    const current = bestByEnd.get(currentEnd)!;
    // A YoY delta across different reporting currencies is meaningless (e.g. a
    // filer that redenominated) — only pair a prior in the SAME currency.
    const priorEnds = ends.filter(
      (e) => Date.parse(e) < Date.parse(currentEnd) && bestByEnd.get(e)!.currency === current.currency,
    );
    const priorEnd = priorEnds[0];
    const priorFact = priorEnd ? bestByEnd.get(priorEnd) : undefined;
    return {
      current,
      ...(priorFact ? { prior: priorFact } : {}),
    };
  };

  const rangeFor = (node: Element): [number, number] | undefined => {
    if (!positionMap) return undefined;
    const textNode = firstTextNode(node);
    if (!textNode) return undefined;
    const start = positionMap.fromNode(textNode, 0);
    if (start === null) return undefined;
    return [start, start + (textNode.textContent ?? '').length];
  };

  const facts: XbrlFact[] = [];
  let currentPeriodEnd: string | undefined;
  let priorPeriodEnd: string | undefined;

  for (const row of CONCEPTS) {
    // First concept in the row that actually has facts.
    let picked: { current: RawFact; prior?: RawFact } | null = null;
    let concept = '';
    for (const c of row.concepts) {
      const got = byConcept.get(c);
      if (got && got.length > 0) {
        picked = pickCurrentPrior(got);
        concept = c;
        if (picked) break;
      }
    }
    if (!picked) continue;

    if (!currentPeriodEnd) currentPeriodEnd = picked.current.periodEnd ?? undefined;
    if (!priorPeriodEnd && picked.prior) priorPeriodEnd = picked.prior.periodEnd ?? undefined;

    const current = picked.current.value;
    const prior = picked.prior?.value;
    const range = rangeFor(picked.current.node);
    // Flag the currency ONLY when a monetary fact is verifiably non-USD, so
    // us-gaap extraction output stays byte-identical (absent → '$' display).
    const isMonetary = row.unit === 'USD' || row.unit === 'USD/shares';
    const cur = picked.current.currency;
    const currencyCode = isMonetary && cur !== null && cur !== 'USD' ? cur : undefined;
    facts.push({
      concept,
      label: row.label,
      unit: row.unit,
      currentValue: current,
      ...(currencyCode !== undefined ? { currencyCode } : {}),
      ...(prior !== undefined ? { priorValue: prior } : {}),
      ...(prior !== undefined && prior !== 0 ? { yoyPct: (current - prior) / Math.abs(prior) } : {}),
      ...(range ? { range } : {}),
    });
  }

  if (facts.length === 0) return null;

  // The filer's own fiscal-year label. Usually an ix:nonNumeric in the hidden
  // header; grab it by name — no context/period resolution applies to it.
  const focusText =
    scope.querySelector('[name="dei:DocumentFiscalYearFocus"]')?.textContent ?? '';
  const focusMatch = /(?:19|20)\d{2}/.exec(focusText);
  const fiscalYearFocus = focusMatch ? Number(focusMatch[0]) : undefined;

  return {
    facts,
    metrics: deriveMetrics(facts),
    ...(currentPeriodEnd ? { periodEnd: currentPeriodEnd } : {}),
    ...(priorPeriodEnd ? { priorPeriodEnd } : {}),
    ...(fiscalYearFocus !== undefined ? { fiscalYearFocus } : {}),
  };
}

// ── derived margins ───────────────────────────────────────────────────────────

/** Build margin ratios from the extracted line items (skipped when inputs absent). */
function deriveMetrics(facts: XbrlFact[]): XbrlMetric[] {
  const by = (label: string) => facts.find((f) => f.label === label);
  const revenue = by('Revenue');
  if (!revenue || revenue.currentValue === 0) return [];

  const metrics: XbrlMetric[] = [];
  const ratio = (numer: XbrlFact | undefined, label: string) => {
    if (!numer) return;
    const current = numer.currentValue / revenue.currentValue;
    const prior =
      numer.priorValue !== undefined && revenue.priorValue !== undefined && revenue.priorValue !== 0
        ? numer.priorValue / revenue.priorValue
        : undefined;
    metrics.push({ label, current, ...(prior !== undefined ? { prior } : {}) });
  };
  ratio(by('Gross profit'), 'Gross margin');
  ratio(by('Operating income'), 'Operating margin');
  ratio(by('Net income'), 'Net margin');
  return metrics;
}
