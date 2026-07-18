// ============================================================
// Relic — Analyst pipeline: deterministic signals
// ------------------------------------------------------------
// Everything here runs without the Prompt API:
//
//  • whatChangedFromRedline — the year-over-year redline engine already
//    computes real deltas vs the prior filing; investors care about the
//    delta, so this is ground truth (not model recall) for "What Changed".
//  • buildHints — FinBERT sentiment aggregate + language-flag counts +
//    redline magnitudes, passed to LM stages as trustworthy context.
//  • deterministicAnalysis — the degraded Analyst view for the extractive
//    tier (no Gemini Nano): snapshot + what-changed only, clearly labeled.
// ============================================================

import type {
  AnalysisDocumentType,
  DocumentModel,
  FilingAnalysis,
  FilingInsight,
  FilingType,
  InsightCategory,
  InsightLabel,
  LanguageFlag,
  OverallRead,
  SectionDiff,
  SentenceSentiment,
  TimeHorizon,
  XbrlFundamentals,
} from '@/types';
import type { RedlineEntry } from '@/redline/redlineStore';
import { finalizeInsight } from './evidence';
import { computeLexiconTone, type ToneSignal } from './lexiconTone';
import {
  topicTitleFromText,
  uniquifyInsightTitles,
} from './insightTitle';
import {
  topRelevantSentences,
  sentenceDimensions,
  type Dimension,
  type ScoredSentence,
} from './relevance';

// ── document type mapping ─────────────────────────────────────────────────────

export function mapDocumentType(filingType: FilingType): AnalysisDocumentType {
  switch (filingType) {
    case '10-K': return '10-K';
    case '10-Q': return '10-Q';
    case '8-K': return '8-K';
    // 20-F is an annual report; closest investor-facing bucket is 10-K-like.
    case '20-F': return '10-K';
    // 6-K is the foreign-issuer interim report; map to the domestic interim analog.
    case '6-K': return '10-Q';
    case 'S-1':
    case 'DEF 14A':
    case 'DATA_REPORT':
    case 'UNKNOWN':
    default:
      return 'Other';
  }
}

// ── what changed (redline ground truth) ──────────────────────────────────────

function categoryForSection(sectionId: string): InsightCategory {
  if (sectionId.includes('risk')) return 'Risk';
  if (sectionId.includes('legal')) return 'Legal/Regulatory';
  if (sectionId.includes('mdna') || sectionId.includes('item_7')) return 'Operations';
  return 'Management Commentary';
}

const MIN_MAGNITUDE = 0.02; // ignore cosmetic-only sections

export function whatChangedFromRedline(
  doc: DocumentModel,
  redline: RedlineEntry | null | undefined,
): FilingInsight[] {
  if (!redline || redline.status !== 'computed') return [];

  const labelFor = (id: string): string =>
    doc.sections.find((s) => s.id === id)?.label ?? id;

  return redline.diffs
    .filter((d: SectionDiff) => d.magnitude >= MIN_MAGNITUDE && d.summary.trim().length > 0)
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 6)
    .map((d): FilingInsight => {
      const heavy = d.magnitude >= 0.25;
      const category = categoryForSection(d.sectionId);
      return {
        label: heavy ? 'Watch Item' : 'Neutral',
        category,
        title: `${labelFor(d.sectionId)} changed vs prior filing`,
        summary: d.summary,
        whyItMatters: heavy
          ? 'A large rewrite of this section vs the prior filing usually signals a real shift in the business or its risks — worth reading in full.'
          : 'Language drifted from the prior filing; the substance of the edits indicates where management\'s attention moved.',
        investorMeaning:
          category === 'Risk'
            ? 'Changes in risk language often front-run financial impact; investors may want to compare the new wording against the prior year.'
            : 'The delta versus the prior filing matters more than the standalone text — this is where the story changed.',
        severity: heavy ? 'Medium' : 'Low',
        timeHorizon: 'Medium-term',
        confidence: 'High',
      };
    });
}

// ── hints for LM stages ──────────────────────────────────────────────────────

export interface AuxSignals {
  sentiments?: SentenceSentiment[] | null;
  flags?: LanguageFlag[] | null;
  redline?: RedlineEntry | null;
  /** Lexicon tone proxy — used when FinBERT sentiment is not yet available. */
  tone?: ToneSignal | null;
}

