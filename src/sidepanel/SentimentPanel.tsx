// ============================================================
// FilingLens — Sentiment Heatmap side-panel component (Session 4)
// ------------------------------------------------------------
// Features:
//   • On/off toggle (persisted to chrome.storage.local).
//   • "Analyze Sentiment" button triggers FinBERT via offscreen worker.
//   • Progressive highlights: each section's results reach the filing as
//     SENTIMENT_SECTION_DONE events arrive — never blocking scroll.
//   • Per-section and document-level sentiment aggregates.
//   • Color legend with non-colour cues (solid/wavy underline shapes).
//   • Respects prefers-reduced-motion via useReducedMotion().
// ============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { DocumentModel, Section, SentenceSentiment } from '@/types';
import type {
  AnalyzeSentimentMsg,
  SentimentSectionDoneMsg,
  SentimentProgressMsg,
  SentimentResponse,
  ContentSentimentAddMsg,
  ContentClearSentimentMsg,
} from '@/messages/types';
import { setHeatmap } from './overlayPrefs';

// ── types ─────────────────────────────────────────────────────────────────────

type AnalysisStatus = 'idle' | 'loading' | 'done' | 'error';

interface SentimentAggregate {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function sendSentimentToContent(results: SentenceSentiment[]): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentSentimentAddMsg = {
    target: 'content',
    type: 'SENTIMENT_ADD_RANGES',
    results,
  };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function clearSentimentInContent(): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentClearSentimentMsg = { target: 'content', type: 'CLEAR_SENTIMENT' };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

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

// ── Legend ────────────────────────────────────────────────────────────────────

function SentimentLegend() {
  return (
    <div
      className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-zinc-400"
      aria-label="Sentiment heatmap legend"
    >
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-5 rounded-sm"
          style={{ background: 'rgba(34,197,94,0.32)', borderBottom: '2px solid rgba(34,197,94,0.9)' }}
          aria-hidden="true"
        />
        <span>Positive</span>
        <span className="text-zinc-600">(solid underline)</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-5 rounded-sm"
          style={{ background: 'rgba(239,68,68,0.32)', borderBottom: '2px dashed rgba(239,68,68,0.9)' }}
          aria-hidden="true"
        />
        <span>Negative</span>
        <span className="text-zinc-600">(wavy underline)</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-5 rounded-sm"
          style={{ background: 'rgba(161,161,170,0.15)' }}
          aria-hidden="true"
        />
        <span>Neutral</span>
      </div>
      <div className="flex items-center gap-1.5 w-full text-zinc-600">
        Opacity = confidence · Table regions excluded
      </div>
    </div>
  );
}

// ── SectionSentimentRow ───────────────────────────────────────────────────────

function SectionSentimentRow({
  section,
  agg,
  reducedMotion,
}: {
  section: Section;
  agg: SentimentAggregate;
  reducedMotion: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (agg.total === 0) return null;

  return (
    <div className="rounded-lg bg-zinc-900 ring-1 ring-zinc-800 overflow-hidden">
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-zinc-800/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
        aria-label={`${section.label} sentiment: ${pct(agg.positive, agg.total)}% positive, ${pct(agg.negative, agg.total)}% negative`}
      >
        <span className="flex-1 truncate text-xs font-medium text-zinc-200 leading-snug">
          {section.label}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-500">{agg.total} sent.</span>
        {/* Mini bar */}
        <div className="flex h-2 w-14 shrink-0 overflow-hidden rounded-full bg-zinc-800" aria-hidden="true">
          {agg.positive > 0 && (
            <div
              className="h-full bg-green-500/70"
              style={{ width: `${(agg.positive / agg.total) * 100}%` }}
            />
          )}
          {agg.neutral > 0 && (
            <div
              className="h-full bg-zinc-600/60"
              style={{ width: `${(agg.neutral / agg.total) * 100}%` }}
            />
          )}
          {agg.negative > 0 && (
            <div
              className="h-full bg-red-500/70"
              style={{ width: `${(agg.negative / agg.total) * 100}%` }}
            />
          )}
        </div>
        <svg
          className={`h-3.5 w-3.5 text-zinc-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </div>

      <AnimatePresence>
        {expanded && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="border-t border-zinc-800/60 px-3 pb-3 pt-2.5">
              <SentimentBar agg={agg} reducedMotion={reducedMotion} />
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

interface SentimentPanelProps {
  doc: DocumentModel;
}

export function SentimentPanel({ doc }: SentimentPanelProps) {
  const reducedMotion = useReducedMotion() ?? false;

  const sections = useMemo(
    () => [...doc.sections].sort((a, b) => a.order - b.order),
    [doc],
  );

  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [progress, setProgress] = useState<{ stage: string; value: number; detail?: string } | null>(null);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  // Accumulate results keyed by sectionId for aggregates + progressive highlights.
  const resultsRef = useRef<Map<string, SentenceSentiment[]>>(new Map());
  const [aggregates, setAggregates] = useState<Record<string, SentimentAggregate>>({});

  // ── listen for progressive section results ─────────────────────────────────

  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel') return;

      if (msg.type === 'SENTIMENT_SECTION_DONE') {
        const m = msg as SentimentSectionDoneMsg;

        // Accumulate results.
        const existing = resultsRef.current.get(m.sectionId) ?? [];
        const merged = [...existing, ...m.results];
        resultsRef.current.set(m.sectionId, merged);

        // Update aggregate for this section.
        setAggregates((prev) => ({
          ...prev,
          [m.sectionId]: computeAggregate(merged),
        }));

        // Progressive highlight — always push to the page; the content script
        // paints only when the master heatmap overlay is on (OverlayControls).
        if (m.results.length > 0) {
          void sendSentimentToContent(m.results);
        }

        // Update progress bar.
        setProgress({
          stage: 'classifying',
          value: (m.sectionIdx + 1) / m.totalSections,
          detail: `Scored ${m.sectionIdx + 1}/${m.totalSections} sections`,
        });
      }

      if (msg.type === 'SENTIMENT_PROGRESS') {
        const m = msg as SentimentProgressMsg;
        if (m.stage === 'model_load') {
          setProgress({ stage: 'Loading FinBERT…', value: m.progress, ...(m.detail !== undefined ? { detail: m.detail } : {}) });
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

    // Reset accumulated results for a fresh run; clear the page cache so re-runs
    // don't double-accumulate ranges in the content script.
    resultsRef.current.clear();
    setAggregates({});
    setStatus('loading');
    setError('');
    setElapsedMs(null);
    setFromCache(false);
    setProgress({ stage: 'Starting…', value: 0 });
    await clearSentimentInContent();

    // Turn the page heatmap overlay on so results are visible as they stream in.
    setHeatmap(true);

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

  return (
    <section aria-labelledby="sentiment-heading" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <p
          id="sentiment-heading"
          className="text-[13px] font-medium uppercase tracking-widest text-zinc-500 font-[Times,serif]"
        >
          Sentiment Heatmap
        </p>
        {isDone && elapsedMs !== null && (
          <span className="ml-auto text-[10px] text-zinc-600">
            {fromCache ? 'cached' : `${elapsedMs.toLocaleString()} ms`}
          </span>
        )}
      </div>

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

      {/* Document-level aggregate */}
      {docAggregate.total > 0 && (
        <div className="rounded-xl bg-zinc-900 p-3 ring-1 ring-zinc-800">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            Filing overall · {docAggregate.total} sentences
          </p>
          <SentimentBar agg={docAggregate} reducedMotion={reducedMotion} />
        </div>
      )}

      {/* Legend */}
      {docAggregate.total > 0 && (
        <div className="rounded-lg bg-zinc-900/50 px-3 py-2.5 ring-1 ring-dashed ring-zinc-800">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            Legend
          </p>
          <SentimentLegend />
        </div>
      )}

      {/* Per-section rows */}
      {Object.keys(aggregates).length > 0 && (
        <div className="flex flex-col gap-2">
          {sections.map((section) => {
            const agg = aggregates[section.id];
            if (!agg || agg.total === 0) return null;
            return (
              <SectionSentimentRow
                key={section.id}
                section={section}
                agg={agg}
                reducedMotion={reducedMotion}
              />
            );
          })}
        </div>
      )}

      {/* Re-analyze button when done */}
      {isDone && (
        <button
          onClick={() => void analyze()}
          className="w-full rounded-md bg-zinc-800/50 py-1.5 text-[11px] text-zinc-500 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-300 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          aria-label="Re-run sentiment analysis"
        >
          Re-analyze
        </button>
      )}
    </section>
  );
}
