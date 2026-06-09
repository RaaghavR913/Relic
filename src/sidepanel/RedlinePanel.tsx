// ============================================================
// FilingLens — Year-over-year Redline side-panel component (Session 6)
// ------------------------------------------------------------
// "What changed" since last year's comparable filing. Triggers the SW redline
// pipeline (resolve prior → fetch → parse → align → diff), renders per-section
// change summaries + added/removed passages, and (builtin tier) upgrades each
// summary to natural language via the Prompt API.
//
// Accessibility (WCAG AA — never colour alone):
//   added passages   → "+ " prefix, left green border, green tint
//   removed passages → "− " prefix, line-through, red tint
// ============================================================

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { DocumentModel, SectionDiff, Section } from '@/types';
import type { GenerationTier } from '@/runtime/capabilities';
import type {
  ComputeRedlineMsg,
  RedlineResponse,
  RedlineProgressMsg,
  RedlinePriorInfo,
  AlignmentSummary,
  ContentShowRedlineMsg,
  ContentClearRedlineMsg,
} from '@/messages/types';
import type { DiffStats } from '@/redline/diff';
import { generateChangeSummary, createChangeSummarySession } from '@/redline/changeSummary';
import { getCachedRedline, putRedline } from '@/redline/redlineStore';

// ── helpers ───────────────────────────────────────────────────────────────────

async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

/** Lift a section-space added span into DOCUMENT space using the section offset. */
function liftAdded(diff: SectionDiff, section: Section | undefined): Array<[number, number]> {
  if (!section) return [];
  const base = section.charRange[0];
  return diff.added.map((s) => [base + s.range[0], base + s.range[1]] as [number, number]);
}

async function showOnPage(ranges: Array<[number, number]>): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentShowRedlineMsg = { target: 'content', type: 'SHOW_REDLINE', ranges };
  await chrome.tabs.sendMessage(tabId, msg);
}

async function clearOnPage(): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentClearRedlineMsg = { target: 'content', type: 'CLEAR_REDLINE' };
  await chrome.tabs.sendMessage(tabId, msg);
}

function magnitudeColor(m: number): string {
  if (m >= 0.4) return 'bg-red-500';
  if (m >= 0.15) return 'bg-amber-500';
  return 'bg-emerald-500';
}

// ── types ─────────────────────────────────────────────────────────────────────

type RunState = 'idle' | 'running' | 'done' | 'no_prior' | 'error';

interface ProgressState {
  stage: RedlineProgressMsg['stage'];
  progress: number;
  detail: string | undefined;
}

// ── span list ─────────────────────────────────────────────────────────────────

function SpanList({ diff }: { diff: SectionDiff }) {
  const MAX = 6;
  const added = diff.added.slice(0, MAX);
  const removed = diff.removed.slice(0, MAX);

  return (
    <div className="flex flex-col gap-1.5">
      {added.map((s, i) => (
        <p
          key={`a${i}`}
          className="rounded border-l-2 border-emerald-500 bg-emerald-500/10 px-2 py-1 text-[11px] leading-relaxed text-emerald-200"
        >
          <span aria-hidden="true" className="mr-1 font-mono font-bold text-emerald-400">+</span>
          <span className="sr-only">Added: </span>
          {s.text.length > 220 ? s.text.slice(0, 220) + '…' : s.text}
        </p>
      ))}
      {removed.map((s, i) => (
        <p
          key={`r${i}`}
          className="rounded border-l-2 border-red-500 bg-red-500/10 px-2 py-1 text-[11px] leading-relaxed text-red-300 line-through decoration-red-500/60"
        >
          <span aria-hidden="true" className="mr-1 font-mono font-bold text-red-400 no-underline">−</span>
          <span className="sr-only">Removed: </span>
          {s.text.length > 220 ? s.text.slice(0, 220) + '…' : s.text}
        </p>
      ))}
      {(diff.added.length > MAX || diff.removed.length > MAX) && (
        <p className="text-[10px] text-zinc-600">
          +{Math.max(0, diff.added.length - MAX)} more additions, {Math.max(0, diff.removed.length - MAX)} more removals not shown.
        </p>
      )}
    </div>
  );
}

// ── per-section card ──────────────────────────────────────────────────────────