/** Compact "$383.3B" style formatting for USD figures in hint/summary text. */
function fmtUsdCompact(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * One-line, exact-figure headline from the filing's own inline XBRL (revenue,
 * net income, and diluted EPS, each with YoY when a prior period was found).
 * Grounds both the LM hint context and the deterministic one-liner in real
 * numbers instead of keyword-selected prose — the numbers ARE the source, so
 * this needs no evidence verification.
 */
function xbrlHeadline(xbrl: XbrlFundamentals | undefined): string {
  if (!xbrl || xbrl.facts.length === 0) return '';
  const by = (label: string) => xbrl.facts.find((f) => f.label === label);
  const parts: string[] = [];
  for (const label of ['Revenue', 'Net income', 'Diluted EPS'] as const) {
    const f = by(label);
    if (!f) continue;
    const value = f.unit === 'USD/shares' ? `$${f.currentValue.toFixed(2)}` : fmtUsdCompact(f.currentValue);
    const yoy = f.yoyPct !== undefined ? ` (${f.yoyPct >= 0 ? '+' : ''}${(f.yoyPct * 100).toFixed(1)}% YoY)` : '';
    parts.push(`${label} ${value}${yoy}`);
  }
  return parts.join(', ');
}

export function buildHints(doc: DocumentModel, aux: AuxSignals): string {
  const lines: string[] = [];

  const headline = xbrlHeadline(doc.xbrl);
  if (headline) lines.push(`XBRL fundamentals (exact, from the filing): ${headline}.`);

  const sents = aux.sentiments ?? [];
  if (sents.length > 0) {
    const pos = sents.filter((s) => s.label === 'positive').length;
    const neg = sents.filter((s) => s.label === 'negative').length;
    lines.push(
      `Financial sentiment model (FinBERT) over ${sents.length} sentences: ` +
      `${Math.round((pos / sents.length) * 100)}% positive, ${Math.round((neg / sents.length) * 100)}% negative.`,
    );
  }

  const flags = aux.flags ?? [];
  if (flags.length > 0) {
    const byType = new Map<string, number>();
    for (const f of flags) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
    lines.push(
      'Language flags: ' +
      [...byType.entries()].map(([t, n]) => `${t}×${n}`).join(', ') + '.',
    );
  }

  if (aux.redline?.status === 'computed' && aux.redline.diffs.length > 0) {
    const top = [...aux.redline.diffs].sort((a, b) => b.magnitude - a.magnitude)[0];
    if (top) {
      lines.push(
        `Year-over-year redline: ${aux.redline.diffs.length} section(s) changed; ` +
        `largest change ~${Math.round(top.magnitude * 100)}% of "${top.sectionId}".`,
      );
    }
  } else if (aux.redline?.status === 'no_prior') {
    lines.push('No comparable prior filing was found (changes vs prior period unknown).');
  }

  return lines.join('\n');
}

// ── degraded (extractive-tier) analysis ──────────────────────────────────────

function overallReadFromSentiment(
  sentiments: SentenceSentiment[] | null | undefined,
  tone: ToneSignal | null | undefined,
): OverallRead {
  const sents = sentiments ?? [];
  // Below the FinBERT confidence threshold, fall back to the lexicon tone proxy
  // so the read is not a flat Neutral before sentiment has been computed.
  if (sents.length < 10) return tone?.overall ?? 'Neutral';
  const pos = sents.filter((s) => s.label === 'positive').length / sents.length;
  const neg = sents.filter((s) => s.label === 'negative').length / sents.length;
  if (pos > neg * 1.5 && pos > 0.1) return 'Bullish';
  if (neg > pos * 1.5 && neg > 0.1) return 'Bearish';
  if (pos > 0.08 && neg > 0.08) return 'Mixed';
  return 'Neutral';
}

const QUESTION_BY_TYPE: Partial<Record<AnalysisDocumentType, string>> = {
  '10-K': 'Did the year strengthen or weaken the long-term thesis — and what changed vs the prior year?',
  '10-Q': 'Is the quarter\'s trajectory (growth, margins, cash) accelerating or slowing?',
  '8-K': 'Is the disclosed event material to revenue, profitability, or the balance sheet?',
  'Other': 'What in this document is material to the company\'s financial trajectory?',
};

