// ============================================================
// Relic — Analyst tab: investor-focused document analysis
// ------------------------------------------------------------
// Renders the staged FilingAnalysis in the spec order:
//   Snapshot → Takeaways → What This Means
//   → Risks → Narrative Check → Bull/Bear → Watch Next
//
// Sections stream in as pipeline stages complete; everything except the
// snapshot + takeaways starts collapsed to stay compact in the side panel.
// ============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import type {
  AnalysisStage,
  DocumentModel,
  FilingAnalysis,
  FilingInsight,
  InsightLabel,
  LanguageFlag,
  ScorePoint,
} from '@/types';
import type { GenerationTier } from '@/runtime/capabilities';
import { generateFilingAnalysis } from '@/analyst/pipeline';
import { getCachedAnalysis, putAnalysis, clearAnalysis } from '@/analyst/analysisStore';
import { getCachedRedline } from '@/redline/redlineStore';
import { getSentimentCache } from '@/db/sentimentStore';
import { isLowConfidenceGeneric, isGeneralFinancialDoc } from '@/content/ingest/detect';
import { detectFiscalCalendarOffset } from '@/lib/fiscalCalendar';
import { fmtCalendarDate } from '@/lib/date';
import { FundamentalsPanel } from './FundamentalsPanel';
import { useReportAnalysisActivity } from './analysisActivity';

// Must match FINBERT_MODEL_ID in offscreen.ts (not imported — that module
// hosts workers and must not be pulled into the side panel bundle).
const FINBERT_MODEL_ID = 'Xenova/finbert';

// ── label / read styling ──────────────────────────────────────────────────────

const LABEL_STYLES: Record<InsightLabel, string> = {
  'Bullish':         'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  'Bearish':         'bg-red-500/15 text-red-300 ring-red-500/30',
  'Mixed':           'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  'Neutral':         'bg-zinc-700/40 text-zinc-300 ring-zinc-600/40',
  'Watch Item':      'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  'Red Flag':        'bg-red-500/20 text-red-200 ring-red-500/40',
  'Quality Signal':  'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  'Weakness Signal': 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  'Unclear':         'bg-zinc-700/40 text-zinc-400 ring-zinc-600/40',
};

const READ_STYLES: Record<FilingAnalysis['overallRead'], string> = {
  Bullish: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  Bearish: 'bg-red-500/15 text-red-300 ring-red-500/40',
  Mixed:   'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  Neutral: 'bg-zinc-700/50 text-zinc-300 ring-zinc-600/50',
};

const STAGE_LABELS: Record<AnalysisStage, string> = {
  snapshot: 'Investor snapshot',
  takeaways: 'Top takeaways',
  whatChanged: 'What changed',
  revenue: 'Revenue impact',
  margins: 'Margins',
  cashflow: 'Cash flow & balance sheet',
  shares: 'Shareholder impact',
  risks: 'Risk signals',
  narrative: 'Narrative check',
  synthesis: 'Bull vs bear & watch list',
};

const STAGE_ORDER: AnalysisStage[] = [
  'snapshot', 'takeaways', 'whatChanged', 'revenue', 'margins',
  'cashflow', 'shares', 'risks', 'narrative', 'synthesis',
];

/** User-facing badge text — the internal 'Neutral' label is shown to users as 'Info'. */
function labelText(label: string): string {
  return label === 'Neutral' ? 'Info' : label;
}

