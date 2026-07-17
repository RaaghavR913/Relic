// ============================================================
// Relic — Section Summaries side-panel component (Session 3)
// ============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import type { DocumentModel, Section } from '@/types';
import { probePromptApiAvailability, type GenerationTier } from '@/runtime/capabilities';
import { summarizeSection, getCachedSummaryWithFallback, DISCLAIMER } from '@/summarizer/summarize';
import type { EmbedProgressMsg } from '@/messages/types';
import { isLowConfidenceGeneric, isEdgarExhibit } from '@/content/ingest/detect';
import { useReportAnalysisActivity } from './analysisActivity';

// ── constants ─────────────────────────────────────────────────────────────────

const DEV_FORCE_KEY = 'relic:devForceMode';

/**
 * Cap the text fed to extractive summarization on summary-only pages (news /
 * low-confidence generic): the fallback segmenter puts the ENTIRE page in one
 * document_body section, and embedding a heavy portal page means hundreds of
 * WASM batches on a low-end laptop. Real SEC filings are never capped. A prefix
 * slice keeps every section-space anchor valid.
 */
const EXTRACTIVE_CAP_CHARS = 24_000;

// Sections worth auto-summarizing first (by canonical id prefix).
const PRIORITY_IDS = [
  'item_7_mdna', 'item_7a', 'item_1a_risk', 'item_1_business',
  'part_ii_item_7', 'part_i_item_1a', 'part_i_item_1',
];

// ── types ─────────────────────────────────────────────────────────────────────

type SectionStatus = 'idle' | 'loading' | 'done' | 'error';

interface SectionState {
  status: SectionStatus;
  summary?: string;
  anchors?: ReadonlyArray<[number, number]>;
  analystAvailable?: boolean;
  fromCache?: boolean;
  /** True when the source text was capped to EXTRACTIVE_CAP_CHARS (summary-only pages). */
  truncated?: boolean;
  error?: string;
}

/** What the single progress bar is currently tracking. */
interface LoadProgress {
  /** 'nano' = Chrome's one-time Gemini Nano download; 'encoder' = bundled encoder model load. */
  source: 'nano' | 'encoder';
  /** 0..1 */
  value: number;
  /** No real percentage available — render an indeterminate bar. */
  indeterminate?: boolean;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Very lightweight markdown → readable text renderer for key-points output. */
function MarkdownText({ md }: { md: string }) {
  const lines = md.split('\n');
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const stripped = line.replace(/^\s*[*\-•]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1');
        if (!stripped.trim()) return null;
        const isBullet = /^\s*[*\-•]/.test(line);
        return (
          <p key={i} className={`text-xs leading-relaxed text-zinc-300 ${isBullet ? 'pl-3 border-l border-zinc-700' : ''}`}>
            {stripped}
          </p>
        );
      })}
    </div>
  );
}

async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function highlightDocRange(anchor: [number, number], section: Section): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  // Lift SECTION-space → DOCUMENT-space for HIGHLIGHT_RANGE.
  const docRange: [number, number] = [
    section.charRange[0] + anchor[0],
    section.charRange[0] + anchor[1],
  ];
  await chrome.tabs.sendMessage(tabId, {
    target: 'content',
    type: 'HIGHLIGHT_RANGE',
    charRange: docRange,
  });
}

async function clearDocHighlights(): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, {
    target: 'content',
    type: 'CLEAR_HIGHLIGHTS',
  });
}

// ── SectionCard ───────────────────────────────────────────────────────────────