// ── deterministic insight synthesis (no LM) ──────────────────────────────────
// Build real investor cards from on-device signals only: the relevance engine
// surfaces the highest-signal (numeric, keyword-matched) sentences per dimension;
// each becomes a verified, advice-scrubbed FilingInsight labeled by the section's
// FinBERT sentiment skew. Titles are topic labels (subject ± compact figure),
// never the shared section heading and never a truncated copy of the summary
// sentence — so MD&A-heavy takeaways stay distinct without quoting themselves.
// Honest by construction: every card's summary is the filing's own words, run
// through the same evidence/advice guards as the LM path.

interface DimMeta {
  category: InsightCategory;
  horizon: TimeHorizon;
  why: string;
}

const DIM_META: Record<Exclude<Dimension, 'overview'>, DimMeta> = {
  revenue: { category: 'Revenue', horizon: 'Medium-term', why: 'Revenue trajectory is the top-line driver of the investment case.' },
  margins: { category: 'Margins', horizon: 'Medium-term', why: 'Margins show whether growth is translating into profit.' },
  cashflow: { category: 'Cash Flow', horizon: 'Medium-term', why: 'Cash generation funds operations, buybacks, and debt service without dilution.' },
  balancesheet: { category: 'Balance Sheet', horizon: 'Long-term', why: 'Leverage and liquidity determine resilience through a downturn.' },
  shares: { category: 'Shares', horizon: 'Medium-term', why: 'Buybacks, dilution, and dividends directly change per-share value.' },
  risk: { category: 'Risk', horizon: 'Medium-term', why: 'Risk-factor language often front-runs financial impact.' },
  management: { category: 'Management Commentary', horizon: 'Medium-term', why: 'Management framing signals where leadership is steering attention.' },
};

/** Net FinBERT sentiment skew for one section → an insight label + signed magnitude. */
function sectionSkew(
  sectionId: string,
  sentiments: SentenceSentiment[] | null | undefined,
  tone: ToneSignal | null | undefined,
): { label: InsightLabel; net: number; n: number } {
  const s = (sentiments ?? []).filter((x) => x.sectionId === sectionId);
  // Too few FinBERT sentences for this section → fall back to the tone proxy.
  if (s.length < 3) return tone?.bySection.get(sectionId) ?? { label: 'Neutral', net: 0, n: s.length };
  const pos = s.filter((x) => x.label === 'positive').length / s.length;
  const neg = s.filter((x) => x.label === 'negative').length / s.length;
  const net = pos - neg;
  let label: InsightLabel = 'Neutral';
  if (net > 0.15) label = 'Bullish';
  else if (net < -0.15) label = 'Bearish';
  else if (pos > 0.1 && neg > 0.1) label = 'Mixed';
  return { label, net, n: s.length };
}

/**
 * Build a short topic headline for the card. Must be a label (subject ± figure),
 * never a truncated copy of the verbatim summary sentence.
 * finalizeInsight re-checks via ensureInsightTitle so LM + deterministic agree.
 */
function titleFromSentence(
  text: string,
  dim: Exclude<Dimension, 'overview'>,
): string {
  return topicTitleFromText(text, DIM_META[dim].category);
}

