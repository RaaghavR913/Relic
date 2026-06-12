// ============================================================
// FilingLens — unified side panel shell (Session 7)
// ------------------------------------------------------------
// Composes Sessions 1–6 into one polished surface:
//   • Header: company · filing type · period + generation-tier badge.
//   • First-run onboarding (privacy + downloads + tier), shown once.
//   • Section navigator + master overlay controls (heatmap / flags + legend).
//   • Tabs: Summary · Sentiment · Flags · Changes — all kept mounted so
//     async analysis (sentiment streaming, redline) survives tab switches.
//   • Loading skeletons, empty states, degradation banners; WCAG AA; reduced-motion.
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCapabilities } from '../runtime/useCapabilities';
import type { GenerationTier } from '../runtime/capabilities';
import type { DocumentModel, LanguageFlag } from '@/types';
import type {
  FilingReadyMsg,
  FlagResultsMsg,
  AnalyzePageMsg,
  AnalyzePageResponse,
} from '@/messages/types';
import { isLowConfidenceGeneric } from '@/content/ingest/detect';
import { setFlags as setFlagOverlayPref } from './overlayPrefs';
import { AnalystPanel } from './AnalystPanel';
import { SummaryPanel } from './SummaryPanel';
import { SentimentPanel } from './SentimentPanel';
import { FlagPanel } from './FlagPanel';
import { RedlinePanel } from './RedlinePanel';
import { FirstRun } from './FirstRun';
import { OverlayControls } from './OverlayControls';
import {
  Spinner,
  SkeletonCard,
  Banner,
  TierBadge,
  PrivacyNote,
  EmptyState,
  BrandLogo,
  stateColor,
  stateLabel,
} from './ui';

const ONBOARDED_KEY = 'filinglens:onboarded';

// ── tabs ──────────────────────────────────────────────────────────────────────

type TabId = 'analyst' | 'summary' | 'sentiment' | 'flags' | 'changes';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'analyst', label: 'Analyst' },
  { id: 'summary', label: 'Summary' },
  { id: 'sentiment', label: 'Sentiment' },
  { id: 'flags', label: 'Flags' },
  { id: 'changes', label: 'Changes' },
];

/** True when the document is a readable SEC data/report page, not a company filing. */
function isDataReport(doc: DocumentModel | null): boolean {
  return doc?.filingType === 'DATA_REPORT';
}

/**
 * Tabs investor-context features require a company/security — Analyst (investment
 * thesis), Sentiment (read as thesis), and Changes (redline vs. a prior filing).
 * They're hidden for SEC data/report pages, which keep Summary + Flags.
 */
const REPORT_DISABLED_TABS: ReadonlySet<TabId> = new Set(['analyst', 'sentiment', 'changes']);

function tabsForDoc(doc: DocumentModel | null): Array<{ id: TabId; label: string }> {
  if (!isDataReport(doc)) return TABS;
  return TABS.filter((t) => !REPORT_DISABLED_TABS.has(t.id));
}

function fmtDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function analyzeFailCopy(response: AnalyzePageResponse | undefined): string {
  if (response && !response.ok) {
    switch (response.reason) {
      case 'unsupported_url':
        return "This page can't be analyzed — browser pages, the Chrome Web Store, and local files (including PDFs) aren't supported.";
      case 'no_permission':
        return 'Chrome needs a fresh grant — click the FilingLens toolbar icon while on the page you want to analyze, then try again.';
      case 'no_tab':
        return "Couldn't find the current tab — switch to the page you want to analyze and try again.";
      default:
        return `Analysis failed: ${response.error ?? 'unknown error'}`;
    }
  }
  return 'Analysis failed: no response from the extension background.';
}

// ── header ────────────────────────────────────────────────────────────────────

function Header({ doc, tier }: { doc: DocumentModel | null; tier: GenerationTier | null }) {
  const period = fmtDate(doc?.periodOfReport);
  // Don't assert a specific form when detection is low-confidence (e.g. a press
  // release that merely names a form) — the type heuristic can misfire off-EDGAR.
  // SEC data/report pages get an honest, non-filing label.
  const typeLabel = isDataReport(doc)
    ? 'SEC Data Report'
    : doc && isLowConfidenceGeneric(doc)
      ? 'Document'
      : doc?.filingType;
  return (
    <header className="border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <BrandLogo className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-tight">FilingLens</span>
        {tier && <span className="ml-1"><TierBadge tier={tier} /></span>}
        <span className="ml-auto text-[10px] text-zinc-600">v{chrome.runtime.getManifest().version}</span>
      </div>
      {doc && (
        <div className="mt-2">
          <p className="truncate text-xs font-medium text-zinc-200">
            {doc.companyName ?? 'Unknown company'}
            {doc.ticker ? <span className="ml-1.5 text-zinc-500">{doc.ticker}</span> : null}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-500">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-300">{typeLabel}</span>
            {period && <span>· Period {period}</span>}
            <span>· {doc.sections.length} sections</span>
          </p>
        </div>
      )}
    </header>
  );
}

