// ============================================================
// FilingLens — Ask-the-filing tab (Session 7)
// ------------------------------------------------------------
// Tier-aware Q&A over the current filing:
//   • tier 'builtin'    → retrieve() → Prompt API grounded synthesis, STREAMING,
//                         with inline [n] citations that deep-link to the source
//                         passage in the filing via positionMap.
//   • tier 'extractive' → retrieve() and display the top chunks as labelled
//                         "Relevant passages" with source anchors — no synthesis.
//
// The RAG index is built on first ask (BUILD_INDEX is idempotent); encoder
// download/embedding progress streams in via EMBED_PROGRESS.
//
// Privacy: questions are embedded and answered entirely on-device.
// ============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { DocumentModel } from '@/types';
import type { GenerationTier } from '@/runtime/capabilities';
import type { EmbedProgressMsg } from '@/messages/types';
import { Banner, ProgressBar, SkeletonCard, LockIcon } from './ui';
import {
  ensureIndex,
  retrievePassages,
  toPassages,
  highlightInFiling,
  clearFilingHighlights,
} from './qa/retrieve';
import {
  streamAnswer,
  parseCitations,
  templatedQaAnswer,
  createQaSession,
  type QaPassage,
  type LMSession,
} from './qa/synthesize';

const SUGGESTED = [
  'What are the most significant risk factors?',
  'How did revenue and margins change?',
  'What is management’s outlook or guidance?',
  'Are there any pending legal proceedings?',
];

const TOP_K = 6;

type IndexStage = EmbedProgressMsg['stage'];

interface AskState {
  query: string;
  asking: boolean;
  answer: string;          // streamed (builtin only)
  passages: QaPassage[];
  citations: number[];     // 1-based source numbers cited (builtin only)
  error: string;
  answered: boolean;       // a question has completed at least once
}

const INITIAL: AskState = {
  query: '',
  asking: false,
  answer: '',
  passages: [],
  citations: [],
  error: '',
  answered: false,
};

interface AskPanelProps {
  doc: DocumentModel;
  tier: GenerationTier;
}

