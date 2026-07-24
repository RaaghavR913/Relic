// ============================================================
// Relic — unified side panel shell (Session 7)
// ------------------------------------------------------------
// Composes Sessions 1–6 into one polished surface:
//   • Header: company · filing type · period + generation-tier badge.
//   • First-run onboarding (privacy + downloads + tier), shown once.
//   • Section navigator + tab panels (Analyst · Summary · Sentiment · Changes).
//   • Tabs: Analyst · Summary · Sentiment · Changes — all kept mounted so
//     async analysis (sentiment streaming, redline) survives tab switches.
//   • Loading skeletons, empty states, degradation banners; WCAG AA; reduced-motion.
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useCapabilities } from '../runtime/useCapabilities';
import type { DocumentModel, LanguageFlag } from '@/types';
import type {
  FilingReadyMsg,
  FilingGatedMsg,
  FlagResultsMsg,
  AnalyzePageMsg,
  AnalyzePageResponse,
  PdfUnextractableMsg,
} from '@/messages/types';
import { isLowConfidenceGeneric, isGeneralFinancialDoc, isEdgarExhibit } from '@/content/ingest/detect';
import { classifyInjectability } from '@/background/inject';
import { loadFilingFromSession, normalizePageUrl } from '@/shared/filingSession';
import { setFlags as setFlagOverlayPref } from './overlayPrefs';
import { AnalystPanel } from './AnalystPanel';
import { ExportButton } from './ExportButton';
import { SummaryPanel } from './SummaryPanel';
import { SentimentPanel } from './SentimentPanel';
import { RedlinePanel } from './RedlinePanel';
import { FirstRun } from './FirstRun';
import { Switch } from './OverlayControls';
import { WORKS_TIERS } from '@/shared/worksTiers';
import {
  Spinner,
  SkeletonCard,
  Banner,
  EmptyState,
  BrandLogo,
  SettingsButton,
  LockIcon,
  stateColor,
  stateLabel,
} from './ui';
import { useAnalysisActive } from './analysisActivity';
import { fmtCalendarDate } from '@/lib/date';

const ONBOARDED_KEY = 'relic:onboarded';

// Set true the first time a filing loads successfully. Used to collapse the
// "Where Relic works" guide once the user has seen analysis actually happen.
const HAS_ANALYZED_KEY = 'relic:hasAnalyzed';

// ── tabs ──────────────────────────────────────────────────────────────────────

type TabId = 'analyst' | 'summary' | 'sentiment' | 'changes';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'analyst', label: 'Analyst' },
  { id: 'summary', label: 'Summary' },
  { id: 'sentiment', label: 'Sentiment' },
  { id: 'changes', label: 'Redline' },
];

/** True when the document is a readable SEC data/report page, not a company filing. */
function isDataReport(doc: DocumentModel | null): boolean {
  return doc?.filingType === 'DATA_REPORT';
}

/** True for a filing ingested from a PDF (text-only; no live DOM / EDGAR source). */
function isPdfDoc(doc: DocumentModel | null): boolean {
  return doc?.source.category === 'pdf';
}

/** True for an EDGAR Filing Detail / accession index page (a directory, not the document). */
function isFilingIndex(doc: DocumentModel | null): boolean {
  return doc?.source.category === 'edgar_index';
}

/**
 * Tabs investor-context features require a company/security — Analyst (investment
 * thesis), Sentiment (read as thesis), and Redline (vs. a prior filing).
 * They're hidden for SEC data/report pages, EDGAR index pages, and low-confidence
 * generic pages (a stock-quote page, a press release — anything that isn't a
 * filing), all of which keep Summary only.
 */
const REPORT_DISABLED_TABS: ReadonlySet<TabId> = new Set(['analyst', 'sentiment', 'changes']);

/**
 * Pages that have no investor thesis to analyze: hide the investor-context tabs
 * AND skip mounting their panels (see render below), so a non-filing page never
 * auto-runs the Analyst pipeline — no meaningless deterministic report, and no
 * way for it to pin the panel on the loading card.
 */
