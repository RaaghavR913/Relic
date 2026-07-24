// ============================================================
// Relic — Analyst pipeline: prompts + responseConstraint schemas
// ------------------------------------------------------------
// Every LM stage is a single Prompt API call with a JSON-schema
// responseConstraint, so Gemini Nano emits parseable structured output.
// Schemas are kept shallow — deeply nested constraints degrade Nano's
// constrained decoding quality.
//
// The product rule lives here: translate the document into investor
// signals; never summarize for its own sake; never give investment advice.
// ============================================================

import type { AnalysisStage, DocumentModel, FilingType } from '@/types';
import { isGeneralFinancialDoc } from '@/content/ingest/detect';

export const ANALYST_DISCLAIMER =
  'AI analysis, not investment advice — verify against source.';

export const SYSTEM_PROMPT =
  'You are an equity research analyst writing for investors, finance students, and retail traders. ' +
  'You analyze excerpts from financial documents (SEC filings, earnings materials, financial statements). ' +
  'Rules: ' +
  '(1) Use ONLY facts stated in the provided excerpts. Never invent or estimate numbers. ' +
  '(2) If the excerpts do not contain the information, write "Not enough information". ' +
  '(3) Never give investment advice. Never tell the reader to buy, sell, or short. ' +
  'Use careful language like "this may be viewed positively by investors because…" or "this could pressure shares if…". ' +
  '(4) Be concise and concrete. Every point must explain why it matters to an investor. ' +
  '(5) The "evidence" field, when present, must be a short quote copied VERBATIM from the excerpts. ' +
  '(6) Prefer material changes and investor implications over plain description.';

// ── enums (single source for schemas + validation) ───────────────────────────

export const LABELS = [
  'Bullish', 'Bearish', 'Mixed', 'Neutral', 'Watch Item',
  'Red Flag', 'Quality Signal', 'Weakness Signal', 'Unclear',
] as const;

export const CATEGORIES = [
  'Revenue', 'Margins', 'Cash Flow', 'Balance Sheet', 'Shares', 'Risk',
  'Guidance', 'Management Commentary', 'Valuation', 'Operations',
  'Legal/Regulatory', 'Customer Demand',
] as const;

export const SEVERITIES = ['Low', 'Medium', 'High'] as const;
export const HORIZONS = ['Short-term', 'Medium-term', 'Long-term'] as const;
export const CONFIDENCES = ['Low', 'Medium', 'High'] as const;
export const READS = ['Bullish', 'Bearish', 'Mixed', 'Neutral'] as const;
export const ASSESSMENTS = ['Supported', 'Partially Supported', 'Not Supported', 'Unclear'] as const;
export const DOC_TYPES = [
  '10-K', '10-Q', '8-K', '20-F', '6-K', 'S-1', 'Proxy Statement',
  'Earnings Call', 'Investor Presentation',
  'Income Statement', 'Balance Sheet', 'Cash Flow Statement', 'Other',
] as const;

// ── schemas ───────────────────────────────────────────────────────────────────

const insightSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: [...LABELS] },
    category: { type: 'string', enum: [...CATEGORIES] },
    title: { type: 'string' },
    summary: { type: 'string' },
    whyItMatters: { type: 'string' },
    investorMeaning: { type: 'string' },
    evidence: { type: 'string' },
    severity: { type: 'string', enum: [...SEVERITIES] },
    timeHorizon: { type: 'string', enum: [...HORIZONS] },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
  },
  required: [
    'label', 'category', 'title', 'summary',
    'whyItMatters', 'investorMeaning', 'severity', 'timeHorizon', 'confidence',
  ],
  additionalProperties: false,
} as const;

export function insightArraySchema(maxItems: number): Record<string, unknown> {
  return { type: 'array', items: insightSchema, maxItems };
}

export const snapshotSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    documentType: { type: 'string', enum: [...DOC_TYPES] },
    overallRead: { type: 'string', enum: [...READS] },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    oneSentenceSummary: { type: 'string' },
    mainFinancialTheme: { type: 'string' },
    timeHorizon: { type: 'string', enum: [...HORIZONS] },
    mostImportantInvestorQuestion: { type: 'string' },
  },
  required: [
    'documentType', 'overallRead', 'confidence', 'oneSentenceSummary',
    'mainFinancialTheme', 'timeHorizon', 'mostImportantInvestorQuestion',
  ],
  additionalProperties: false,
};

export const narrativeSchema: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      claim: { type: 'string' },
      evidence: { type: 'string' },
      assessment: { type: 'string', enum: [...ASSESSMENTS] },
      investorMeaning: { type: 'string' },
    },
    required: ['claim', 'evidence', 'assessment', 'investorMeaning'],
    additionalProperties: false,
  },
  maxItems: 4,
};

const scoreSchema = { type: 'integer', minimum: 1, maximum: 5 } as const;