function DiffCard({
  diff,
  section,
  summaryOverride,
}: {
  diff: SectionDiff;
  section: Section | undefined;
  summaryOverride: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = section?.label ?? diff.sectionId.replace(/_/g, ' ');
  const pct = Math.round(diff.magnitude * 100);
  const summary = summaryOverride ?? diff.summary;

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 px-3 py-2.5 ring-1 ring-zinc-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex-1 truncate text-xs font-semibold text-zinc-200">{label}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{pct}% changed</span>
      </div>

      {/* magnitude bar */}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${pct} percent of text changed`}
      >
        <div className={`h-full rounded-full ${magnitudeColor(diff.magnitude)}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>

      {/* change summary */}
      <p className="text-xs leading-relaxed text-zinc-300">{summary}</p>

      {/* actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-zinc-500 transition hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          aria-expanded={expanded}
        >
          {expanded ? 'Hide passages' : `Show passages (${diff.added.length}+ / ${diff.removed.length}−)`}
        </button>
        {diff.added.length > 0 && section && (
          <button
            onClick={() => void showOnPage(liftAdded(diff, section))}
            className="text-[11px] text-emerald-400 transition hover:text-emerald-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500"
            title="Highlight added passages in the filing"
          >
            ↗ Show on page
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden"
          >
            <SpanList diff={diff} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── alignment notes (added/removed whole sections) ────────────────────────────

function AlignmentNotes({ alignment }: { alignment: AlignmentSummary[] }) {
  const added = alignment.filter((a) => a.status === 'added');
  const removed = alignment.filter((a) => a.status === 'removed');
  if (added.length === 0 && removed.length === 0) return null;

  return (
    <div className="rounded-lg bg-zinc-900/60 px-3 py-2.5 ring-1 ring-zinc-800/60">
      <p className="mb-1.5 text-[10px] uppercase tracking-widest text-zinc-600">Structural changes</p>
      <div className="flex flex-col gap-1">
        {added.map((a) => (
          <p key={`na${a.id}`} className="text-[11px] text-emerald-300">
            <span aria-hidden="true" className="font-mono font-bold">+</span> New section: {a.label}
          </p>
        ))}
        {removed.map((a) => (
          <p key={`nr${a.id}`} className="text-[11px] text-red-300">
            <span aria-hidden="true" className="font-mono font-bold">−</span> Removed section: {a.label}
          </p>
        ))}
      </div>
    </div>
  );
}

// ── main panel ────────────────────────────────────────────────────────────────

interface RedlinePanelProps {
  doc: DocumentModel;
  detectedTier: GenerationTier;
}

export function RedlinePanel({ doc, detectedTier }: RedlinePanelProps) {
  const [state, setState] = useState<RunState>('idle');
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [diffs, setDiffs] = useState<SectionDiff[]>([]);
  const [stats, setStats] = useState<Record<string, DiffStats>>({});
  const [prior, setPrior] = useState<RedlinePriorInfo | null>(null);
  const [alignment, setAlignment] = useState<AlignmentSummary[]>([]);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const sectionById = useMemo(() => {
    const map = new Map<string, Section>();
    for (const s of doc.sections) map.set(s.id, s);
    return map;
  }, [doc.sections]);

  // Reset when the filing changes; load any cached redline.
  useEffect(() => {
    setState('idle');
    setDiffs([]);
    setStats({});
    setPrior(null);
    setAlignment([]);
    setSummaries({});
    setError('');
    void clearOnPage().catch(() => {});

    let alive = true;
    getCachedRedline(doc.rawTextHash)
      .then((cached) => {
        if (!alive || !cached) return;
        if (cached.status === 'no_prior') {
          setState('no_prior');
          setAlignment(cached.alignment);
          return;
        }
        setDiffs(cached.diffs);
        setAlignment(cached.alignment);
        setPrior(cached.prior ?? null);
        setState('done');
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [doc.rawTextHash]);

  // Listen for redline progress.
  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel' || msg.type !== 'REDLINE_PROGRESS') return;
      const m = msg as RedlineProgressMsg;
      setProgress({ stage: m.stage, progress: m.progress, detail: m.detail ?? undefined });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // Builtin-tier: upgrade each templated summary to natural language.
  // A single LM session is created for the whole loop so only the first section
  // pays warm-up cost; subsequent sections reuse the already-warm session.
  const upgradeSummaries = useCallback(
    async (incoming: SectionDiff[], incomingStats: Record<string, DiffStats>) => {
      if (detectedTier !== 'builtin') return;

      const session = await createChangeSummarySession();

      try {
        for (const diff of incoming) {
          const st = incomingStats[diff.sectionId];
          if (!st) continue;
          const label = sectionById.get(diff.sectionId)?.label ?? diff.sectionId;
          try {
            const text = await generateChangeSummary(label, diff, st, {
              tier: 'builtin',
              ...(session ? { session } : {}),
            });
            setSummaries((prev) => ({ ...prev, [diff.sectionId]: text }));
          } catch {
            /* keep templated */
          }
        }
      } finally {
        session?.destroy();
      }
    },
    [detectedTier, sectionById],
  );

  const run = useCallback(async () => {
    setState('running');
    setError('');
    setSummaries({});
    setProgress({ stage: 'resolving', progress: 0, detail: 'Starting…' });
    try {
      const msg: ComputeRedlineMsg = { target: 'sw', type: 'COMPUTE_REDLINE', doc };
      const resp = (await chrome.runtime.sendMessage(msg)) as RedlineResponse;

      if (!resp.ok) {
        setError(resp.error);
        setState('error');
        return;
      }

      setAlignment(resp.alignment);

      if (resp.status === 'no_prior') {
        setState('no_prior');
        await putRedline({
          rawTextHash: doc.rawTextHash,
          status: 'no_prior',
          diffs: [],
          alignment: resp.alignment,
          cachedAt: Date.now(),
        }).catch(() => {});
        return;
      }

      setDiffs(resp.diffs);
      setStats(resp.stats);
      setPrior(resp.prior ?? null);
      setState('done');

      await putRedline({
        rawTextHash: doc.rawTextHash,
        status: 'computed',
        diffs: resp.diffs,
        alignment: resp.alignment,
        ...(resp.prior ? { prior: resp.prior } : {}),
        cachedAt: Date.now(),
      }).catch(() => {});

      void upgradeSummaries(resp.diffs, resp.stats);
    } catch (err) {
      setError(String(err));
      setState('error');
    } finally {
      setProgress(null);
    }
  }, [doc, upgradeSummaries]);

  const totalChanges = useMemo(
    () => diffs.reduce((n, d) => n + d.added.length + d.removed.length, 0),
    [diffs],
  );

  return (
    <section aria-labelledby="redline-heading" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p id="redline-heading" className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
          What Changed (YoY)
        </p>
        <span className="ml-auto">
          <button
            onClick={() => void run()}
            disabled={state === 'running'}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
          >
            {state === 'running' ? 'Comparing…' : state === 'done' || state === 'no_prior' ? 'Re-compare' : 'Compare to prior year'}
          </button>
        </span>
      </div>

      {/* progress */}
      {state === 'running' && progress && (
        <div role="progressbar" aria-valuenow={Math.round(progress.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
            <span className="capitalize">{progress.detail ?? progress.stage}</span>
            <span>{Math.round(progress.progress * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <motion.div
              className="h-full rounded-full bg-violet-500"
              animate={{ width: `${progress.progress * 100}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>
      )}

      {/* error */}
      {state === 'error' && (
        <p className="rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300 ring-1 ring-inset ring-red-800/50" role="alert">
          {error}
        </p>
      )}

      {/* no prior */}
      {state === 'no_prior' && (
        <p className="rounded-lg bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-400 ring-1 ring-zinc-800/60">
          No prior comparable {doc.filingType} found on EDGAR for this company. A redline needs at least two
          filings of the same type.
        </p>
      )}

      {/* results */}
      {state === 'done' && (
        <div className="flex flex-col gap-3">
          {prior && (
            <div className="rounded-lg bg-zinc-900/60 px-3 py-2 text-[11px] text-zinc-400 ring-1 ring-zinc-800/60">
              Compared against {prior.form} filed {prior.filingDate} (period {prior.reportDate}).
              {' '}
              <a href={prior.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300 underline">
                View prior filing ↗
              </a>
              <div className="mt-0.5 text-zinc-600">{totalChanges} changed passages across {diffs.length} focus section(s).</div>
            </div>
          )}

          <AlignmentNotes alignment={alignment} />

          {diffs.length === 0 ? (
            <p className="text-xs text-zinc-500">No changes detected in the focus sections (Risk Factors, MD&amp;A).</p>
          ) : (
            <div className="flex flex-col gap-2" role="list" aria-label="Section diffs">
              {diffs.map((diff) => (
                <div key={diff.sectionId} role="listitem">
                  <DiffCard
                    diff={diff}
                    section={sectionById.get(diff.sectionId)}
                    summaryOverride={summaries[diff.sectionId]}
                  />
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => void clearOnPage()}
            className="self-start text-[11px] text-zinc-500 transition hover:text-zinc-300"
          >
            Clear on-page highlights
          </button>
        </div>
      )}

      {state === 'idle' && (
        <p className="text-[11px] leading-relaxed text-zinc-600">
          Fetches last year’s comparable filing from EDGAR and shows what changed in the Risk Factors and
          MD&amp;A — all diffing and summarization run on-device.
        </p>
      )}
    </section>
  );
}
