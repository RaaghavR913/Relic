// ============================================================
// FilingLens — unified side panel shell (Session 7)
// ------------------------------------------------------------
// Composes Sessions 1–6 into one polished surface:
//   • Header: company · filing type · period + generation-tier badge.
//   • First-run onboarding (privacy + downloads + tier), shown once.
//   • Section navigator + master overlay controls (heatmap / flags + legend).
//   • Tabs: Summary · Sentiment · Flags · Changes · Ask — all kept mounted so
//     async analysis (sentiment streaming, redline, Q&A) survives tab switches.
//   • Loading skeletons, empty states, degradation banners; WCAG AA; reduced-motion.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useCapabilities } from '../runtime/useCapabilities';
import type { GenerationTier } from '../runtime/capabilities';
import type { DocumentModel, LanguageFlag } from '@/types';
import type { FilingReadyMsg, FlagResultsMsg } from '@/messages/types';
import { SummaryPanel } from './SummaryPanel';
import { SentimentPanel } from './SentimentPanel';
import { FlagPanel } from './FlagPanel';
import { RedlinePanel } from './RedlinePanel';
import { AskPanel } from './AskPanel';
import { FirstRun } from './FirstRun';
import { OverlayControls } from './OverlayControls';
import { SectionNavigator } from './SectionNavigator';
import {
  Spinner,
  SkeletonCard,
  Banner,
  TierBadge,
  PrivacyNote,
  EmptyState,
  LockIcon,
  stateColor,
  stateLabel,
} from './ui';

const ONBOARDED_KEY = 'filinglens:onboarded';

// ── tabs ──────────────────────────────────────────────────────────────────────

type TabId = 'summary' | 'sentiment' | 'flags' | 'changes' | 'ask';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'sentiment', label: 'Sentiment' },
  { id: 'flags', label: 'Flags' },
  { id: 'changes', label: 'Changes' },
  { id: 'ask', label: 'Ask' },
];

function fmtDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── header ────────────────────────────────────────────────────────────────────

function Header({ doc, tier }: { doc: DocumentModel | null; tier: GenerationTier | null }) {
  const period = fmtDate(doc?.periodOfReport);
  return (
    <header className="border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 ring-1 ring-sky-500/30">
          <LockIcon className="h-3.5 w-3.5 text-sky-400" />
        </span>
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
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-300">{doc.filingType}</span>
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
}: {
  active: TabId;
  onSelect: (id: TabId) => void;
  flagCount: number;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = TABS.findIndex((t) => t.id === active);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onSelect(TABS[(idx + 1) % TABS.length]!.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onSelect(TABS[(idx - 1 + TABS.length) % TABS.length]!.id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Analysis views"
      onKeyDown={onKeyDown}
      className="flex gap-0.5 rounded-lg bg-zinc-900 p-0.5 ring-1 ring-zinc-800"
    >
      {TABS.map((t) => {
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

function NoFiling({ caps }: { caps: ReturnType<typeof useCapabilities>['caps'] }) {
  return (
    <div className="flex flex-col gap-4">
      <EmptyState
        title="No filing open"
        body={
          <>Open a 10-K, 10-Q, 8-K, 20-F, S-1, or proxy on EDGAR, then reopen this panel to analyze it.</>
        }
      />
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
  const [activeTab, setActiveTab] = useState<TabId>('summary');

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

  // Subscribe to FILING_READY + FLAG_RESULTS; recover from session storage on open.
  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel') return;
      if (msg.type === 'FILING_READY') {
        const m = msg as FilingReadyMsg;
        setCurrentDoc(m.model);
        setCurrentFlags([]);
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
  }, []);

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
                <SectionNavigator doc={currentDoc} />
                <OverlayControls />
                <TabBar active={activeTab} onSelect={setActiveTab} flagCount={currentFlags.length} />

                {/* Tab panels — kept mounted to preserve async state across switches. */}
                <div
                  id="panel-summary"
                  role="tabpanel"
                  aria-labelledby="tab-summary"
                  hidden={activeTab !== 'summary'}
                >
                  <SummaryPanel doc={currentDoc} detectedTier={caps.generationTier} />
                </div>
                <div
                  id="panel-sentiment"
                  role="tabpanel"
                  aria-labelledby="tab-sentiment"
                  hidden={activeTab !== 'sentiment'}
                >
                  <SentimentPanel doc={currentDoc} />
                </div>
                <div id="panel-flags" role="tabpanel" aria-labelledby="tab-flags" hidden={activeTab !== 'flags'}>
                  {currentFlags.length > 0 ? (
                    <FlagPanel doc={currentDoc} flags={currentFlags} />
                  ) : (
                    <EmptyState title="No language flags" body="No hedging, litigious, or uncertainty language was detected in this filing." />
                  )}
                </div>
                <div id="panel-changes" role="tabpanel" aria-labelledby="tab-changes" hidden={activeTab !== 'changes'}>
                  <RedlinePanel doc={currentDoc} detectedTier={caps.generationTier} />
                </div>
                <div id="panel-ask" role="tabpanel" aria-labelledby="tab-ask" hidden={activeTab !== 'ask'}>
                  <AskPanel doc={currentDoc} tier={caps.generationTier} />
                </div>

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
                <NoFiling caps={caps} />
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