/** Sentence-aware "why it matters" — falls back to the dimension default. */
function whyFromSentence(text: string, dim: Exclude<Dimension, 'overview'>): string {
  if (dim === 'revenue') {
    if (/concentrat|customer|distributor|odm|oem|\bcsp\b/i.test(text)) {
      return 'Customer and channel concentration shapes revenue durability and bargaining power.';
    }
    if (/segment|graphics|compute|networking|data.?center/i.test(text)) {
      return 'Segment mix shows where growth or pressure is actually coming from.';
    }
    if (/cost of revenue|cost of sales|inventory|tariff|wafer|fabricat/i.test(text)) {
      return 'Cost-of-revenue drivers feed directly into gross margin and earnings power.';
    }
  }
  if (dim === 'margins' && /operating income|gross margin|operating margin/i.test(text)) {
    return 'Operating profit conversion is the bridge from revenue growth to earnings.';
  }
  if (dim === 'cashflow' && /operating cash|free cash|capex|capital expenditure/i.test(text)) {
    return 'Cash conversion shows whether reported earnings are backed by real liquidity.';
  }
  if (dim === 'shares' || /dividend|repurchase|buyback/i.test(text)) {
    if (/dividend/i.test(text)) {
      return 'Dividend policy is a capital-return signal investors price into yield expectations.';
    }
    if (/repurchase|buyback|dilut/i.test(text)) {
      return 'Capital-return and share-count changes alter per-share ownership economics.';
    }
  }
  if (dim === 'risk' || dim === 'balancesheet') {
    if (/supply|demand|monitor the environment/i.test(text)) {
      return 'Supply and demand shifts can move both volume and pricing power quickly.';
    }
    if (/liquidity|cash equivalents|cash and cash/i.test(text)) {
      return 'Liquidity sets the floor for funding flexibility if conditions tighten.';
    }
    if (/dividend/i.test(text)) {
      return 'Future dividends are discretionary — policy language can reprice income expectations.';
    }
    if (/litigation|regulatory|macro/i.test(text)) {
      return 'This risk factor can reprice the thesis if the disclosed scenario materializes.';
    }
  }
  return DIM_META[dim].why;
}

/**
 * Investor-view copy grounded in the sentence (and light section skew), not a
 * single section-wide template shared by every MD&A card.
 */
function investorMeaningFromSentence(
  s: ScoredSentence,
  dim: Exclude<Dimension, 'overview'>,
  skew: { label: InsightLabel; net: number; n: number },
): string {
  if (/supply|demand|monitor the environment/i.test(s.text)) {
    return 'Watch whether management updates escalate from monitoring into guided impact.';
  }
  if (/liquidity|cash equivalents|principal source of liquidity/i.test(s.text)) {
    return 'Compare the cash stack and facilities vs. near-term obligations and buyback capacity.';
  }
  if (/dividend/i.test(s.text)) {
    return 'Treat dividend language as policy intent — confirm against cash generation and board action.';
  }
  if (dim === 'risk' || /\b(risk|litigation|regulatory|adversely|materially harm)/i.test(s.text)) {
    return 'This disclosure flags a risk that can reprice expectations if it materializes.';
  }
  if (/\b(increas\w*|grew|growth|expand\w*|improv\w*|record|strong demand)/i.test(s.text)) {
    return s.hasNumeric
      ? 'The cited figures support a constructive read on this line item versus prior periods.'
      : 'The cited trend supports a constructive read on this line item.';
  }
  if (/\b(decreas\w*|declin\w*|contract\w*|pressure|weak(?:er|ness)?|impair\w*|charge|loss)\b/i.test(s.text)) {
    return s.hasNumeric
      ? 'The cited figures are a pressure point to weigh against the broader thesis.'
      : 'The cited movement is a pressure point to weigh against the broader thesis.';
  }
  if (/concentrat|depend on|majority of (?:our )?revenue/i.test(s.text)) {
    return 'Concentration raises single-point-of-failure risk even when the top line looks strong.';
  }
  if (/cost of revenue|inventory|tariff|wafer|fabricat/i.test(s.text)) {
    return 'Watch whether these cost inputs expand or compress gross margin from here.';
  }
  if (s.hasNumeric) {
    return 'The filing anchors this point with specific figures worth tracking vs. prior periods.';
  }
  if (skew.n >= 3 && skew.label !== 'Neutral') {
    return skew.net > 0
      ? 'Nearby section language skews constructive around this point.'
      : 'Nearby section language skews cautious around this point.';
  }
  return '';
}

/** Drop duplicate Investor-view strings so cards don't all share one template. */
function dedupeInvestorMeanings(insights: FilingInsight[]): FilingInsight[] {
  const seen = new Set<string>();
  return insights.map((ins) => {
    const key = ins.investorMeaning.trim().toLowerCase();
    if (!key) return ins;
    if (seen.has(key)) return { ...ins, investorMeaning: '' };
    seen.add(key);
    return ins;
  });
}