export function AskPanel({ doc, tier }: AskPanelProps) {
  const reduced = useReducedMotion() ?? false;
  const [s, setS] = useState<AskState>(INITIAL);
  const [indexProgress, setIndexProgress] = useState<{ stage: IndexStage; value: number } | null>(null);
  const [nanoProgress, setNanoProgress] = useState<number | null>(null);
  const acRef = useRef<AbortController | null>(null);
  // Pooled LM session: created on first Q&A call, reused within the filing, disposed on filing change.
  const qaSessionRef = useRef<LMSession | null>(null);
  const builtin = tier === 'builtin';

  // Reset when the filing changes — dispose the pooled LM session so no context bleeds.
  useEffect(() => {
    acRef.current?.abort();
    setS(INITIAL);
    setIndexProgress(null);
    setNanoProgress(null);
    void clearFilingHighlights();
    qaSessionRef.current?.destroy();
    qaSessionRef.current = null;
  }, [doc.rawTextHash]);

  // Listen for index build progress (encoder load + embedding).
  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel' || msg.type !== 'EMBED_PROGRESS') return;
      const m = msg as EmbedProgressMsg;
      if (m.stage === 'complete' || m.stage === 'error') setIndexProgress(null);
      else setIndexProgress({ stage: m.stage, value: m.progress });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;

      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;

      setS((prev) => ({ ...prev, query: q, asking: true, answer: '', citations: [], error: '', passages: [] }));

      try {
        // 1. Ensure the vector index exists (idempotent).
        await ensureIndex(doc);
        if (ac.signal.aborted) return;

        // 2. Retrieve top-k passages.
        const results = await retrievePassages(doc.rawTextHash, q, TOP_K);
        if (ac.signal.aborted) return;
        const passages = toPassages(results, doc.sections);
        setS((prev) => ({ ...prev, passages }));

        if (passages.length === 0) {
          setS((prev) => ({ ...prev, asking: false, answered: true, answer: '' }));
          return;
        }

        // 3a. Extractive tier: deterministic templated answer, no model call.
        if (!builtin) {
          const answer = templatedQaAnswer(passages);
          setS((prev) => ({ ...prev, asking: false, answered: true, answer, citations: [] }));
          return;
        }

        // 3b. Built-in tier: stream a grounded answer.
        // Lazily create the pooled session on first ask; reuse on subsequent asks.
        if (!qaSessionRef.current) {
          qaSessionRef.current = await createQaSession({
            onDownloadProgress: (loaded) => setNanoProgress(loaded),
            signal: ac.signal,
          });
        }
        if (ac.signal.aborted) return;

        const full = await streamAnswer(q, passages, {
          ...(qaSessionRef.current ? { session: qaSessionRef.current } : {}),
          onToken: (text) => {
            if (ac.signal.aborted) return;
            setS((prev) => ({ ...prev, answer: text }));
          },
          onDownloadProgress: (loaded) => setNanoProgress(loaded),
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        setNanoProgress(null);
        setS((prev) => ({
          ...prev,
          asking: false,
          answered: true,
          answer: full,
          citations: parseCitations(full, passages.length),
        }));
      } catch (err) {
        if (ac.signal.aborted) return;
        setNanoProgress(null);
        // Discard a session that errored (e.g. context-window full) so the next
        // ask creates a fresh one rather than re-using a broken session.
        qaSessionRef.current?.destroy();
        qaSessionRef.current = null;
        setS((prev) => ({ ...prev, asking: false, error: String(err) }));
      }
    },
    [doc, builtin],
  );

  const stop = useCallback(() => {
    acRef.current?.abort();
    setS((prev) => ({ ...prev, asking: false }));
    setNanoProgress(null);
  }, []);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void ask(s.query);
    },
    [ask, s.query],
  );

  return (
    <section aria-labelledby="ask-heading" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p id="ask-heading" className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
          Ask the filing
        </p>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-zinc-600">
          <LockIcon className="h-3 w-3 text-emerald-500" /> on-device
        </span>
      </div>

      {/* Tier framing */}
      {builtin ? (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Answers are synthesized on-device by Gemini Nano, grounded only in passages retrieved
          from this filing, with citations you can open in the document.
        </p>
      ) : (
        <Banner tone="positive" icon="✓">
          Built-in AI isn’t available here, so FilingLens finds and shows the most relevant passages
          from the filing for your question — retrieval runs fully on-device.
        </Banner>
      )}

      {/* Question form */}
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={s.query}
            onChange={(e) => setS((prev) => ({ ...prev, query: e.target.value }))}
            placeholder="Ask about risks, revenue, guidance…"
            aria-label="Ask a question about this filing"
            className="flex-1 rounded-md bg-zinc-800 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-600 ring-1 ring-zinc-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          {s.asking ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-md bg-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-zinc-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!s.query.trim()}
              className="rounded-md bg-sky-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
            >
              Ask
            </button>
          )}
        </div>

        {/* Suggested questions */}
        {!s.answered && !s.asking && (
          <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
            {SUGGESTED.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void ask(q)}
                className="rounded-full bg-zinc-800/70 px-2.5 py-1 text-[11px] text-zinc-400 ring-1 ring-zinc-700/60 transition hover:bg-zinc-700 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </form>

      {/* Index build progress */}
      {indexProgress && (
        <ProgressBar
          value={indexProgress.value}
          label="Preparing on-device search index"
          detail={
            indexProgress.stage === 'model_load'
              ? 'Loading embedding model…'
              : indexProgress.stage === 'embedding'
                ? 'Embedding filing passages…'
                : 'Storing index…'
          }
        />
      )}

      {/* Nano download progress (first builtin ask) */}
      {nanoProgress !== null && (
        <ProgressBar value={nanoProgress} label="Chrome is downloading Gemini Nano" color="bg-emerald-500" />
      )}

      {/* Error */}
      {s.error && (
        <Banner tone="warn" icon="⚠">
          Couldn’t answer that: {s.error}
        </Banner>
      )}

      {/* Asking skeleton (before first token / passages) */}
      {s.asking && s.passages.length === 0 && !indexProgress && <SkeletonCard lines={2} />}

      {/* Answer (builtin: streamed; extractive: templated) */}
      <AnimatePresence>
        {(s.answer || (builtin && s.asking && s.passages.length > 0)) && (
          <motion.div
            key="answer"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl bg-zinc-900 p-3 ring-1 ring-zinc-800"
          >
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
              Answer {s.asking && <span className="ml-1 animate-pulse text-sky-400">▍</span>}
            </p>
            <AnswerText text={s.answer} citations={s.citations} passages={s.passages} />
            {!s.asking && (
              <p className="mt-2 text-[10px] italic text-zinc-600">
                {builtin
                  ? 'AI synthesis grounded in the cited passages — verify against the source.'
                  : 'Templated from retrieved passages — no AI synthesis.'}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* No passages found */}
      {s.answered && s.passages.length === 0 && !s.error && (
        <Banner tone="info">
          No relevant passages were found for that question in this filing.
        </Banner>
      )}

      {/* Sources / relevant passages */}
      {s.passages.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
              {builtin ? 'Sources' : 'Relevant passages'}
              <span className="ml-1.5 text-zinc-600">({s.passages.length})</span>
            </p>
            <button
              onClick={() => void clearFilingHighlights()}
              className="text-[10px] text-zinc-600 transition hover:text-zinc-400"
            >
              Clear highlights
            </button>
          </div>
          {s.passages.map((p, i) => (
            <PassageCard
              key={p.chunkId}
              n={i + 1}
              passage={p}
              cited={builtin ? s.citations.includes(i + 1) : true}
              showCitedState={builtin && s.answered}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── answer with clickable [n] citations ───────────────────────────────────────

function AnswerText({
  text,
  citations,
  passages,
}: {
  text: string;
  citations: number[];
  passages: QaPassage[];
}) {
  // Split on [n] tokens, rendering valid in-range citations as jump buttons.
  const parts = useMemo(() => text.split(/(\[\d{1,2}\])/g), [text]);
  return (
    <p className="text-xs leading-relaxed text-zinc-200">
      {parts.map((part, idx) => {
        const m = /^\[(\d{1,2})\]$/.exec(part);
        if (m) {
          const n = Number(m[1]);
          const passage = passages[n - 1];
          if (passage && (citations.length === 0 || citations.includes(n))) {
            return (
              <button
                key={idx}
                onClick={() => void highlightInFiling(passage.charRange)}
                title={`Source ${n}: ${passage.sectionLabel} — open in filing`}
                aria-label={`Open source ${n} in filing`}
                className="mx-px inline-flex items-center rounded bg-sky-500/15 px-1 text-[10px] font-semibold text-sky-300 align-baseline ring-1 ring-inset ring-sky-500/30 transition hover:bg-sky-500/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
              >
                {n}
              </button>
            );
          }
        }
        return <span key={idx}>{part}</span>;
      })}
    </p>
  );
}

// ── one source / passage card ─────────────────────────────────────────────────

function PassageCard({
  n,
  passage,
  cited,
  showCitedState,
}: {
  n: number;
  passage: QaPassage;
  cited: boolean;
  showCitedState: boolean;
}) {
  const dim = showCitedState && !cited;
  return (
    <div
      className={`rounded-lg bg-zinc-800/70 p-2.5 text-xs ring-1 transition ${
        showCitedState && cited ? 'ring-sky-500/40' : 'ring-zinc-700/50'
      } ${dim ? 'opacity-50' : ''}`}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-zinc-200">
          <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded bg-zinc-700 text-[10px] font-semibold text-zinc-300"
            aria-hidden="true"
          >
            {n}
          </span>
          <span className="leading-snug">{passage.sectionLabel}</span>
        </span>
        <button
          onClick={() => void highlightInFiling(passage.charRange)}
          title="Highlight in filing"
          aria-label={`Highlight passage ${n} in the filing`}
          className="shrink-0 rounded bg-sky-600/20 px-1.5 py-0.5 text-[10px] text-sky-300 transition hover:bg-sky-600/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          ↗ Show
        </button>
      </div>
      <p className="leading-relaxed text-zinc-400 line-clamp-4">{passage.text}</p>
    </div>
  );
}