function hidesInvestorTabs(doc: DocumentModel | null): boolean {
  return (
    isDataReport(doc) ||
    isFilingIndex(doc) ||
    isEdgarExhibit(doc) ||
    // General financial pages (IR releases, transcripts, news, non-form PDFs)
    // are the middle tier: low-confidence as a FILING, but still analyzable
    // financial text — they keep Analyst + Sentiment (deterministic-first).
    (doc !== null && isLowConfidenceGeneric(doc) && !isGeneralFinancialDoc(doc))
  );
}

function tabsForDoc(doc: DocumentModel | null): Array<{ id: TabId; label: string }> {
  if (hidesInvestorTabs(doc)) return TABS.filter((t) => !REPORT_DISABLED_TABS.has(t.id));
  // General financial pages: everything except the Redline (needs an EDGAR
  // prior filing resolved by CIK, which a non-filing page can't have).
  if (doc !== null && isGeneralFinancialDoc(doc)) return TABS.filter((t) => t.id !== 'changes');
  // A confidently-detected PDF filing keeps Analyst / Summary / Sentiment (all
  // text-based), but the year-over-year Redline needs a live DOM + an EDGAR prior
  // filing (resolved by CIK) — neither is available from a PDF, so hide it.
  if (isPdfDoc(doc)) return TABS.filter((t) => t.id !== 'changes');
  return TABS;
}

function fmtDate(iso?: string): string | null {
  return fmtCalendarDate(iso, 'short') || null;
}

function analyzeFailCopy(response: AnalyzePageResponse | undefined): string {
  if (response && !response.ok) {
    switch (response.reason) {
      case 'unsupported_url':
        return "This page can't be analyzed — browser pages and the Chrome Web Store aren't supported.";
      case 'needs_file_access':
        // Browser-neutral: the extensions page is chrome://extensions in Chrome but
        // brave://extensions in Brave, so name the page rather than a fixed URL.
        return 'This is a local file. To analyze PDFs opened from your computer, open your browser\'s extensions page, find Relic → Details, and turn on "Allow access to file URLs" — then reload the PDF and try again.';
      case 'no_permission':
        return 'The browser needs a fresh grant — click the Relic toolbar icon while on the page you want to analyze, then try again.';
      case 'no_tab':
        return "Couldn't find the current tab — switch to the page you want to analyze and try again.";
      case 'needs_optional_permission':
        // Handled by the needsPermission banner; should not reach this path.
        return 'This site requires a one-time permission grant — use the button below.';
      default:
        return `Analysis failed: ${response.error ?? 'unknown error'}`;
    }
  }
  return 'Analysis failed: no response from the extension background.';
}

// ── filing support info guide ─────────────────────────────────────────────────

const INFO_OPEN_KEY = 'relic:infoOpen';

/**
 * Static cheat sheet for where Relic works best. Shown on every page;
 * the Info toggle persists across sessions via chrome.storage.local.
 */