/** Turn one scored sentence into a verified, advice-scrubbed insight card. */
function insightFromSentence(
  doc: DocumentModel,
  s: ScoredSentence,
  dim: Exclude<Dimension, 'overview'>,
  aux: AuxSignals,
): FilingInsight | null {
  const meta = DIM_META[dim];
  const skew = sectionSkew(s.sectionId, aux.sentiments, aux.tone);
  const label: InsightLabel =
    dim === 'risk' ? (skew.net < -0.2 ? 'Red Flag' : 'Watch Item') : skew.label;
  // The summary IS a verbatim source sentence, so its document-space range gives
  // the fallback tier a working jump-to-source (the ↗ button) without a separate
  // quote. finalizeInsight preserves this range.
  const evidenceRange: [number, number] = [
    s.sectionCharStart + s.range[0],
    s.sectionCharStart + s.range[1],
  ];
  return finalizeInsight(doc, {
    label,
    category: meta.category,
    title: titleFromSentence(s.text, dim),
    summary: s.text,
    whyItMatters: whyFromSentence(s.text, dim),
    investorMeaning: investorMeaningFromSentence(s, dim, skew),
    severity: s.hasNumeric ? 'Medium' : 'Low',
    timeHorizon: meta.horizon,
    confidence: 'Medium',
    evidenceRange,
  });
}

function buildDimInsights(
  doc: DocumentModel,
  aux: AuxSignals,
  dim: Exclude<Dimension, 'overview'>,
  limit: number,
): FilingInsight[] {
  const cards = topRelevantSentences(doc, [dim], limit)
    .map((s) => insightFromSentence(doc, s, dim, aux))
    .filter((x): x is FilingInsight => x !== null);
  return uniquifyInsightTitles(dedupeInvestorMeanings(cards));
}

/** Cross-dimension headline takeaways (deduped), labeled by their own dimension. */
function buildTakeaways(doc: DocumentModel, aux: AuxSignals, limit: number): FilingInsight[] {
  const dims: Array<Exclude<Dimension, 'overview'>> = [
    'revenue', 'margins', 'cashflow', 'shares', 'risk', 'management',
  ];
  const pool = topRelevantSentences(doc, dims, limit * 3);
  const seen = new Set<string>();
  const out: FilingInsight[] = [];
  for (const s of pool) {
    const key = s.text.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const dim = sentenceDimensions(s.text)[0] ?? 'revenue';
    const ins = insightFromSentence(doc, s, dim, aux);
    if (ins) out.push(ins);
    if (out.length >= limit) break;
  }
  return uniquifyInsightTitles(dedupeInvestorMeanings(out));
}

/** A single "cautionary language density" card when LM flags are dense. */
function buildFlagDensityInsight(flags: LanguageFlag[] | null | undefined): FilingInsight | null {
  const fs = flags ?? [];
  if (fs.length < 8) return null;
  const byType = new Map<string, number>();
  for (const f of fs) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
  const parts = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t.replace(/_/g, ' ')} ×${n}`);
  const heavy = fs.length > 40;
  return {
    label: heavy ? 'Red Flag' : 'Watch Item',
    category: 'Risk',
    title: 'Cautionary language density',
    summary: `${fs.length} flagged cautionary/legal/uncertainty phrases: ${parts.join(', ')}.`,
    whyItMatters:
      'A high density of hedging, litigious, or uncertainty language can signal management caution or elevated disclosure risk.',
    investorMeaning:
      'Compare against the prior year — a rising flag count often precedes a change in tone or disclosed risk.',
    severity: heavy ? 'High' : 'Medium',
    timeHorizon: 'Medium-term',
    confidence: 'Medium',
  };
}

function buildRiskSignals(doc: DocumentModel, aux: AuxSignals, limit: number): FilingInsight[] {
  const flagCard = buildFlagDensityInsight(aux.flags);
  const fromText = buildDimInsights(doc, aux, 'risk', limit);
  return [...(flagCard ? [flagCard] : []), ...fromText].slice(0, limit + 1);
}

/** One honest, signal-grounded sentence summarizing the on-device read. */
function deterministicOneLiner(doc: DocumentModel, aux: AuxSignals, read: OverallRead): string {
  const company = doc.companyName ?? 'The company';
  const dt = mapDocumentType(doc.filingType);
  const bits: string[] = [];
  const headline = xbrlHeadline(doc.xbrl);
  if (headline) bits.push(headline);
  const sents = aux.sentiments ?? [];
  if (sents.length >= 10) {
    const pos = Math.round((sents.filter((s) => s.label === 'positive').length / sents.length) * 100);
    const neg = Math.round((sents.filter((s) => s.label === 'negative').length / sents.length) * 100);
    bits.push(`sentiment ${pos}% positive / ${neg}% negative`);
  }
  const flags = aux.flags ?? [];
  if (flags.length > 0) bits.push(`${flags.length} cautionary-language flag${flags.length === 1 ? '' : 's'}`);
  if (aux.redline?.status === 'computed' && aux.redline.diffs.length > 0) {
    const n = aux.redline.diffs.length;
    bits.push(`${n} section${n === 1 ? '' : 's'} changed vs the prior filing`);
  }
  const tail = bits.length ? ` — ${bits.join(', ')}.` : '.';
  return `On-device signals read ${read.toLowerCase()} for ${company}'s ${dt}${tail}`;
}