function SectionCard({
  section,
  state,
  onSummarize,
  onJumpTo,
}: {
  section: Section;
  state: SectionState;
  onSummarize: () => void;
  onJumpTo: (anchor: [number, number]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDone = state.status === 'done';
  const isLoading = state.status === 'loading';
  const isError = state.status === 'error';

  const anchors = state.anchors ?? [];

  return (
    <div className="rounded-lg bg-zinc-900 ring-1 ring-zinc-800 overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none hover:bg-zinc-800/50 transition-colors"
        onClick={() => { if (isDone) setExpanded((v) => !v); }}
        role={isDone ? 'button' : undefined}
        aria-expanded={isDone ? expanded : undefined}
      >
        <span className="flex-1 text-xs font-medium text-zinc-200 leading-snug truncate">
          {section.label}
        </span>

        {state.fromCache && isDone && (
          <span className="text-[10px] text-zinc-600 shrink-0">cached</span>
        )}

        {isLoading && (
          <span className="text-[10px] text-sky-400 shrink-0 animate-pulse">
            Analyzing…
          </span>
        )}

        {isError && (
          <span className="text-[10px] text-red-400 shrink-0" title={state.error}>
            Error
          </span>
        )}

        {state.status === 'idle' && (
          <button
            onClick={(e) => { e.stopPropagation(); onSummarize(); }}
            className="rounded px-2 py-0.5 text-[11px] font-medium bg-sky-700/30 text-sky-400 hover:bg-sky-700/50 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 shrink-0"
            aria-label={`Summarize ${section.label}`}
          >
            Summarize
          </button>
        )}

        {isDone && (
          <svg
            className={`h-3.5 w-3.5 text-zinc-500 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
            viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
          >
            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
          </svg>
        )}
      </div>

      {/* Expanded summary */}
      <AnimatePresence>
        {isDone && expanded && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 border-t border-zinc-800/60">
              <div className="pt-2.5">
                {/* Summary text */}
                {!state.analystAvailable ? (
                  // No analyst note (extractive / fallback): show each key sentence
                  // as a separate bullet with a jump link.
                  <div className="space-y-1.5">
                    {anchors.map((anchor, idx) => {
                      const sentText = section.text.slice(anchor[0], anchor[1]);
                      return (
                        <div key={idx} className="flex items-start gap-2 group">
                          <p className="flex-1 text-xs leading-relaxed text-zinc-300 pl-3 border-l border-zinc-700">
                            {sentText}
                          </p>
                          <button
                            onClick={() => onJumpTo(anchor)}
                            title="Highlight in filing"
                            className="shrink-0 mt-0.5 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:text-sky-400 hover:bg-sky-900/20 transition opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-sky-500"
                            aria-label="Highlight sentence in filing"
                          >
                            ↗
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  // Analyst note: render markdown + single jump-to-section
                  <div className="flex flex-col gap-2">
                    <MarkdownText md={state.summary ?? ''} />
                    {anchors[0] !== undefined && (
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          onClick={() => onJumpTo(anchors[0]!)}
                          className="self-start text-[11px] text-sky-500 hover:text-sky-300 transition focus-visible:outline focus-visible:outline-sky-500"
                          aria-label="Jump to section in filing"
                        >
                          ↗ Jump to section
                        </button>
                        <button
                          onClick={() => void clearDocHighlights()}
                          className="self-start text-[11px] text-zinc-500 hover:text-zinc-300 transition focus-visible:outline focus-visible:outline-sky-500"
                          aria-label="Remove highlight from filing"
                        >
                          Remove highlight
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Truncation footnote (summary-only pages capped at EXTRACTIVE_CAP_CHARS) */}
                {state.truncated && (
                  <p className="mt-2 text-[10px] text-zinc-600">
                    Summarized from the first part of the page.
                  </p>
                )}

                {/* Disclaimer */}
                <p className="mt-2.5 text-[10px] text-zinc-600 italic">{DISCLAIMER}</p>
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

interface SummaryPanelProps {
  doc: DocumentModel;
  detectedTier: GenerationTier;
}

export function SummaryPanel({ doc, detectedTier }: SummaryPanelProps) {
  const sections = useMemo(
    () => [...doc.sections].sort((a, b) => a.order - b.order),
    [doc],
  );

  const [states, setStates] = useState<Record<string, SectionState>>(() =>
    Object.fromEntries(sections.map((s) => [s.id, { status: 'idle' as const }])),
  );
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);

  // Dev: force mode override
  const [forceMode, setForceMode] = useState<GenerationTier | null>(null);
  const [forceModeReady, setForceModeReady] = useState(false);

  // Is Gemini Nano actually ON DISK right now? getCapabilities() counts merely
  // *downloadable* toward the 'builtin' tier, which is exactly how a first-run
  // auto-summarize used to attach Chrome's one-time ~2 GB download to a page
  // load (and freeze at whatever fraction the download stalled on). null =
  // probe still in flight; effects that pick a tier wait for it.
  const [nanoReady, setNanoReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    probePromptApiAvailability()
      .then((state) => { if (!cancelled) setNanoReady(state === 'available'); })
      .catch(() => { if (!cancelled) setNanoReady(false); });
    return () => { cancelled = true; };
  }, []);

  // AbortControllers keyed by sectionId for in-flight summarizations.
  const acRefs = useRef<Record<string, AbortController>>({});

  // Track which doc hash has already been auto-triggered so we fire exactly once
  // per filing load even if the effect re-runs due to unrelated dep changes.
  const autoTriggeredForRef = useRef<string | null>(null);

  // The dev-only tier override is stripped from production builds: `forceMode`
  // can only be set through the DevSettings UI, which is gated out below, but we
  // also hard-gate the override path here so a stale persisted value can never
  // change the tier in production.
  //
  // Extractive-first: the builtin tier is used only when Nano is on disk NOW.
  // When it is merely downloadable/downloading, summaries run instantly on the
  // WASM extractive path instead of triggering (or attaching to) the 2 GB
  // download — the same policy AnalystPanel applies to low-value pages. The
  // next panel mount re-probes, so the tier upgrades once the download lands.
  const effectiveTier: GenerationTier =
    (import.meta.env.DEV ? forceMode : null) ??
    (detectedTier === 'builtin' && nanoReady === true ? 'builtin' : 'extractive');
  const extractiveTier = effectiveTier === 'extractive';

  // Summary-only pages — SEC data/report, EDGAR filing index, exhibit, or
  // low-confidence generic — have no investor sections to prioritize. Mirrors
  // hidesInvestorTabs() in App.tsx; keep the two in sync.
  const summaryOnlyPage = useMemo(
    () =>
      doc.filingType === 'DATA_REPORT' ||
      doc.source.category === 'edgar_index' ||
      isEdgarExhibit(doc) ||
      isLowConfidenceGeneric(doc),
    [doc],
  );

  // ── Load force mode + cached results ──────────────────────────────────────

  useEffect(() => {
    chrome.storage.local.get(DEV_FORCE_KEY).then((data) => {
      const stored = data[DEV_FORCE_KEY] as GenerationTier | null | undefined;
      setForceMode(stored ?? null);
      setForceModeReady(true);
    }).catch(() => setForceModeReady(true));
  }, []);

  useEffect(() => {
    if (!forceModeReady || nanoReady === null) return;
    // Populate cached summaries on mount (or when tier changes).
    for (const section of sections) {
      getCachedSummaryWithFallback(doc.rawTextHash, section.id, effectiveTier)
        .then((entry) => {
          if (!entry) return;
          setStates((prev) => ({
            ...prev,
            [section.id]: {
              status: 'done',
              summary: entry.analyst,
              anchors: entry.plainAnchors,
              analystAvailable: entry.register === 'builtin',
              fromCache: true,
            },
          }));
        })
        .catch(console.warn);
    }
  }, [sections, doc.rawTextHash, effectiveTier, forceModeReady, nanoReady]);

  // Reset states when tier changes (different cache key).
  useEffect(() => {
    setStates(Object.fromEntries(sections.map((s) => [s.id, { status: 'idle' as const }])));
  }, [effectiveTier, sections]);

  // Listen for EMBED_PROGRESS (bundled encoder model load during extractive).
  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel' || msg.type !== 'EMBED_PROGRESS') return;
      const m = msg as EmbedProgressMsg;
      if (m.stage === 'model_load') {
        setLoadProgress({
          source: 'encoder',
          value: m.progress,
          ...(m.indeterminate ? { indeterminate: true } : {}),
        });
      } else if (m.stage === 'complete' || m.stage === 'error') {
        setLoadProgress(null);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── summarize one section ──────────────────────────────────────────────────

  const summarize = useCallback(async (section: Section) => {
    // Abort any in-flight call for this section.
    acRefs.current[section.id]?.abort();
    const ac = new AbortController();
    acRefs.current[section.id] = ac;

    setStates((prev) => ({ ...prev, [section.id]: { status: 'loading' } }));

    // Summary-only pages get a prefix cap so a heavy news portal doesn't turn
    // into hundreds of WASM embed batches. Never applied to real SEC filings.
    const truncated = summaryOnlyPage && section.text.length > EXTRACTIVE_CAP_CHARS;
    const target = truncated
      ? { ...section, text: section.text.slice(0, EXTRACTIVE_CAP_CHARS) }
      : section;

    try {
      const result = await summarizeSection(target, doc, {
        effectiveTier,
        onDownloadProgress: (p) => setLoadProgress({ source: 'nano', value: p }),
        signal: ac.signal,
      });

      if (ac.signal.aborted) return;

      setStates((prev) => ({
        ...prev,
        [section.id]: {
          status: 'done',
          summary: result.summary,
          anchors: result.anchors,
          analystAvailable: result.analystAvailable,
          fromCache: result.fromCache,
          ...(truncated ? { truncated: true } : {}),
        },
      }));
    } catch (err) {
      if (ac.signal.aborted) return;
      setStates((prev) => ({
        ...prev,
        [section.id]: { status: 'error', error: String(err) },
      }));
    } finally {
      setLoadProgress(null);
      delete acRefs.current[section.id];
    }
  }, [doc, effectiveTier, summaryOnlyPage]);

  const summarizeAll = useCallback(async () => {
    for (const section of sections) {
      const s = states[section.id];
      if (s?.status === 'done' || s?.status === 'loading') continue;
      await summarize(section);
    }
  }, [sections, states, summarize]);

  // Auto-trigger: when a new filing loads, immediately summarize sections so the
  // user sees results with zero manual clicks. Runs once per doc hash;
  // IDB-cached sections are skipped to avoid the idle→loading→done flash on re-open.
  useEffect(() => {
    // Wait for both async gates (dev force-mode load AND the Nano on-disk
    // probe) so the first summarize call runs with the FINAL tier — the
    // autoTriggeredForRef latch means this effect fires once per doc.
    if (!forceModeReady || nanoReady === null) return;
    if (autoTriggeredForRef.current === doc.rawTextHash) return;
    autoTriggeredForRef.current = doc.rawTextHash;

    // Summary-only pages have no investor sections to prioritize, so summarize
    // every section and the user never has to click "Summarize All" after
    // "Analyze this page".
    if (summaryOnlyPage) {
      void (async () => {
        for (const section of sections) {
          if (acRefs.current[section.id] !== undefined) continue;
          const cached = await getCachedSummaryWithFallback(doc.rawTextHash, section.id, effectiveTier);
          if (cached) continue;
          await summarize(section);
        }
      })();
      return;
    }

    // SEC filings: auto-summarize the top 2–3 priority sections only.
    const prioritySections = PRIORITY_IDS
      .map((id) => sections.find((s) => s.id === id || s.id.startsWith(id)))
      .filter((s): s is Section => s !== undefined)
      .slice(0, 3);

    if (prioritySections.length === 0) return;

    void (async () => {
      for (const section of prioritySections) {
        // Skip if a concurrent manual trigger or summarizeAll is already running.
        if (acRefs.current[section.id] !== undefined) continue;
        // Skip if already in IDB cache — cache-pop effect will surface it instantly.
        const cached = await getCachedSummaryWithFallback(doc.rawTextHash, section.id, effectiveTier);
        if (cached) continue;
        await summarize(section);
      }
    })();
  }, [doc, effectiveTier, forceModeReady, nanoReady, sections, summarize, summaryOnlyPage]);

  // ── jump to source ─────────────────────────────────────────────────────────

  const jumpTo = useCallback(async (anchor: [number, number], section: Section) => {
    try {
      await highlightDocRange(anchor, section);
    } catch {
      // Silently ignore (tab may not have the content script)
    }
  }, []);

  // ── save force mode ────────────────────────────────────────────────────────

  const setAndPersistForceMode = useCallback((mode: GenerationTier | null) => {
    setForceMode(mode);
    chrome.storage.local.set({ [DEV_FORCE_KEY]: mode }).catch(console.warn);
  }, []);

  // ── counts for Summarize All button ───────────────────────────────────────

  const doneCount = sections.filter((s) => states[s.id]?.status === 'done').length;
  const allDone = doneCount === sections.length;

  // Surface the header "On-device" chip while any section is summarizing (or the
  // encoder/model is still loading for the extractive path).
  const anyLoading =
    loadProgress !== null ||
    Object.values(states).some((s) => s.status === 'loading');
  useReportAnalysisActivity(anyLoading);

  // ── render ─────────────────────────────────────────────────────────────────

  const progressPct = loadProgress !== null ? Math.round(loadProgress.value * 100) : 0;
  const progressLabel =
    loadProgress?.source === 'nano'
      ? 'Downloading Chrome built-in AI (one-time, ~2 GB)…'
      : 'Loading encoder model…';
  const showProgressPct = loadProgress !== null && loadProgress.indeterminate !== true;

  return (
    <section aria-label="Summaries" className="flex flex-col gap-3">
      {/* Extractive tier banner */}
      {extractiveTier && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300 ring-1 ring-inset ring-amber-700/30"
        >
          {detectedTier === 'builtin' && nanoReady === false
            ? "Chrome's built-in AI isn't downloaded yet — showing key sentences instead."
            : 'Generative summaries need Chrome built-in AI — showing key sentences instead.'}
        </div>
      )}

      {/* Model load / download progress (Gemini Nano or the bundled encoder) */}
      {loadProgress !== null && (
        <div
          role="progressbar"
          {...(showProgressPct ? { 'aria-valuenow': progressPct } : {})}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={progressLabel}
          className="flex flex-col gap-1"
        >
          <div className="flex justify-between text-[10px] text-zinc-500">
            <span>{progressLabel}</span>
            {showProgressPct && <span>{progressPct}%</span>}
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            {loadProgress.indeterminate === true ? (
              <m.div
                className="h-full w-1/3 rounded-full bg-sky-500"
                animate={{ x: ['-100%', '300%'] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
              />
            ) : (
              <m.div
                className="h-full rounded-full bg-sky-500"
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.3 }}
              />
            )}
          </div>
        </div>
      )}

      {/* Section cards */}
      <div className="flex flex-col gap-2">
        {sections.map((section) => (
          <SectionCard
            key={section.id}
            section={section}
            state={states[section.id] ?? { status: 'idle' }}
            onSummarize={() => void summarize(section)}
            onJumpTo={(anchor) => void jumpTo(anchor, section)}
          />
        ))}
      </div>

      {/* Summarize All */}
      {!allDone && (
        <button
          onClick={() => void summarizeAll()}
          className="w-full rounded-md bg-zinc-800 py-2 text-xs font-medium text-zinc-300 ring-1 ring-zinc-700 hover:bg-zinc-700 hover:text-zinc-100 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          aria-label="Summarize all sections"
        >
          Summarize All ({sections.length - doneCount} remaining)
        </button>
      )}

      {/* Dev settings — dev builds only; tree-shaken out of production. */}
      {import.meta.env.DEV && (
        <DevSettings
          forceMode={forceMode}
          detectedTier={detectedTier}
          onForceMode={setAndPersistForceMode}
        />
      )}
    </section>
  );
}

// ── DevSettings ───────────────────────────────────────────────────────────────

function DevSettings({
  forceMode,
  detectedTier,
  onForceMode,
}: {
  forceMode: GenerationTier | null;
  detectedTier: GenerationTier;
  onForceMode: (m: GenerationTier | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg bg-zinc-900/50 ring-1 ring-dashed ring-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-[11px] text-zinc-600 hover:text-zinc-400 transition"
        aria-expanded={open}
      >
        <span className="font-medium uppercase tracking-wider">Dev Settings</span>
        <span className="ml-auto">{open ? '▲' : '▼'}</span>
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="border-t border-zinc-800 px-3 pb-3 pt-2.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] text-zinc-500">
                  Force summarization tier (overrides detected: <em>{detectedTier}</em>)
                </span>
                <select
                  value={forceMode ?? ''}
                  onChange={(e) => {
                    const v = e.target.value as GenerationTier | '';
                    onForceMode(v === '' ? null : v);
                  }}
                  className="w-full rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 ring-1 ring-zinc-700 focus:outline-none focus:ring-sky-500"
                >
                  <option value="">Auto (detected)</option>
                  <option value="builtin">Force Built-in AI</option>
                  <option value="extractive">Force Extractive</option>
                </select>
              </label>
              {forceMode !== null && (
                <p className="mt-1.5 text-[10px] text-amber-400">
                  Force mode active — cached results use forced register.
                </p>
              )}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
