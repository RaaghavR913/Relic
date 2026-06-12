// ============================================================
// FilingLens — Analyst pipeline: deterministic signals
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
  LanguageFlag,
  OverallRead,
  SectionDiff,
  SentenceSentiment,
} from '@/types';
import type { RedlineEntry } from '@/redline/redlineStore';

// ── document type mapping ─────────────────────────────────────────────────────

export function mapDocumentType(filingType: FilingType): AnalysisDocumentType {
  switch (filingType) {
    case '10-K': return '10-K';
    case '10-Q': return '10-Q';
    case '8-K': return '8-K';
    // 20-F is an annual report; closest investor-facing bucket is 10-K-like.
    case '20-F': return '10-K';
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
}

export function buildHints(aux: AuxSignals): string {
  const lines: string[] = [];

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

function overallReadFromSentiment(sentiments: SentenceSentiment[] | null | undefined): OverallRead {
  const sents = sentiments ?? [];
  if (sents.length < 10) return 'Neutral';
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

/**
 * Build the best possible FilingAnalysis without any generative model:
 * deterministic snapshot + redline-driven what-changed. All narrative
 * sections stay empty and `degraded` is set so the UI explains why.
 */
export function deterministicAnalysis(
  doc: DocumentModel,
  aux: AuxSignals,
): FilingAnalysis {
  const documentType = mapDocumentType(doc.filingType);
  const whatChanged = whatChangedFromRedline(doc, aux.redline);

  return {
    documentType,
    ...(doc.companyName !== undefined ? { companyName: doc.companyName } : {}),
    ...(doc.ticker !== undefined ? { ticker: doc.ticker } : {}),
    ...(doc.periodOfReport !== undefined ? { period: doc.periodOfReport } : {}),
    overallRead: overallReadFromSentiment(aux.sentiments),
    confidence: 'Low',
    oneSentenceSummary:
      'Generative analysis is unavailable on this device — the read below is built from on-device sentiment, language-flag, and prior-filing-change signals only.',
    investorSnapshot: {
      mainFinancialTheme: `${documentType} review based on deterministic on-device signals`,
      timeHorizon: documentType === '10-K' ? 'Long-term' : 'Medium-term',
      mostImportantInvestorQuestion:
        QUESTION_BY_TYPE[documentType] ?? QUESTION_BY_TYPE['Other']!,
    },
    topTakeaways: [],
    whatChanged,
    revenueImpact: [],
    marginImpact: [],
    cashFlowImpact: [],
    balanceSheetHealth: [],
    shareImpact: [],
    riskSignals: [],
    managementNarrativeCheck: [],
    bullCase: [],
    bearCase: [],
    netRead: '',
    whatToWatchNext: [],
    plainEnglishExplanation: '',
    stagesDone: ['snapshot', ...(whatChanged.length > 0 ? ['whatChanged' as const] : [])],
    degraded: true,
    generatedAt: Date.now(),
  };
}