// ── tab bar ───────────────────────────────────────────────────────────────────

function TabBar({
  active,
  onSelect,
  flagCount,
  tabs = TABS,
}: {
  active: TabId;
  onSelect: (id: TabId) => void;
  flagCount: number;
  tabs?: Array<{ id: TabId; label: string }>;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = tabs.findIndex((t) => t.id === active);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onSelect(tabs[(idx + 1) % tabs.length]!.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onSelect(tabs[(idx - 1 + tabs.length) % tabs.length]!.id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Analysis views"
      onKeyDown={onKeyDown}
      className="flex gap-0.5 rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800"
    >
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${t.id}`}
            id={`tab-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            className={`relative flex-1 rounded-md px-1 py-1.5 text-[11px] font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${
              selected ? 'bg-zinc-700 text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.label}
            {t.id === 'flags' && flagCount > 0 && (
              <span className="ml-1 rounded-full bg-amber-500/20 px-1 text-[9px] font-semibold text-amber-300 tabular-nums">
                {flagCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── no-filing state (capabilities + privacy) ──────────────────────────────────

function NoFiling({
  caps,
  analyzing,
  analyzeError,
  onAnalyze,
}: {
  caps: ReturnType<typeof useCapabilities>['caps'];
  analyzing: boolean;
  analyzeError: string | null;
  onAnalyze: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <EmptyState
        title="No filing open"
        body={
          <>
            Open a 10-K, 10-Q, 8-K, 20-F, S-1, or proxy on EDGAR — or use{' '}
            <span className="font-medium text-zinc-400">Analyze this page</span> on a company IR
            page or other financial document. PDF reports aren&rsquo;t supported yet.
          </>
        }
      />
      <button
        onClick={onAnalyze}
        disabled={analyzing}
        className="flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        {analyzing ? (
          <>
            <Spinner />
            Analyzing page…
          </>
        ) : (
          'Analyze this page'
        )}
      </button>
      {analyzeError && (
        <Banner tone="warn" icon="⚠">
          {analyzeError}
        </Banner>
      )}
      {caps && (
        <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800">
          <p className="mb-3 text-[10px] font-medium uppercase tracking-widest text-zinc-500">On-device capabilities</p>
          <ul className="flex flex-col gap-2 text-xs" role="list">
            <li className="flex items-center justify-between">
              <span className="text-zinc-300">Summarizer API</span>
              <span className={stateColor(caps.summarizer)}>{stateLabel(caps.summarizer)}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-zinc-300">Prompt API (Gemini Nano)</span>
              <span className={stateColor(caps.promptApi)}>{stateLabel(caps.promptApi)}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-zinc-300">WebGPU acceleration</span>
              <span className={caps.webgpu.adapter ? 'text-emerald-400' : 'text-zinc-500'}>
                {caps.webgpu.adapter ? 'Available' : 'WASM fallback'}
              </span>
            </li>
          </ul>
        </section>
      )}
      <PrivacyNote />
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function App() {
  const { caps, error, refresh } = useCapabilities();
  const [currentDoc, setCurrentDoc] = useState<DocumentModel | null>(null);
  const [currentFlags, setCurrentFlags] = useState<LanguageFlag[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('analyst');

  // For SEC data/report pages the investor-only tabs are hidden; if the active
  // tab is one of them (e.g. carried over from a prior filing), fall back to a
  // tab that's actually visible so the panel never renders behind a missing tab.
  const visibleTabs = tabsForDoc(currentDoc);
  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? 'summary');
    }
  }, [visibleTabs, activeTab]);

  // Onboarding gate.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    chrome.storage.local
      .get(ONBOARDED_KEY)
      .then((data) => setOnboarded(Boolean(data[ONBOARDED_KEY])))
      .catch(() => setOnboarded(false));
  }, []);

  const finishOnboarding = useCallback(() => {
    setOnboarded(true);
    chrome.storage.local.set({ [ONBOARDED_KEY]: true }).catch(() => {});
  }, []);

  // On-demand "Analyze this page" (non-EDGAR pages). FILING_READY resolves the
  // pending state; a timeout catches pages where ingestion found nothing.
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const analyzeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror currentDoc into a ref so the analyze-timeout closure can read the
  // latest value without being re-created on every document change.
  const currentDocRef = useRef<DocumentModel | null>(null);
  currentDocRef.current = currentDoc;

  const clearAnalyzeTimer = useCallback(() => {
    if (analyzeTimer.current !== null) {
      clearTimeout(analyzeTimer.current);
      analyzeTimer.current = null;
    }
  }, []);

  const startAnalyze = useCallback(async () => {
    setAnalyzeError(null);
    setAnalyzing(true);
    clearAnalyzeTimer();
    let response: AnalyzePageResponse | undefined;
    try {
      const msg: AnalyzePageMsg = { target: 'sw', type: 'ANALYZE_PAGE' };
      response = (await chrome.runtime.sendMessage(msg)) as AnalyzePageResponse | undefined;
    } catch (err) {
      setAnalyzing(false);
      setAnalyzeError(`Couldn't reach the extension background: ${String(err)}`);
      return;
    }
    if (!response?.ok) {
      setAnalyzing(false);
      setAnalyzeError(analyzeFailCopy(response));
      return;
    }
    // Injected — wait for FILING_READY (handled by the message listener). The
    // content script waits for client-rendered (SPA) pages to render before
    // ingesting (up to ~8s), so allow headroom beyond that before giving up.
    analyzeTimer.current = setTimeout(() => {
      setAnalyzing(false);
      // If a document is already loaded for this page (e.g. the auto-injected
      // content script on sec.gov analyzed it on load, and re-injection had nothing
      // new to re-emit), the analysis already succeeded — don't surface a
      // misleading "taking a while" warning. Only warn when nothing was produced.
      if (!currentDocRef.current) {
        setAnalyzeError(
          "This page is taking a while to load or has little readable text. Once it finishes loading, click “Analyze this page” again.",
        );
      }
    }, 15_000);
  }, [clearAnalyzeTimer]);

  // Subscribe to FILING_READY + FLAG_RESULTS; recover from session storage on open.
  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel') return;
      if (msg.type === 'FILING_READY') {
        const m = msg as FilingReadyMsg;
        setCurrentDoc(m.model);
        setCurrentFlags([]);
        // Resolve a pending "Analyze this page" request.
        clearAnalyzeTimer();
        setAnalyzing(false);
        setAnalyzeError(null);
      }
      if (msg.type === 'FLAG_RESULTS') {
        setCurrentFlags((msg as FlagResultsMsg).flags);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.storage.session
      .get('filing:current')
      .then(async (data: Record<string, unknown>) => {
        const current = data['filing:current'] as { hash: string } | undefined;
        if (!current?.hash) return;
        const hash = current.hash;
        const [modelData, flagData] = await Promise.all([
          chrome.storage.session.get(`filing:model:${hash}`),
          chrome.storage.session.get(`filing:flags:${hash}`),
        ]);
        const model = modelData[`filing:model:${hash}`] as DocumentModel | undefined;
        const flags = flagData[`filing:flags:${hash}`] as LanguageFlag[] | undefined;
        if (model) setCurrentDoc(model);
        if (flags) setCurrentFlags(flags);
      })
      .catch(console.warn);

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [clearAnalyzeTimer]);

  const tier = caps?.generationTier ?? null;

  return (
    <div className="flex h-full min-h-screen flex-col bg-zinc-950 text-zinc-100 selection:bg-sky-500/30">
      <Header doc={currentDoc} tier={tier} />

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {/* Capability detection states */}
        {!caps && !error && (
          <div className="flex flex-col items-center gap-3 pt-10 text-zinc-500" role="status" aria-label="Detecting device capabilities">
            <Spinner />
            <p className="text-xs">Detecting on-device capabilities…</p>
          </div>
        )}

        {error && (
          <Banner tone="warn" icon="⚠">
            <span className="font-semibold">Capability detection failed:</span> {error.message}
          </Banner>
        )}

        {/* First-run onboarding */}
        {caps && onboarded === false && <FirstRun caps={caps} onDone={finishOnboarding} />}

        {/* Main app */}
        {caps && onboarded === true && (
          <AnimatePresence mode="wait">
            {currentDoc ? (
              <motion.div
                key="filing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col gap-3"
              >
                {/* The panel can outlive the analyzed page (session-storage recovery),
                    so the on-demand entry point must stay reachable here too. */}
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[10px] text-zinc-600">
                    On a different page now? Analysis below is for the last document.
                  </p>
                  <button
                    onClick={() => void startAnalyze()}
                    disabled={analyzing}
                    className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium text-sky-400 transition hover:bg-zinc-800 hover:text-sky-300 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                  >
                    {analyzing ? 'Analyzing…' : 'Analyze this page'}
                  </button>
                </div>
                {analyzeError && (
                  <Banner tone="warn" icon="⚠">
                    {analyzeError}
                  </Banner>
                )}
                {isDataReport(currentDoc) && (
                  <Banner tone="info" icon="ℹ">
                    <span className="font-semibold">SEC data/report page</span> — this is a
                    regulatory document, not a company filing. Investor analysis, sentiment, and
                    redline are unavailable; Summary and language flags still apply.
                  </Banner>
                )}
                {isLowConfidenceGeneric(currentDoc) && (
                  <Banner tone="warn" icon="⚠">
                    <span className="font-semibold">This page doesn&rsquo;t look like an SEC filing</span>{' '}
                    — analysis may be unreliable. On-page flag highlights are off;{' '}
                    <button
                      onClick={() => setFlagOverlayPref(true)}
                      className="font-medium text-amber-200 underline decoration-amber-400/50 underline-offset-2 transition hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                    >
                      show them anyway
                    </button>
                    .
                  </Banner>
                )}
                <OverlayControls />
                <TabBar active={activeTab} onSelect={setActiveTab} flagCount={currentFlags.length} tabs={visibleTabs} />

                {/* Tab panels — kept mounted to preserve async state across switches.
                    Investor-context panels (analyst/sentiment/changes) are not even
                    mounted for SEC data/report pages, so they never auto-run
                    investment-thesis analysis or hit EDGAR for a prior filing. */}
                {!isDataReport(currentDoc) && (
                  <div
                    id="panel-analyst"
                    role="tabpanel"
                    aria-labelledby="tab-analyst"
                    hidden={activeTab !== 'analyst'}
                  >
                    <AnalystPanel doc={currentDoc} detectedTier={caps.generationTier} flags={currentFlags} />
                  </div>
                )}
                <div
                  id="panel-summary"
                  role="tabpanel"
                  aria-labelledby="tab-summary"
                  hidden={activeTab !== 'summary'}
                >
                  <SummaryPanel doc={currentDoc} detectedTier={caps.generationTier} />
                </div>
                {!isDataReport(currentDoc) && (
                  <div
                    id="panel-sentiment"
                    role="tabpanel"
                    aria-labelledby="tab-sentiment"
                    hidden={activeTab !== 'sentiment'}
                  >
                    <SentimentPanel doc={currentDoc} />
                  </div>
                )}
                <div id="panel-flags" role="tabpanel" aria-labelledby="tab-flags" hidden={activeTab !== 'flags'}>
                  {currentFlags.length > 0 ? (
                    <FlagPanel doc={currentDoc} flags={currentFlags} />
                  ) : (
                    <EmptyState title="No language flags" body="No hedging, litigious, or uncertainty language was detected in this filing." />
                  )}
                </div>
                {!isDataReport(currentDoc) && (
                  <div id="panel-changes" role="tabpanel" aria-labelledby="tab-changes" hidden={activeTab !== 'changes'}>
                    <RedlinePanel doc={currentDoc} detectedTier={caps.generationTier} />
                  </div>
                )}

                <PrivacyNote className="mt-1" />

                <div className="flex items-center justify-between pt-1 text-[10px] text-zinc-600">
                  <span>Detected {new Date(caps.detectedAt).toLocaleTimeString()}</span>
                  <button
                    onClick={() => void refresh()}
                    className="rounded px-2 py-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                  >
                    Re-detect
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <NoFiling
                  caps={caps}
                  analyzing={analyzing}
                  analyzeError={analyzeError}
                  onAnalyze={() => void startAnalyze()}
                />
              </motion.div>
            )}
          </AnimatePresence>
        )}

        {/* Onboarding still loading */}
        {caps && onboarded === null && <SkeletonCard lines={4} />}
      </main>
    </div>
  );
}