/**
 * Build the best FilingAnalysis without any generative model: a deterministic
 * snapshot plus real takeaways / risk signals / per-dimension cards synthesized
 * from on-device sentiment, language flags, and the prior-filing redline. Only
 * the genuinely LM-shaped sections (bull/bear, narrative check, watch list)
 * stay empty; `degraded` is set so the UI frames the difference.
 */
export function deterministicAnalysis(
  doc: DocumentModel,
  aux: AuxSignals,
): FilingAnalysis {
  // Compute the lexicon tone proxy once and thread it through every builder, so
  // an analyst launched before FinBERT sentiment exists still gets a real read
  // and labeled cards rather than a flat Neutral. FinBERT, when present, wins.
  const tone = aux.tone ?? computeLexiconTone(doc, aux.flags ?? []);
  const auxT: AuxSignals = { ...aux, tone };

  const documentType = mapDocumentType(doc.filingType);
  const overallRead = overallReadFromSentiment(auxT.sentiments, tone);
  const whatChanged = whatChangedFromRedline(doc, auxT.redline);

  const topTakeaways = buildTakeaways(doc, auxT, 5);
  const revenueImpact = buildDimInsights(doc, auxT, 'revenue', 2);
  const marginImpact = buildDimInsights(doc, auxT, 'margins', 2);
  const cashFlowImpact = buildDimInsights(doc, auxT, 'cashflow', 2);
  const balanceSheetHealth = buildDimInsights(doc, auxT, 'balancesheet', 2);
  const shareImpact = buildDimInsights(doc, auxT, 'shares', 2);
  const riskSignals = buildRiskSignals(doc, auxT, 4);

  const stagesDone: FilingAnalysis['stagesDone'] = ['snapshot'];
  if (topTakeaways.length) stagesDone.push('takeaways');
  if (whatChanged.length) stagesDone.push('whatChanged');
  if (revenueImpact.length) stagesDone.push('revenue');
  if (marginImpact.length) stagesDone.push('margins');
  if (cashFlowImpact.length || balanceSheetHealth.length) stagesDone.push('cashflow');
  if (shareImpact.length) stagesDone.push('shares');
  if (riskSignals.length) stagesDone.push('risks');

  return {
    documentType,
    ...(doc.companyName !== undefined ? { companyName: doc.companyName } : {}),
    ...(doc.ticker !== undefined ? { ticker: doc.ticker } : {}),
    ...(doc.periodOfReport !== undefined ? { period: doc.periodOfReport } : {}),
    overallRead,
    confidence: 'Low',
    oneSentenceSummary: deterministicOneLiner(doc, aux, overallRead),
    investorSnapshot: {
      mainFinancialTheme: 'On-device read from sentiment, language flags, and prior-filing changes',
      timeHorizon: documentType === '10-K' ? 'Long-term' : 'Medium-term',
      mostImportantInvestorQuestion:
        QUESTION_BY_TYPE[documentType] ?? QUESTION_BY_TYPE['Other']!,
    },
    topTakeaways,
    whatChanged,
    revenueImpact,
    marginImpact,
    cashFlowImpact,
    balanceSheetHealth,
    shareImpact,
    riskSignals,
    managementNarrativeCheck: [],
    bullCase: [],
    bearCase: [],
    netRead: '',
    whatToWatchNext: [],
    stagesDone,
    degraded: true,
    generatedAt: Date.now(),
  };
}