export const synthesisSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    bullCase: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    bearCase: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    netRead: { type: 'string' },
    whatToWatchNext: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          whyItMatters: { type: 'string' },
          relatedMetric: { type: 'string' },
        },
        required: ['item', 'whyItMatters'],
        additionalProperties: false,
      },
      maxItems: 6,
    },
    scores: {
      type: 'object',
      properties: {
        revenueStrength: scoreSchema,
        marginQuality: scoreSchema,
        cashFlowQuality: scoreSchema,
        balanceSheetStrength: scoreSchema,
        riskLevel: scoreSchema,
        managementCredibility: scoreSchema,
        shareholderFriendliness: scoreSchema,
      },
      required: [
        'revenueStrength', 'marginQuality', 'cashFlowQuality',
        'balanceSheetStrength', 'riskLevel', 'managementCredibility',
        'shareholderFriendliness',
      ],
      additionalProperties: false,
    },
  },
  required: ['bullCase', 'bearCase', 'netRead', 'whatToWatchNext', 'scores'],
  additionalProperties: false,
};

// ── prompt builders ───────────────────────────────────────────────────────────

function docHeader(doc: DocumentModel): string {
  // A general financial page's detected form is unreliable (a press release
  // that mentions "Form 10-K" text-detects as 10-K) — never present it to the
  // model as a filing type.
  const typeLine = isGeneralFinancialDoc(doc)
    ? 'Document: general financial web page'
    : `Filing type (detected): ${doc.filingType}`;
  const bits = [
    doc.companyName ? `Company: ${doc.companyName}` : null,
    doc.ticker ? `Ticker: ${doc.ticker}` : null,
    typeLine,
    doc.periodOfReport ? `Period: ${doc.periodOfReport}` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

/**
 * Guidance for the middle tier: a page that is analyzable financial text but
 * NOT an SEC filing (IR press release, earnings transcript/coverage, market
 * data, non-form PDF). Applied at every stage — the model must never treat the
 * page, or any form name it mentions, as an official filing.
 */
const WEB_PAGE_GUIDANCE =
  'Form note: this is a general financial web page (press release, earnings coverage, ' +
  'transcript, or market data), NOT an SEC filing — any filing type it mentions refers to ' +
  'another document. Analyze only the visible text, attribute claims to the page, and ' +
  'never present it as an official filing.\n';

/**
 * Short per-form guidance appended to the prompt head for forms whose content
 * diverges from the 10-K/10-Q income-statement shape the stage instructions
 * assume. Returns '' for 10-K / 10-Q (and unrecognized types) so Tier-1 prompts
 * stay byte-identical — asserted in tests.
 */
export function formGuidance(filingType: FilingType, stage: AnalysisStage): string {
  switch (filingType) {
    case '8-K':
      return stage === 'snapshot' || stage === 'takeaways' || stage === 'risks'
        ? 'Form note: this is an 8-K current report disclosing specific events. ' +
          'Identify each disclosed event and its materiality to revenue, profitability, ' +
          'or the balance sheet; do not pad with boilerplate.\n'
        : '';
    case '20-F':
    case '6-K':
      // Applies to every stage: IFRS terminology and non-USD currency affect all reads.
      return 'Form note: foreign private issuer filing, likely IFRS. ' +
        '"Profit for the year/period" means net income and "finance costs" means interest expense; ' +
        'figures may be in a non-USD currency — never assume $. ' +
        'Treat the Operating and Financial Review as the MD&A.\n';
    case 'S-1':
      return stage === 'takeaways' || stage === 'shares' || stage === 'risks'
        ? 'Form note: this is an S-1 IPO registration statement. ' +
          'Focus on business model durability, path to profitability, use of proceeds, ' +
          'dilution, lock-up expirations, and dual-class control.\n'
        : '';
    case 'DEF 14A':
      return stage === 'takeaways' || stage === 'risks' || stage === 'narrative'
        ? 'Form note: this is a proxy statement. ' +
          'Focus on pay-for-performance alignment, incentive metrics, equity-plan dilution, ' +
          'and governance red flags; income-statement content is not expected here.\n'
        : '';
    default:
      return '';
  }
}

/**
 * Each user prompt opens with a `TASK: <stage>` line — useful for the model,
 * for debugging, and as a dispatch key for tests with a fake LM.
 */
export function buildStagePrompt(
  stage: AnalysisStage,
  doc: DocumentModel,
  excerpts: string,
  hints?: string,
): string {
  // The web-page note supersedes per-form guidance: a general financial page's
  // detected filingType is unreliable, so its form guidance would mislead.
  const guidance = isGeneralFinancialDoc(doc)
    ? WEB_PAGE_GUIDANCE
    : formGuidance(doc.filingType, stage);
  const head = `TASK: ${stage}\n${docHeader(doc)}\n${guidance}`;
  const hintBlock = hints ? `\nOn-device signal hints (deterministic, trustworthy):\n${hints}\n` : '';

  switch (stage) {
    case 'snapshot':
      return (
        head + hintBlock +
        '\nClassify this document and give the instant investor read. ' +
        '"mostImportantInvestorQuestion" is the single key issue an investor should think about after reading ' +
        '(e.g. "Can the company sustain revenue growth while protecting margins?"). ' +
        '"oneSentenceSummary" states what happened and why it matters — not a generic description.\n\n' +
        `Document excerpts:\n${excerpts}`
      );
    case 'takeaways':
      return (
        head + hintBlock +
        '\nExtract 3–7 top investor takeaways. For each insight:\n' +
        '- "title": a short unique topic headline grounded in the takeaway ' +
        '(e.g. "Compute segment revenue +14%", "Gross margin expanded 180 bps") — ' +
        'never a filing section name like "Management\'s Discussion and Analysis" or "Risk Factors".\n' +
        '- "summary": what happened (concrete).\n' +
        '- "whyItMatters" and "investorMeaning": specific to THIS takeaway — do not reuse the same ' +
        'sentence across cards.\n' +
        '- "label": Bullish/Bearish/Mixed/Neutral/Watch Item/Red Flag/…\n' +
        'No filler, no generic company description. Only material financial, operational, or risk points.\n\n' +
        `Document excerpts:\n${excerpts}`
      );
    case 'revenue':
      return (
        head +
        '\nAnalyze what this document means for the company\'s REVENUE ENGINE: growth or decline, ' +
        'accelerating or slowing, drivers (price/volume/customers/acquisitions/one-time), segment over/under-performance, ' +
        'revenue quality (recurring/transactional/cyclical/concentrated), and signs of future pressure. ' +
        'Use category "Revenue" (or "Customer Demand"/"Guidance" where apt). 1–3 insights.\n\n' +
        `Relevant excerpts:\n${excerpts}`
      );
    case 'margins':
      return (
        head +
        '\nAnalyze PROFITABILITY: gross/operating/net margin trends, expense growth vs revenue growth, ' +
        'cost programs, whether margin moves look sustainable or temporary. ' +
        'Answer: is the company becoming more profitable, less profitable, or growing without operating leverage? ' +
        'Use category "Margins". 1–3 insights.\n\n' +
        `Relevant excerpts:\n${excerpts}`
      );
    case 'cashflow':
      return (
        head +
        '\nAnalyze FINANCIAL DURABILITY: operating/free cash flow, cash balance, debt and interest expense, ' +
        'liquidity runway, capex, working capital, refinancing or covenant risk. ' +
        'Answer: does the company have the financial strength to support its strategy? ' +
        'Use categories "Cash Flow" or "Balance Sheet" (pick the right one per insight). 2–4 insights.\n\n' +
        `Relevant excerpts:\n${excerpts}`
      );
    case 'shares':
      return (
        head +
        '\nAnalyze SHAREHOLDER IMPACT without giving advice: investor sentiment implications, dilution risk, ' +
        'buybacks/dividends, share count changes, whether EPS moves come from profit growth or share count, ' +
        'and whether the market may care now or later. ' +
        'Use category "Shares" (or "Valuation"). 1–3 insights.\n\n' +
        `Relevant excerpts:\n${excerpts}`
      );
    case 'risks':
      return (
        head + hintBlock +
        '\nIdentify MATERIAL INVESTOR RISKS only — skip boilerplate unless it newly worsened or became specific. ' +
        'For each insight: "title" must be a short unique topic label (e.g. "Supply & demand conditions", ' +
        '"Dividend policy") — never copy or truncate the summary, and never include page numbers or ' +
        '"Table of Contents". "whyItMatters" and "investorMeaning" must be specific to THIS risk. ' +
        'Severity and time horizon are required. Focus on risks to revenue, margins, cash flow, debt, legal exposure, ' +
        'demand, competition, or regulation. Use categories "Risk" or "Legal/Regulatory". 2–5 insights.\n\n' +
        `Relevant excerpts:\n${excerpts}`
      );
    case 'narrative':
      return (
        head + hintBlock +
        '\nMANAGEMENT NARRATIVE CHECK: pick up to 4 major management claims from the excerpts and assess whether ' +
        'the evidence in the excerpts supports each. "evidence" must quote or tightly paraphrase the excerpts; ' +
        '"investorMeaning" explains what the gap (or match) means for an investor.\n\n' +
        `Relevant excerpts:\n${excerpts}`
      );
    case 'synthesis':
      return (
        head +
        '\nSynthesize the analysis below into: bullCase (strongest positive signals), bearCase (strongest negatives), ' +
        'netRead (which side the document supports more and why — do not overstate certainty), ' +
        'whatToWatchNext (specific items for future filings/calls, each with why it matters), ' +
        'and scores (1–5; riskLevel: 1 = low risk). ' +
        'Base everything ONLY on the findings below.\n\n' +
        `Findings:\n${excerpts}`
      );
    default:
      return head + excerpts;
  }
}