/** Three-tier support guide — always available; visibility controlled by the Info toggle. */
function WhereItWorks() {
  const [infoOpen, setInfoOpen] = useState(true);

  useEffect(() => {
    chrome.storage.local
      .get([INFO_OPEN_KEY, HAS_ANALYZED_KEY])
      .then((data: Record<string, unknown>) => {
        const stored = data[INFO_OPEN_KEY];
        if (typeof stored === 'boolean') {
          setInfoOpen(stored);
        } else {
          // No explicit choice yet: keep the guide open until the first filing has
          // analyzed successfully, then default it collapsed to its single header
          // line so the analysis stays above the fold. The user can still expand it,
          // and that choice then persists via INFO_OPEN_KEY.
          setInfoOpen(!data[HAS_ANALYZED_KEY]);
        }
      })
      .catch(() => {});
  }, []);

  const onInfoToggle = useCallback((open: boolean) => {
    setInfoOpen(open);
    chrome.storage.local.set({ [INFO_OPEN_KEY]: open }).catch(() => {});
  }, []);

  return (
    <section
      aria-label="Where Relic works best"
      className="rounded-lg bg-zinc-900/60 px-3 py-2.5 ring-1 ring-inset ring-zinc-800 text-[12px]"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-zinc-200">Info</span>
        <Switch checked={infoOpen} onChange={onInfoToggle} label="Info" on="bg-sky-600" />
      </div>
      {infoOpen && (
        <ul className="mt-2 flex flex-col gap-2">
          {WORKS_TIERS.map((t) => (
            <li
              key={`${t.prefix}${t.link?.text ?? t.label ?? ''}`}
              className="leading-relaxed text-zinc-400"
            >
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-zinc-200">
                  {t.prefix}
                  {t.parts
                    ? t.parts.map((part, i) =>
                        part.type === 'link' ? (
                          <a
                            key={`${part.text}-${i}`}
                            href={part.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 underline hover:text-sky-300"
                          >
                            {part.text}
                          </a>
                        ) : (
                          <span key={`text-${i}`}>{part.value}</span>
                        ),
                      )
                    : t.link ? (
                        <a
                          href={t.link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-400 underline hover:text-sky-300"
                        >
                          {t.link.text}
                        </a>
                      ) : (
                        t.label
                      )}
                  {t.suffix}
                </span>
                {t.detail ? (
                  <span>
                    {typeof t.detail === 'string'
                      ? t.detail
                      : t.detail.map((part, i) =>
                          part.type === 'link' ? (
                            <a
                              key={`${part.text}-${i}`}
                              href={part.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-400 underline hover:text-sky-300"
                            >
                              {part.text}
                            </a>
                          ) : (
                            <span key={`text-${i}`}>{part.value}</span>
                          ),
                        )}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── header ────────────────────────────────────────────────────────────────────

function Header({ doc, hideDocMeta = false, analysisActive = false }: { doc: DocumentModel | null; hideDocMeta?: boolean; analysisActive?: boolean }) {
  const period = fmtDate(doc?.periodOfReport);
  // Don't assert a specific form when detection is low-confidence (e.g. a press
  // release that merely names a form) — the type heuristic can misfire off-EDGAR.
  // SEC data/report pages get an honest, non-filing label.
  const typeLabel = isDataReport(doc)
    ? 'SEC Data Report'
    : isEdgarExhibit(doc)
      ? 'Exhibit'
      : doc && isLowConfidenceGeneric(doc)
        ? 'Document'
        : doc?.filingType;
  const reducedMotion = useReducedMotion() ?? false;
  return (
    <header className="border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <BrandLogo className="h-6 w-6" />
        <span className="font-display text-[19px] font-semibold tracking-tight">Relic</span>
        {/* On-device promise — shown while any analysis runs (the moment a cloud
            tool would be uploading). Fade only; respects reduced-motion. */}
        <AnimatePresence>
          {analysisActive && (
            <m.span
              key="ondevice-chip"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reducedMotion ? { duration: 0 } : { duration: 0.2 }}
              role="status"
              title="This analysis never leaves your machine."
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300/90 ring-1 ring-inset ring-emerald-500/20 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]"
            >
              <LockIcon className="h-3 w-3" />
              On-device
            </m.span>
          )}
        </AnimatePresence>
        <div className="ml-auto flex items-center gap-1.5">
          <SettingsButton />
          <span
            className="text-xs"
            style={{ color: '#bbff33' }}
          >
            v{chrome.runtime.getManifest().version}
          </span>
        </div>
      </div>
      {doc && !hideDocMeta && (
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium text-zinc-200">
              {doc.companyName ?? 'Unknown company'}
              {doc.ticker ? <span className="ml-1.5 text-zinc-500">{doc.ticker}</span> : null}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-500">
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium text-zinc-300">{typeLabel}</span>
              {period && <span>· Period {period}</span>}
              <span>· {doc.sections.length} sections</span>
            </p>
          </div>
          <ExportButton doc={doc} />
        </div>
      )}
    </header>
  );
}

// ── tab bar ───────────────────────────────────────────────────────────────────

function TabBar({
  active,
  onSelect,
  tabs = TABS,
}: {
  active: TabId;
  onSelect: (id: TabId) => void;
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
  needsPermission,
  onGrantPermission,
  onDismissPermission,
  gateState,
}: {
  caps: ReturnType<typeof useCapabilities>['caps'];
  analyzing: boolean;
  analyzeError: string | null;
  onAnalyze: () => void;
  needsPermission: { hosts: string[]; label: string } | null;
  onGrantPermission: () => void;
  onDismissPermission: () => void;
  gateState: 'consent_wall' | 'paywall' | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <EmptyState
        title="No filing open"
        body="Open an SEC filing to get started, or analyze the page you’re on."
      />
      <button
        onClick={onAnalyze}
        disabled={analyzing}
        className="flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-[15px] font-semibold text-white transition hover:bg-sky-500 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
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
      {needsPermission && (
        <Banner tone="info" icon="ℹ">
          <span className="font-semibold">{needsPermission.label}</span> needs a one-time
          permission grant before Relic can analyze it.{' '}
          <button
            onClick={onGrantPermission}
            className="font-medium text-sky-300 underline decoration-sky-400/50 underline-offset-2 transition hover:text-sky-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            Allow access
          </button>
          {' · '}
          <button
            onClick={onDismissPermission}
            className="text-zinc-400 underline underline-offset-2 transition hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            Skip
          </button>
        </Banner>
      )}
      {gateState === 'consent_wall' && (
        <Banner tone="warn" icon="⚠">
          This page is showing a <span className="font-semibold">consent banner</span> that
          covers the content. Accept or close it in the browser, then click{' '}
          <span className="font-medium">Analyze this page</span> again.
        </Banner>
      )}
      {gateState === 'paywall' && (
        <Banner tone="warn" icon="⚠">
          This page appears to have a{' '}
          <span className="font-semibold">paywall or registration gate</span>. Relic can
          only analyze content that&rsquo;s visible to you — dismiss the gate and retry.
        </Banner>
      )}
      {caps && (
        <section className="rounded-xl bg-zinc-900 p-4 ring-1 ring-zinc-800 text-[15px]">
          <p className="mb-3 text-center text-base font-medium uppercase tracking-widest text-zinc-500 font-display">On-device capabilities</p>
          <ul className="flex flex-col gap-2" role="list">
            <li className="flex items-center justify-between">
              <span className="text-zinc-300">Summarizer API</span>
              <span className={stateColor(caps.summarizer)}>{stateLabel(caps.summarizer)}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-zinc-300">Prompt API (Gemini Nano)</span>
              <span className={stateColor(caps.promptApi)}>{stateLabel(caps.promptApi)}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-zinc-300">WebGPU adapter</span>
              <span className={caps.webgpu.adapter ? 'text-emerald-400' : 'text-zinc-500'}>
                {caps.webgpu.adapter ? 'Available' : 'Unavailable'}
              </span>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function App() {
  const { caps, error } = useCapabilities();
  const analysisActive = useAnalysisActive();
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

  // Group C: optional permission flow.
  const [needsPermission, setNeedsPermission] = useState<{
    hosts: string[];
    label: string;
  } | null>(null);

  // Group C: gate state reported by the content script (consent wall / paywall).
  const [gateState, setGateState] = useState<'consent_wall' | 'paywall' | null>(null);
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
    setNeedsPermission(null);
    setGateState(null);
    setAnalyzing(true);
    clearAnalyzeTimer();
    // Arm the recovery timer BEFORE awaiting the background. If the message ever
    // hangs (e.g. the service worker was replaced on an extension reload, or no
    // FILING_READY arrives), this guarantees the button leaves the "Analyzing…"
    // state instead of staying permanently disabled / dead. The success path and
    // the error paths below clear it explicitly.
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

    let response: AnalyzePageResponse | undefined;
    try {
      const msg: AnalyzePageMsg = { target: 'sw', type: 'ANALYZE_PAGE' };
      response = (await chrome.runtime.sendMessage(msg)) as AnalyzePageResponse | undefined;
    } catch (err) {
      clearAnalyzeTimer();
      setAnalyzing(false);
      setAnalyzeError(`Couldn't reach the extension background: ${String(err)}`);
      return;
    }
    if (!response?.ok) {
      clearAnalyzeTimer();
      setAnalyzing(false);
      // Group C: show the permission grant banner instead of a generic error.
      if (response?.reason === 'needs_optional_permission') {
        setNeedsPermission({
          hosts: response.hosts ?? [],
          label: response.label ?? 'this site',
        });
        return;
      }
      setAnalyzeError(analyzeFailCopy(response));
      return;
    }
    // Injected — the already-armed timer is cleared by the FILING_READY listener
    // once the content script reports back (or fires as the recovery fallback).
  }, [clearAnalyzeTimer]);

  // Group C: user clicked "Allow access" — request the optional permission in the
  // user-gesture context of the button click, then retry analysis.
  const handleGrantPermission = useCallback(() => {
    if (!needsPermission) return;
    const { hosts } = needsPermission;
    chrome.permissions.request({ origins: hosts })
      .then((granted) => {
        setNeedsPermission(null);
        if (granted) {
          void startAnalyze();
        } else {
          setAnalyzeError("Permission denied — Relic can't analyze this site.");
        }
      })
      .catch((err: unknown) => {
        setNeedsPermission(null);
        setAnalyzeError(`Permission request failed: ${String(err)}`);
      });
  }, [needsPermission, startAnalyze]);

  // Subscribe to FILING_READY + FLAG_RESULTS + FILING_GATED;
  // recover from session storage on open.
  useEffect(() => {
    const listener = (rawMsg: unknown) => {
      const msg = rawMsg as { target?: string; type?: string };
      if (msg.target !== 'sidepanel') return;
      if (msg.type === 'FILING_READY') {
        const m = msg as FilingReadyMsg;
        setCurrentDoc(m.model);
        setCurrentFlags([]);
        // First successful filing load: collapse the "Where Relic works" guide next open.
        chrome.storage.local.set({ [HAS_ANALYZED_KEY]: true }).catch(() => {});
        // Resolve a pending "Analyze this page" request.
        clearAnalyzeTimer();
        setAnalyzing(false);
        setAnalyzeError(null);
        setNeedsPermission(null);
        setGateState(null);
      }
      if (msg.type === 'FLAG_RESULTS') {
        setCurrentFlags((msg as FlagResultsMsg).flags);
      }
      // Group C: content script bailed because the page is behind a gate.
      if (msg.type === 'FILING_GATED') {
        const m = msg as FilingGatedMsg;
        setGateState(m.reason);
        clearAnalyzeTimer();
        setAnalyzing(false);
      }
      // A PDF was detected but no analyzable text could be extracted.
      if (msg.type === 'PDF_UNEXTRACTABLE') {
        const m = msg as PdfUnextractableMsg;
        clearAnalyzeTimer();
        setAnalyzing(false);
        setAnalyzeError(
          m.detail && /too large|HTTP|download/i.test(m.detail)
            ? `Couldn’t analyze this PDF — ${m.detail}.`
            : 'Couldn’t read any text from this PDF. It looks like a scanned or image-only document, which Relic can’t analyze yet (no text layer to extract).',
        );
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    void loadFilingFromSession()
      .then(async ({ model, flags }) => {
        if (model) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const activeUrl = tabs[0]?.url;
          if (
            !activeUrl ||
            normalizePageUrl(model.source.url) === normalizePageUrl(activeUrl)
          ) {
            setCurrentDoc(model);
            if (flags) setCurrentFlags(flags);
            chrome.storage.local.set({ [HAS_ANALYZED_KEY]: true }).catch(() => {});
            return;
          }
        }

        const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (tab?.id !== undefined && classifyInjectability(tab.url) === 'auto_host') {
          chrome.tabs
            .sendMessage(tab.id, { target: 'content', type: 'RESYNC_FILING' })
            .catch(() => {});
        }
      })
      .catch(console.warn);

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [clearAnalyzeTimer]);

  return (
    <div className="flex h-full min-h-screen flex-col bg-zinc-950 font-sans text-zinc-100 selection:bg-sky-500/30">
      <Header doc={currentDoc} hideDocMeta={onboarded === false} analysisActive={analysisActive || analyzing} />

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
          <div className="flex flex-col gap-3">
            <WhereItWorks />
            <AnimatePresence mode="wait">
            {currentDoc ? (
              <m.div
                key="filing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col gap-3"
              >
                {/* The panel can outlive the analyzed page (session-storage recovery),
                    so the on-demand entry point must stay reachable here too. */}
                {isPdfDoc(currentDoc) && (
                  <Banner tone="info" icon="ℹ" className="px-4 py-3 text-[11px]">
                    <span className="font-semibold">Analyzing a PDF.</span>
                    {' Investor analysis, summary, language flags, and sentiment are available. On-page highlights and the year-over-year redline aren’t available for PDFs — they need the filing’s live web page or its EDGAR source.'}
                  </Banner>
                )}
                {/* Middle tier: a general financial page (IR release, transcript,
                    financial news). Honest non-filing framing, but the on-device
                    investor read and sentiment ARE available — calmer info tone. */}
                {isGeneralFinancialDoc(currentDoc) && !isPdfDoc(currentDoc) && (
                  <Banner tone="info" icon="ℹ" className="px-4 py-3 text-[11px]">
                    <span className="font-semibold">Not an SEC filing</span>
                    {' — showing a general financial read of this page. The investor analysis below is an on-device interpretation of the page’s text; the year-over-year redline needs an EDGAR filing. On-page highlights are off, '}
                    <span className="whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setFlagOverlayPref(true)}
                        className="inline font-medium text-sky-300 underline decoration-sky-400/50 underline-offset-2 transition hover:text-sky-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                      >
                        show them anyway
                      </button>
                      .
                    </span>
                  </Banner>
                )}
                {/* Low-confidence banner is meaningless for a PDF (no on-page
                    highlights to reveal), so the PDF banner above replaces it;
                    general financial pages get the calmer middle-tier banner. */}
                {isLowConfidenceGeneric(currentDoc) && !isGeneralFinancialDoc(currentDoc) && !isPdfDoc(currentDoc) && (
                  <Banner tone="warn" className="px-4 py-3 text-[11px]">
                    <span className="font-semibold">This page doesn&rsquo;t look like an SEC filing</span>
                    {' — investor analysis, sentiment, and redline are unavailable. Summary and language flags still apply; on-page highlights are off, '}
                    <span className="whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setFlagOverlayPref(true)}
                        className="inline font-medium text-amber-200 underline decoration-amber-400/50 underline-offset-2 transition hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                      >
                        show them anyway
                      </button>
                      .
                    </span>
                  </Banner>
                )}
                <button
                  onClick={() => void startAnalyze()}
                  disabled={analyzing}
                  className="flex w-full items-center justify-center rounded-[4px] border border-sky-500/40 px-3 py-2 text-[13px] font-medium text-sky-400 transition hover:border-sky-400/60 hover:bg-zinc-900/50 hover:text-sky-300 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                >
                  {analyzing ? 'Analyzing…' : 'Analyze this page'}
                </button>
                {analyzeError && (
                  <Banner tone="warn" icon="⚠">
                    {analyzeError}
                  </Banner>
                )}
                {needsPermission && (
                  <Banner tone="info" icon="ℹ">
                    <span className="font-semibold">{needsPermission.label}</span> needs a
                    one-time permission grant.{' '}
                    <button
                      onClick={handleGrantPermission}
                      className="font-medium text-sky-300 underline decoration-sky-400/50 underline-offset-2 transition hover:text-sky-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                    >
                      Allow access
                    </button>
                    {' · '}
                    <button
                      onClick={() => setNeedsPermission(null)}
                      className="text-zinc-400 underline underline-offset-2 transition hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                    >
                      Skip
                    </button>
                  </Banner>
                )}
                {gateState === 'consent_wall' && (
                  <Banner tone="warn" icon="⚠">
                    A <span className="font-semibold">consent banner</span> is covering the
                    content. Accept or close it in the browser, then click{' '}
                    <span className="font-medium">Analyze this page</span> again.
                  </Banner>
                )}
                {gateState === 'paywall' && (
                  <Banner tone="warn" icon="⚠">
                    This page appears to have a{' '}
                    <span className="font-semibold">paywall or registration gate</span>. Relic
                    can only analyze content visible to you — dismiss the gate and retry.
                  </Banner>
                )}
                {isDataReport(currentDoc) && (
                  <Banner tone="info" icon="ℹ">
                    <span className="font-semibold">SEC data/report page</span> — this is a
                    regulatory document, not a company filing. Investor analysis, sentiment, and
                    redline are unavailable; Summary and language flags still apply.
                  </Banner>
                )}
                {isFilingIndex(currentDoc) && (
                  <Banner tone="info" icon="ℹ">
                    <span className="font-semibold">EDGAR filing index</span> — this is the
                    submission&rsquo;s document list, not the filing itself. Open the primary
                    document linked on the page (the main <span className="font-medium">.htm</span>{' '}
                    file) and analyze that for the full breakdown.
                  </Banner>
                )}
                {isEdgarExhibit(currentDoc) && (
                  <Banner tone="info" icon="ℹ">
                    <span className="font-semibold">This looks like an exhibit</span>, not the full
                    filing — exhibits (e.g.{' '}
                    <span className="font-medium">EX-21</span> subsidiaries,{' '}
                    <span className="font-medium">EX-23</span> consents) have no MD&amp;A or risk
                    factors to analyze. Open the primary{' '}
                    <span className="font-medium">10-K</span>/<span className="font-medium">10-Q</span>{' '}
                    document (the main <span className="font-medium">.htm</span> in the filing, without
                    an <span className="font-medium">exNN</span> suffix) for full investor analysis.
                  </Banner>
                )}
                <TabBar active={activeTab} onSelect={setActiveTab} tabs={visibleTabs} />

                {/* Tab panels — kept mounted to preserve async state across switches.
                    Investor-context panels (analyst/sentiment/changes) are not even
                    mounted for SEC data/report pages or EDGAR index pages, so they
                    never auto-run investment-thesis analysis or hit EDGAR for a prior
                    filing on a page that has no thesis to analyze. */}
                {!hidesInvestorTabs(currentDoc) && (
                  <div
                    id="panel-analyst"
                    role="tabpanel"
                    aria-labelledby="tab-analyst"
                    hidden={activeTab !== 'analyst'}
                  >
                    <AnalystPanel
                      doc={currentDoc}
                      detectedTier={caps.generationTier}
                      promptReady={caps.promptApi === 'available'}
                      flags={currentFlags}
                    />
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
                {!hidesInvestorTabs(currentDoc) && (
                  <div
                    id="panel-sentiment"
                    role="tabpanel"
                    aria-labelledby="tab-sentiment"
                    hidden={activeTab !== 'sentiment'}
                  >
                    <SentimentPanel doc={currentDoc} flags={currentFlags} />
                  </div>
                )}
                {!hidesInvestorTabs(currentDoc) && (
                  <div id="panel-changes" role="tabpanel" aria-labelledby="tab-changes" hidden={activeTab !== 'changes'}>
                    <RedlinePanel doc={currentDoc} detectedTier={caps.generationTier} />
                  </div>
                )}

              </m.div>
            ) : (
              <m.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <NoFiling
                  caps={caps}
                  analyzing={analyzing}
                  analyzeError={analyzeError}
                  onAnalyze={() => void startAnalyze()}
                  needsPermission={needsPermission}
                  onGrantPermission={handleGrantPermission}
                  onDismissPermission={() => setNeedsPermission(null)}
                  gateState={gateState}
                />
              </m.div>
            )}
          </AnimatePresence>
          </div>
        )}

        {/* Onboarding still loading */}
        {caps && onboarded === null && <SkeletonCard lines={4} />}
      </main>
    </div>
  );
}