function LabelChip({ label }: { label: InsightLabel }) {
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${LABEL_STYLES[label]}`}>
      {labelText(label)}
    </span>
  );
}

// ── jump to evidence ──────────────────────────────────────────────────────────

async function highlightEvidence(range: [number, number]): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, {
    target: 'content',
    type: 'HIGHLIGHT_RANGE',
    charRange: range, // already DOCUMENT-space
  });
}

async function clearDocHighlights(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, {
    target: 'content',
    type: 'CLEAR_HIGHLIGHTS',
  });
}

// ── insight card ──────────────────────────────────────────────────────────────

function InsightCard({ insight }: { insight: FilingInsight }) {
  return (
    <div className="rounded-lg bg-zinc-900 px-3 py-2.5 ring-1 ring-zinc-800">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs font-medium leading-snug text-zinc-200">{insight.title}</p>
        <LabelChip label={insight.label} />
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-300">{insight.summary}</p>
      {insight.whyItMatters && (
        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
          <span className="font-medium text-[#00C68D]">Why it matters: </span>
          {insight.whyItMatters}
        </p>
      )}
      {insight.investorMeaning && (
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          <span className="font-medium text-[#00C68D]">Investor view: </span>
          {insight.investorMeaning}
        </p>
      )}
      {insight.evidence && (
        <div className="mt-1.5 flex items-start gap-2">
          <p className="flex-1 border-l border-zinc-700 pl-2 text-[10px] italic leading-relaxed text-zinc-500">
            “{insight.evidence}”
          </p>
          {insight.evidenceRange && (
            <button
              onClick={() => void highlightEvidence(insight.evidenceRange!).catch(() => {})}
              title="Highlight in document"
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-sky-900/20 hover:text-sky-400 focus-visible:outline focus-visible:outline-sky-500"
              aria-label="Highlight evidence in document"
            >
              ↗
            </button>
          )}
        </div>
      )}
      {/* Deterministic-tier cards carry a source range but no separate quote (the
          summary IS the verbatim sentence) — surface a standalone jump-to-source. */}
      {!insight.evidence && insight.evidenceRange && (
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void highlightEvidence(insight.evidenceRange!).catch(() => {})}
            className="rounded px-1.5 py-0.5 text-[10px] text-sky-500 transition hover:text-sky-300 focus-visible:outline focus-visible:outline-sky-500"
            aria-label="Show this passage in the document"
          >
            ↗ Show in document
          </button>
          <button
            onClick={() => void clearDocHighlights().catch(() => {})}
            className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-zinc-900/20 hover:text-zinc-300 focus-visible:outline focus-visible:outline-sky-500"
            aria-label="Remove highlight from filing"
          >
            Remove highlight
          </button>
        </div>
      )}
      <p className="mt-1.5 text-[9px] text-zinc-600">
        {insight.category} · severity {insight.severity} · {insight.timeHorizon} · confidence {insight.confidence}
      </p>
    </div>
  );
}

function InsightList({ insights, emptyNote }: { insights: FilingInsight[]; emptyNote: string }) {
  if (insights.length === 0) {
    return <p className="px-1 text-[11px] italic text-zinc-600">{emptyNote}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {insights.map((ins, i) => <InsightCard key={i} insight={ins} />)}
    </div>
  );
}

// ── collapsible section ───────────────────────────────────────────────────────

function Collapse({
  title,
  count,
  defaultOpen = false,
  pending = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  pending?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg bg-zinc-900/40 ring-1 ring-zinc-800/70">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-[#00C68D]">
          {title}
        </span>
        {pending && <span className="animate-pulse text-[10px] text-sky-400">…</span>}
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-zinc-800 px-1.5 text-[10px] font-semibold tabular-nums text-zinc-400">{count}</span>
        )}
        <svg
          className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
        >
          <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="px-2.5 pb-2.5">{children}</div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── snapshot card ─────────────────────────────────────────────────────────────

function ScoreRow({ name, value, inverted = false }: { name: string; value: ScorePoint; inverted?: boolean }) {
  // For riskLevel (inverted), high = bad → red; otherwise high = good → green.
  const good = inverted ? 6 - value : value;
  const color = good >= 4 ? 'bg-emerald-500' : good === 3 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <span className="w-36 shrink-0 text-[12px] text-white">{name}</span>
      <div className="flex flex-1 gap-0.5">
        {([1, 2, 3, 4, 5] as const).map((i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-sm ${i <= value ? color : 'bg-zinc-800'}`} />
        ))}
      </div>
      <span className="w-6 text-right text-[10px] tabular-nums text-zinc-500">{value}/5</span>
    </div>
  );
}

