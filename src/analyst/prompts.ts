// ============================================================
// FilingLens — Analyst pipeline: prompts + responseConstraint schemas
// ------------------------------------------------------------
// Every LM stage is a single Prompt API call with a JSON-schema
// responseConstraint, so Gemini Nano emits parseable structured output.
// Schemas are kept shallow — deeply nested constraints degrade Nano's
// constrained decoding quality.
//
// The product rule lives here: translate the document into investor
// signals; never summarize for its own sake; never give investment advice.
// ============================================================

import type { AnalysisStage, DocumentModel } from '@/types';

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
  '10-K', '10-Q', '8-K', 'Earnings Call', 'Investor Presentation',
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
    plainEnglishExplanation: { type: 'string' },
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
  required: ['bullCase', 'bearCase', 'netRead', 'whatToWatchNext', 'plainEnglishExplanation', 'scores'],
  additionalProperties: false,
};

// ── prompt builders ───────────────────────────────────────────────────────────

function docHeader(doc: DocumentModel): string {
  const bits = [
    doc.companyName ? `Company: ${doc.companyName}` : null,
    doc.ticker ? `Ticker: ${doc.ticker}` : null,
    `Filing type (detected): ${doc.filingType}`,
    doc.periodOfReport ? `Period: ${doc.periodOfReport}` : null,
  ].filter(Boolean);
  return bits.join(' · ');
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
  const head = `TASK: ${stage}\n${docHeader(doc)}\n`;
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
        '\nExtract 3–7 top investor takeaways. Each: what happened, why it matters, and a label ' +
        '(Bullish/Bearish/Mixed/Neutral/…). No filler, no generic company description. ' +
        'Only material financial, operational, or risk points.\n\n' +
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
        'In each title note the kind of risk (new / worsened / more specific / now active). ' +
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
        'plainEnglishExplanation (3–5 simple sentences for a non-expert: what is going on, is it good or bad, ' +
        'why care, what could happen next), and scores (1–5; riskLevel: 1 = low risk). ' +
        'Base everything ONLY on the findings below.\n\n' +
        `Findings:\n${excerpts}`
      );
    default:
      return head + excerpts;
  }
}
