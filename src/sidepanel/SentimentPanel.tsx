// ============================================================
// Relic — Sentiment side-panel component (Session 4)
// ------------------------------------------------------------
// Features:
//   • "Analyze Sentiment" button triggers FinBERT via offscreen worker.
//   • Streams SENTIMENT_SECTION_DONE events to build the aggregate without
//     blocking scroll.
//   • Document-level sentiment consensus with a plain-language summary.
//   • Respects prefers-reduced-motion via useReducedMotion().
// ============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { DocumentModel, SentenceSentiment } from '@/types';
import type {
  AnalyzeSentimentMsg,
  SentimentSectionDoneMsg,
  SentimentProgressMsg,
  SentimentResponse,
} from '@/messages/types';
import { useReportAnalysisActivity } from './analysisActivity';

// ── types ─────────────────────────────────────────────────────────────────────

type AnalysisStatus = 'idle' | 'loading' | 'done' | 'error';

interface SentimentAggregate {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function computeAggregate(results: SentenceSentiment[]): SentimentAggregate {
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const r of results) {
    if (r.label === 'positive') positive++;
    else if (r.label === 'negative') negative++;
    else neutral++;
  }
  return { positive, negative, neutral, total: results.length };
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

// Plain-language read of the document-level aggregate: one or two sentences
// describing the overall tone and the positive/negative balance.
function consensusSummary(agg: SentimentAggregate): string {
  const { positive, negative, total } = agg;
  if (total === 0) return '';

  const posP = pct(positive, total);
  const negP = pct(negative, total);
  const neuP = pct(agg.neutral, total);
  const net = posP - negP;

  const composition =
    neuP >= 60
      ? 'overwhelmingly neutral, as is typical of measured disclosure language'
      : neuP >= 40
        ? 'largely neutral, with pockets of directional tone'
        : 'unusually opinionated for a filing, with little neutral language';

  let lean: string;
  if (net >= 8) {
    lean = `Positive statements (${posP}%) outweigh negative ones (${negP}%), giving the filing an optimistic tilt.`;
  } else if (net <= -8) {
    lean = `Negative statements (${negP}%) outweigh positive ones (${posP}%), pointing to a cautious, risk-heavy tone.`;
  } else {
    lean = `Positive (${posP}%) and negative (${negP}%) statements are roughly balanced, leaving no strong directional bias.`;
  }

  return `The filing's tone is ${composition}. ${lean}`;
}

// ── SentimentBar ─────────────────────────────────────────────────────────────

function SentimentBar({
  agg,
  reducedMotion,
}: {
  agg: SentimentAggregate;
  reducedMotion: boolean;
}) {
  const { positive, negative, neutral, total } = agg;
  if (total === 0) return null;

  const posP = (positive / total) * 100;
  const negP = (negative / total) * 100;
  const neuP = (neutral / total) * 100;

  const transition = reducedMotion ? { duration: 0 } : { duration: 0.4 };

  return (
    <div>
      {/* Stacked bar */}
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800"
        role="img"
        aria-label={`Sentiment: ${pct(positive, total)}% positive, ${pct(negative, total)}% negative, ${pct(neutral, total)}% neutral`}
      >
        {posP > 0 && (
          <m.div
            className="h-full bg-green-500/70"
            initial={{ width: 0 }}
            animate={{ width: `${posP}%` }}
            transition={transition}
          />
        )}
        {neuP > 0 && (
          <m.div
            className="h-full bg-zinc-600/60"
            initial={{ width: 0 }}
            animate={{ width: `${neuP}%` }}
            transition={{ ...transition, delay: reducedMotion ? 0 : 0.1 }}
          />
        )}
        {negP > 0 && (
          <m.div
            className="h-full bg-red-500/70"
            initial={{ width: 0 }}
            animate={{ width: `${negP}%` }}
            transition={{ ...transition, delay: reducedMotion ? 0 : 0.2 }}
          />
        )}
      </div>

      {/* Numeric labels (non-colour, accessible) */}
      <div className="mt-1 flex justify-between text-[10px] text-zinc-500" aria-hidden="true">
        <span className="text-green-400">{pct(positive, total)}% pos</span>
        <span>{pct(neutral, total)}% neu</span>
        <span className="text-red-400">{pct(negative, total)}% neg</span>
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

interface SentimentPanelProps {
  doc: DocumentModel;
}

export function SentimentPanel({ doc }: SentimentPanelProps) {
  const reducedMotion = useReducedMotion() ?? false;

  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [progress, setProgress] = useState<{ stage: string; value: number; detail?: string } | null>(null);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  // Accumulate results keyed by sectionId to build the document-level aggregate.
  const resultsRef = useRef<Map<string, SentenceSentiment[]>>(new Map());
  const [aggregates, setAggregates] = useState<Record<string, SentimentAggregate>>({});

  // ── listen for progressive section results ─────────────────────────────────

  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel') return;

      if (msg.type === 'SENTIMENT_SECTION_DONE') {
        const m = msg as SentimentSectionDoneMsg;

        // Accumulate results + this section's aggregate. The progress bar is driven
        // by the finer-grained SENTIMENT_PROGRESS 'classifying' messages
        // (sentence-level value + ETA) — sections now finish in priority order, not
        // document order, so a section-index bar would jump backwards.
        const existing = resultsRef.current.get(m.sectionId) ?? [];
        const merged = [...existing, ...m.results];
        resultsRef.current.set(m.sectionId, merged);

        setAggregates((prev) => ({
          ...prev,
          [m.sectionId]: computeAggregate(merged),
        }));
      }

      if (msg.type === 'SENTIMENT_PROGRESS') {
        const m = msg as SentimentProgressMsg;
        if (m.stage === 'model_load') {
          setProgress({ stage: 'Loading FinBERT…', value: m.progress, ...(m.detail !== undefined ? { detail: m.detail } : {}) });
        } else if (m.stage === 'classifying') {
          setProgress({ stage: 'classifying', value: m.progress, ...(m.detail !== undefined ? { detail: m.detail } : {}) });
        } else if (m.stage === 'complete' || m.stage === 'error') {
          setProgress(null);
        }
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── analyze ────────────────────────────────────────────────────────────────

  const analyze = useCallback(async () => {
    if (status === 'loading') return;

    // Reset accumulated results for a fresh run.
    resultsRef.current.clear();
    setAggregates({});
    setStatus('loading');
    setError('');
    setElapsedMs(null);
    setFromCache(false);
    setProgress({ stage: 'Starting…', value: 0 });

    try {
      const msg: AnalyzeSentimentMsg = {
        target: 'sw',
        type: 'ANALYZE_SENTIMENT',
        rawTextHash: doc.rawTextHash,
        sections: doc.sections,
      };
      const resp = (await chrome.runtime.sendMessage(msg)) as SentimentResponse;

      if (resp.ok) {
        setStatus('done');
        setElapsedMs(resp.elapsedMs);
        setFromCache(resp.fromCache);
      } else {
        setStatus('error');
        setError(resp.error);
      }
    } catch (err) {
      setStatus('error');
      setError(String(err));
    } finally {
      setProgress(null);
    }
  }, [doc, status]);

  // ── re-apply when doc changes ──────────────────────────────────────────────
  // Reset state when a new filing is loaded.
  const prevHashRef = useRef(doc.rawTextHash);
  useEffect(() => {
    if (prevHashRef.current === doc.rawTextHash) return;
    prevHashRef.current = doc.rawTextHash;
    resultsRef.current.clear();
    setAggregates({});
    setStatus('idle');
    setError('');
    setElapsedMs(null);
    setFromCache(false);
    setProgress(null);
  }, [doc.rawTextHash]);

  // ── document-level aggregate ───────────────────────────────────────────────
  const docAggregate = useMemo<SentimentAggregate>(() => {
    let pos = 0;
    let neg = 0;
    let neu = 0;
    for (const agg of Object.values(aggregates)) {
      pos += agg.positive;
      neg += agg.negative;
      neu += agg.neutral;
    }
    return { positive: pos, negative: neg, neutral: neu, total: pos + neg + neu };
  }, [aggregates]);

  const isLoading = status === 'loading';
  const isDone = status === 'done';
  const isError = status === 'error';

  useReportAnalysisActivity(isLoading);

  return (
    <section aria-label="Sentiment" className="flex flex-col gap-3">
      {isDone && elapsedMs !== null && (
        <div className="flex justify-end">
          <span className="text-[10px] text-zinc-600">
            {fromCache ? 'cached' : `${elapsedMs.toLocaleString()} ms`}
          </span>
        </div>
      )}

      {/* Analyze button */}
      {status !== 'done' && (
        <button
          onClick={() => void analyze()}
          disabled={isLoading}
          className="w-full rounded-md bg-zinc-800 py-2 text-xs font-medium text-zinc-300 ring-1 ring-zinc-700 hover:bg-zinc-700 hover:text-zinc-100 transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          aria-label="Run FinBERT sentiment analysis on this filing"
        >
          {isLoading ? 'Analyzing…' : 'Analyze Sentiment'}
        </button>
      )}

      {/* Progress bar */}
      <AnimatePresence>
        {progress && (
          <m.div
            key="progress"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.15 }}
            className="overflow-hidden"
            role="progressbar"
            aria-valuenow={Math.round(progress.value * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={progress.detail ?? progress.stage}
          >
            <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
              <span>{progress.detail ?? progress.stage}</span>
              <span>{Math.round(progress.value * 100)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <m.div
                className="h-full rounded-full bg-green-500"
                animate={{ width: `${progress.value * 100}%` }}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.3 }}
              />
            </div>
          </m.div>
        )}
      </AnimatePresence>

      {/* Error */}
      {isError && (
        <div
          className="rounded-lg bg-red-950/40 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-800/50"
          role="alert"
        >
          <span className="font-semibold">Analysis failed: </span>{error}
        </div>
      )}

      {/* Document-level consensus */}
      {docAggregate.total > 0 && (
        <div className="rounded-xl bg-zinc-900 p-3 ring-1 ring-zinc-800">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            Filing overall · {docAggregate.total} sentences
          </p>
          <SentimentBar agg={docAggregate} reducedMotion={reducedMotion} />

          {/* Plain-language summary of the consensus */}
          <p className="mt-3 border-t border-zinc-800/60 pt-2.5 text-[11px] leading-relaxed text-zinc-400">
            {consensusSummary(docAggregate)}
          </p>
        </div>
      )}

      {/* Re-analyze button when done */}
      {isDone && (
        <button
          onClick={() => void analyze()}
          className="flex w-full items-center justify-center rounded-[4px] border border-sky-500/40 px-3 py-2 text-[13px] font-[Georgia,serif] font-medium text-sky-400 transition hover:border-sky-400/60 hover:bg-zinc-900/50 hover:text-sky-300 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          aria-label="Re-run sentiment analysis"
        >
          Re-analyze
        </button>
      )}
    </section>
  );
}