function SnapshotCard({ analysis }: { analysis: FilingAnalysis }) {
  return (
    <div className="rounded-xl bg-zinc-900 p-3.5 ring-1 ring-zinc-800">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-md px-2 py-1 text-[12px] font-bold ring-1 ring-inset ${READ_STYLES[analysis.overallRead]}`}>
          {labelText(analysis.overallRead)}
        </span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[12px] font-medium text-zinc-300">
          {analysis.documentType}
        </span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[12px] text-zinc-400">
          Confidence: {analysis.confidence}
        </span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[12px] text-zinc-400">
          {analysis.investorSnapshot.timeHorizon}
        </span>
      </div>

      {analysis.scores && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-zinc-800 pt-2.5">
          <div className="group relative flex items-center gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Model impression
            </span>
            <span
              tabIndex={0}
              className="flex h-3 w-3 shrink-0 cursor-help items-center justify-center rounded-full bg-zinc-800 text-[8px] font-bold text-zinc-500 ring-1 ring-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
              aria-label="What is Model impression?"
            >
              i
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-0 top-full z-10 mt-1.5 hidden w-56 rounded bg-zinc-800 px-2 py-1.5 text-[10px] font-normal normal-case leading-relaxed tracking-normal text-zinc-300 shadow-lg ring-1 ring-zinc-700 group-hover:block group-focus-within:block"
            >
              The on-device model's qualitative read of its own analysis — not a computed
              metric. Treat these as impressions, not scores.
            </span>
          </div>
          <ScoreRow name="Revenue strength" value={analysis.scores.revenueStrength} />
          <ScoreRow name="Margin quality" value={analysis.scores.marginQuality} />
          <ScoreRow name="Cash flow quality" value={analysis.scores.cashFlowQuality} />
          <ScoreRow name="Balance sheet" value={analysis.scores.balanceSheetStrength} />
          <ScoreRow name="Risk level" value={analysis.scores.riskLevel} inverted />
          <ScoreRow name="Mgmt credibility" value={analysis.scores.managementCredibility} />
          <ScoreRow name="Shareholder friendly" value={analysis.scores.shareholderFriendliness} />
        </div>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

type Status = 'idle' | 'running' | 'done' | 'error';

interface AnalystPanelProps {
  doc: DocumentModel;
  detectedTier: GenerationTier;
  /** True when Gemini Nano is ALREADY downloaded (promptApi === 'available'). */
  promptReady: boolean;
  flags: LanguageFlag[];
}

export function AnalystPanel({ doc, detectedTier, promptReady, flags }: AnalystPanelProps) {
  const [analysis, setAnalysis] = useState<FilingAnalysis | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [currentStage, setCurrentStage] = useState<AnalysisStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const acRef = useRef<AbortController | null>(null);
  const flagsRef = useRef(flags);
  flagsRef.current = flags;

  // Non-filings (e.g. a Yahoo quote page) and misdetected pages that didn't
  // segment into sections aren't worth triggering a multi-GB Gemini Nano
  // download for. Degrade to the deterministic tier: instant, no download, no
  // hang. EXCEPTION — a general financial page (IR release, transcript, news,
  // non-form PDF) upgrades to the LM tier when the model is ALREADY downloaded
  // (promptReady): the middle tier gets real takeaways with zero download risk,
  // and buildStagePrompt frames the text as a web page, not a filing. The tier
  // also keys the analysis cache, so it's threaded through every store call below.
  const gatedToDeterministic = isLowConfidenceGeneric(doc) || doc.sections.length <= 1;
  const lmOnGeneralPage =
    isGeneralFinancialDoc(doc) && promptReady && detectedTier === 'builtin';
  const analysisTier: GenerationTier = gatedToDeterministic
    ? (lmOnGeneralPage ? 'builtin' : 'extractive')
    : detectedTier;

  // A load-bearing MD&A / operating-review section that is only a by-reference
  // pointer: the narrative lives elsewhere (exhibit or un-numbered block), so the
  // analysis below cannot cover it. Surface a note instead of silently analysing
  // the pointer text. (S2 carry-over: detection only.)
  const byRefSection = doc.sections.find((s) => s.incorporatedByReference);

  // Fiscal year offset from the calendar year (NVIDIA's FY2027 quarter ends
  // Apr 2026): verbatim "fiscal year 2027" takeaways beside a 2026 period date
  // read as hallucinations without a note explaining the filer's calendar.
  const fiscalOffset = useMemo(() => detectFiscalCalendarOffset(doc), [doc]);

  const run = useCallback(async (force = false) => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setError(null);

    try {
      if (force) {
        await clearAnalysis(doc.rawTextHash, analysisTier).catch(() => {});
      } else {
        const cached = await getCachedAnalysis(doc.rawTextHash, analysisTier);
        if (cached) {
          setAnalysis(cached);
          setStatus('done');
          return;
        }
      }

      setStatus('running');
      setCurrentStage('snapshot');

      // Gather deterministic context (all best-effort).
      const [redline, sentiments] = await Promise.all([
        getCachedRedline(doc.rawTextHash).catch(() => null),
        getSentimentCache(doc.rawTextHash, FINBERT_MODEL_ID).catch(() => null),
      ]);

      const result = await generateFilingAnalysis(doc, {
        tier: analysisTier,
        aux: { redline, sentiments, flags: flagsRef.current },
        signal: ac.signal,
        onStage: (stage, partial) => {
          if (ac.signal.aborted) return;
          const idx = STAGE_ORDER.indexOf(stage);
          setCurrentStage(STAGE_ORDER[idx + 1] ?? null);
          setAnalysis({ ...partial });
        },
        onDownloadProgress: (loaded) => {
          if (ac.signal.aborted) return;
          setDownloadProgress(loaded);
        },
      });

      if (ac.signal.aborted) return;
      setAnalysis(result);
      setStatus('done');
      setCurrentStage(null);
      setDownloadProgress(null);
      await putAnalysis(doc.rawTextHash, analysisTier, result).catch(console.warn);
    } catch (err) {
      if (ac.signal.aborted) return;
      setStatus('error');
      setCurrentStage(null);
      setDownloadProgress(null);
      setError(String(err));
    }
  }, [doc, analysisTier]);

  // Auto-run once per document. Keyed on the content hash + tier, NOT on `run`'s
  // identity: the parent hands down a fresh `doc` object on every re-broadcast of
  // the SAME page (re-detect, re-analyze, SPA re-injection), which changes `run`
  // but not the hash. Including `run` here re-fired the effect on those, whose
  // cleanup aborted the in-flight analysis without restarting it — pinning the
  // panel on "Reading the document…" forever. Reading `run` from a ref keeps the
  // latest closure while only genuinely new content/tier triggers a re-run.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    setAnalysis(null);
    setStatus('idle');
    void runRef.current();
    return () => acRef.current?.abort();
  }, [doc.rawTextHash, analysisTier]);

  // Surface the header "On-device" chip while the analyst pipeline runs.
  useReportAnalysisActivity(status === 'running');

  const running = status === 'running';
  const a = analysis;

  return (
    <section aria-labelledby="analyst-heading" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p id="analyst-heading" className="text-[13px] font-medium uppercase tracking-widest text-[#00C68D] font-display">
          Investor Analysis
        </p>
        {running && currentStage && (
          <span className="animate-pulse text-[10px] text-sky-400">
            {STAGE_LABELS[currentStage]}…
          </span>
        )}
        <button
          onClick={() => void run(true)}
          disabled={running}
          className="ml-auto shrink-0 rounded border border-[#36ADA3]/40 px-2 py-0.5 text-[11px] font-medium bg-[#1A5752] text-white transition hover:border-[#36ADA3]/60 hover:bg-[#1F6761] disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#36ADA3]"
        >
          Re-Analyze
        </button>
      </div>

      {/* Deterministic, exact fundamentals from the filing's own inline XBRL —
          renders immediately, independent of the LM pipeline below. */}
      <FundamentalsPanel doc={doc} />

      {/* First-use Gemini Nano download — show progress instead of looking frozen. */}
      {downloadProgress !== null && (
        <div
          role="progressbar"
          aria-valuenow={Math.round(downloadProgress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="On-device model loading"
          className="flex flex-col gap-1"
        >
          <div className="flex justify-between text-[10px] text-zinc-500">
            <span>Loading on-device model…</span>
            <span>{Math.round(downloadProgress * 100)}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <m.div
              className="h-full rounded-full bg-sky-500"
              animate={{ width: `${downloadProgress * 100}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg bg-red-950/40 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-800/40">
          Analysis failed: {error}
        </div>
      )}

      {byRefSection && (
        <div className="rounded-lg bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200/90 ring-1 ring-inset ring-amber-800/40">
          <span className="font-medium">{byRefSection.label}</span> is incorporated by
          reference — its narrative isn’t included in this document (it lives in an
          exhibit or annual report), so the analysis below doesn’t cover it.
        </div>
      )}

      {!a && running && (
        <div className="rounded-xl bg-zinc-900 p-4 text-center ring-1 ring-zinc-800">
          <p className="animate-pulse text-xs text-zinc-400">Reading the document like an analyst…</p>
          <p className="mt-1 text-[10px] text-zinc-600">Runs fully on-device — larger filings take up to a minute.</p>
        </div>
      )}

      {a && (
        <>
          {/* 1–2 ── Snapshot (includes one-sentence summary + scores) */}
          <SnapshotCard analysis={a} />

          {/* Fiscal-calendar note — shown when the filing's fiscal-year labels
              don't match the calendar year of the period, so "fiscal 2027" in
              the takeaways below isn't mistaken for a wrong/future year. */}
          {fiscalOffset && (
            <div className="rounded-lg bg-sky-950/30 px-3 py-2 text-[11px] leading-relaxed text-sky-200/90 ring-1 ring-inset ring-sky-800/40">
              <span className="font-medium">Fiscal-calendar note:</span>{' '}
              {doc.companyName ?? doc.ticker ?? 'this company'}’s fiscal year{' '}
              {fiscalOffset.fiscalYear > fiscalOffset.calendarYear ? 'runs ahead of' : 'trails'} the
              calendar — the period ended {fmtCalendarDate(fiscalOffset.periodEnd)} falls in fiscal
              year {fiscalOffset.fiscalYear}. Mentions of “fiscal {fiscalOffset.fiscalYear}” below
              are quoted from the filing and don’t mean calendar {fiscalOffset.fiscalYear}.
            </div>
          )}

          {/* 3 ── Top takeaways (populated in both the LM and on-device tiers) */}
          <Collapse
            title="Top investor takeaways"
            count={a.topTakeaways.length}
            defaultOpen
            pending={running && !a.stagesDone.includes('takeaways')}
          >
            <InsightList insights={a.topTakeaways} emptyNote="Not enough information in this document." />
          </Collapse>

          {/* 4 ── What this means */}
          <Collapse
            title="What this means"
            count={
              a.revenueImpact.length + a.marginImpact.length +
              a.cashFlowImpact.length + a.balanceSheetHealth.length + a.shareImpact.length
            }
            pending={running && !a.stagesDone.includes('shares')}
          >
            <div className="flex flex-col gap-2.5">
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[#00C68D]">For revenue</p>
              <InsightList insights={a.revenueImpact} emptyNote="Not enough information." />
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[#00C68D]">For margins & profitability</p>
              <InsightList insights={a.marginImpact} emptyNote="Not enough information." />
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[#00C68D]">For cash flow & balance sheet</p>
              <InsightList
                insights={[...a.cashFlowImpact, ...a.balanceSheetHealth]}
                emptyNote="Not enough information."
              />
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[#00C68D]">For shares & investor sentiment</p>
              <InsightList insights={a.shareImpact} emptyNote="Not enough information." />
            </div>
          </Collapse>

          {/* 6 ── Risk signals */}
          <Collapse
            title="Risk signals"
            count={a.riskSignals.length}
            pending={running && !a.stagesDone.includes('risks')}
          >
            <InsightList insights={a.riskSignals} emptyNote="No material investor risks surfaced beyond boilerplate." />
          </Collapse>

          {/* 7 ── Management narrative check */}
          {a.managementNarrativeCheck.length > 0 && (
            <Collapse title="Management narrative check" count={a.managementNarrativeCheck.length}>
              <div className="flex flex-col gap-2">
                {a.managementNarrativeCheck.map((n, i) => (
                  <div key={i} className="rounded-lg bg-zinc-900 px-3 py-2.5 ring-1 ring-zinc-800">
                    <p className="text-xs font-medium text-zinc-200">“{n.claim}”</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{n.evidence}</p>
                    <p className="mt-1.5 text-[10px]">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ring-1 ring-inset ${
                        n.assessment === 'Supported' ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                        : n.assessment === 'Not Supported' ? 'bg-red-500/15 text-red-300 ring-red-500/30'
                        : 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
                      }`}>
                        {n.assessment}
                      </span>
                    </p>
                    {n.investorMeaning && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
                        <span className="font-medium text-[#00C68D]">Investor view: </span>{n.investorMeaning}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </Collapse>
          )}

          {/* 8 ── Bull vs bear */}
          {(a.bullCase.length > 0 || a.bearCase.length > 0) && (
            <Collapse title="Bull case vs bear case" defaultOpen>
              <div className="flex flex-col gap-2">
                {a.bullCase.length > 0 && (
                  <div className="rounded-lg bg-emerald-950/30 px-3 py-2.5 ring-1 ring-inset ring-emerald-800/30">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Bull case</p>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {a.bullCase.map((b, i) => (
                        <li key={i} className="border-l border-emerald-700/40 pl-2 text-[11px] leading-relaxed text-zinc-300">{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {a.bearCase.length > 0 && (
                  <div className="rounded-lg bg-red-950/30 px-3 py-2.5 ring-1 ring-inset ring-red-800/30">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-red-400">Bear case</p>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {a.bearCase.map((b, i) => (
                        <li key={i} className="border-l border-red-700/40 pl-2 text-[11px] leading-relaxed text-zinc-300">{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {a.netRead && (
                  <p className="px-1 text-[11px] leading-relaxed text-zinc-400">
                    <span className="font-medium text-zinc-500">Net read: </span>{a.netRead}
                  </p>
                )}
              </div>
            </Collapse>
          )}

          {/* 9 ── What to watch next */}
          {a.whatToWatchNext.length > 0 && (
            <Collapse title="What to watch next" count={a.whatToWatchNext.length}>
              <ul className="flex flex-col gap-2">
                {a.whatToWatchNext.map((w, i) => (
                  <li key={i} className="rounded-lg bg-zinc-900 px-3 py-2 ring-1 ring-zinc-800">
                    <p className="text-xs font-medium text-zinc-200">{w.item}</p>
                    {w.whyItMatters && (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">{w.whyItMatters}</p>
                    )}
                    {w.relatedMetric && (
                      <p className="mt-1 text-[9px] text-zinc-600">Metric: {w.relatedMetric}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Collapse>
          )}
        </>
      )}
    </section>
  );
}
