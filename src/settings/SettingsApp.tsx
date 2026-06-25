// ============================================================
// Disclora — extension settings & guide page
// ------------------------------------------------------------
// Opened from the side-panel header (chrome.runtime.openOptionsPage).
// Editorial single-column layout: controls first (Privacy & data), then the
// guide (How it works, FAQ, About). Every control here is wired
// to real persisted state — nothing is decorative.
// ============================================================

import { useCallback, useState, type ReactNode } from 'react';
import { useCapabilities } from '@/runtime/useCapabilities';
import { Switch } from '@/sidepanel/OverlayControls';
import { useSecFetchPref } from '@/shared/secFetchPref';
import { clearAllCaches } from '@/shared/clearCaches';
import {
  BrandLogo,
  LockIcon,
  TierBadge,
  VERSION_ACCENT,
  stateColor,
  stateLabel,
} from '@/sidepanel/ui';

const ONBOARDED_KEY = 'disclora:onboarded';

// ── static content ──────────────────────────────────────────────────────────

const STEPS: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Open a filing',
    detail:
      'Visit a 10-K, 10-Q, 8-K, 20-F, S-1, or proxy on SEC EDGAR — or run “Analyze this page” on a supported IR or filing page. Disclora wakes up in the side panel.',
  },
  {
    title: 'Read the tabs',
    detail:
      'Analyst builds an investor read, Summary condenses each section, Sentiment scores tone with FinBERT, and Changes diffs against last year’s filing. Each runs on-device as it’s ready.',
  },
  {
    title: 'Highlight on the page',
    detail:
      'Language-flag underlines paint directly on the filing to mark uncertainty, weak-modal, litigious, and negative phrasing.',
  },
];

const FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Does any of my data leave my computer?',
    a: 'No. Filing text, summaries, and notes never leave the device — the models run locally. The one exception is the Changes tab, which fetches a prior-year filing from sec.gov to compare against, and only when you ask. You can turn that off under Privacy & data.',
  },
  {
    q: 'Why are some tabs missing on a page?',
    a: 'Analyst, Sentiment, and Changes need a company filing with a real investment thesis. On SEC data/report pages, EDGAR index pages, exhibits, and pages that don’t look like a filing, Disclora keeps Summary only.',
  },
  {
    q: 'What’s the difference between Built-in AI and Extractive mode?',
    a: 'Built-in AI (Chrome’s Gemini Nano) writes analyst notes and change narratives in natural language. Extractive mode instead surfaces the filing’s most important existing sentences. Sentiment, language flags, and year-over-year changes work fully in both.',
  },
  {
    q: 'Why is the first analysis slow?',
    a: 'The first time you use Built-in AI, Chrome downloads and sets up Gemini Nano — a one-time step it manages itself. Large filings also take up to a minute to read. Sentiment and flags are available immediately in the meantime.',
  },
  {
    q: 'What do the underline styles mean?',
    a: 'Each language-flag category has its own non-color underline so it stays distinguishable without relying on color: dashed for uncertainty, dotted for weak modal, double for litigious, and wavy for negative phrasing.',
  },
  {
    q: 'Is this investment advice?',
    a: 'No. Disclora is a research tool that summarizes and characterizes disclosure language. Its reads, scores, and bull/bear framing are informational only — not investment advice, a recommendation, or a solicitation. Always do your own due diligence.',
  },
];

const BUNDLED_MODELS = [
  { name: 'Encoder', role: 'Extractive summary & redline matching' },
  { name: 'FinBERT', role: 'Financial sentiment & tone' },
];

// ── primitives ──────────────────────────────────────────────────────────────

function Section({ title, kicker, children }: { title: string; kicker?: string; children: ReactNode }) {
  return (
    <section className="mb-11">
      <h2 className="font-[Georgia,serif] text-[20px] font-medium tracking-tight text-zinc-100">{title}</h2>
      {kicker && (
        <p className="mt-1 text-[11px] uppercase tracking-[0.12em] text-zinc-600">{kicker}</p>
      )}
      <div className={kicker ? 'mt-4' : 'mt-3'}>{children}</div>
    </section>
  );
}

/** A control row: label + helper on the left, control flush right, hairline divider. */
function Row({
  label,
  helper,
  control,
  first = false,
}: {
  label: ReactNode;
  helper?: ReactNode;
  control: ReactNode;
  first?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 py-3 ${first ? '' : 'border-t border-zinc-800/70'}`}>
      <div className="flex-1">
        <div className="text-[14px] font-medium text-zinc-200">{label}</div>
        {helper && <div className="mt-0.5 text-[13px] leading-relaxed text-zinc-500">{helper}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function FaqItem({ q, a, defaultOpen = false }: { q: string; a: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-zinc-800/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <span className={`flex-1 text-[14px] ${open ? 'font-medium text-zinc-100' : 'text-zinc-200'}`}>{q}</span>
        <svg
          className={`h-4 w-4 shrink-0 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <p className="-mt-0.5 pb-3.5 pr-7 text-[13px] leading-relaxed text-zinc-400">{a}</p>
      )}
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function SettingsApp() {
  const { caps } = useCapabilities();
  const { enabled: secFetch, setSecFetch } = useSecFetchPref();
  const version = chrome.runtime.getManifest().version;

  const [cacheState, setCacheState] = useState<'idle' | 'clearing' | 'done'>('idle');
  const [replayed, setReplayed] = useState(false);

  const clearCaches = useCallback(() => {
    setCacheState('clearing');
    void clearAllCaches()
      .then(() => {
        setCacheState('done');
        setTimeout(() => setCacheState('idle'), 2500);
      })
      .catch(() => setCacheState('idle'));
  }, []);

  const replayOnboarding = useCallback(() => {
    chrome.storage.local.remove(ONBOARDED_KEY).catch(() => {});
    setReplayed(true);
    setTimeout(() => setReplayed(false), 2500);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 selection:bg-sky-500/30">
      <main className="mx-auto max-w-[560px] px-6 py-10">
        {/* Masthead */}
        <header className="mb-12 flex flex-col items-center text-center">
          <BrandLogo className="h-10 w-10" />
          <h1 className="mt-2.5 font-[Georgia,serif] text-[25px] font-medium tracking-tight text-zinc-100">Disclora</h1>
          <p className="mt-1 text-[14px] text-zinc-500">
            Settings &amp; guide ·{' '}
            <span className="font-mono text-[13px]" style={{ color: VERSION_ACCENT }}>v{version}</span>
          </p>
        </header>

        {/* Privacy & data */}
        <Section title="Privacy & data" kicker="Your research stays on your computer">
          <p className="flex items-start gap-2 text-[14px] leading-relaxed text-zinc-400">
            <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>
              No filing text, summaries, or notes are uploaded — the models run on your device. The one
              network request is below, and it only fires when you ask for a redline.
            </span>
          </p>
          <div className="mt-4">
            <Row
              first
              label="Fetch prior-year filings from SEC.gov"
              helper="Powers the year-over-year Changes comparison. The only request Disclora makes."
              control={<Switch checked={secFetch} onChange={setSecFetch} label="Fetch from SEC.gov" on="bg-sky-600" />}
            />
            <Row
              label="Cached analyses"
              helper="Kept on this device so re-opening a filing is instant."
              control={
                <button
                  type="button"
                  onClick={clearCaches}
                  disabled={cacheState !== 'idle'}
                  className="rounded-md bg-zinc-800 px-3 py-1.5 text-[13px] font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-700 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                >
                  {cacheState === 'clearing' ? 'Clearing…' : cacheState === 'done' ? 'Cleared ✓' : 'Clear'}
                </button>
              }
            />
          </div>
        </Section>

        {/* How it works */}
        <Section title="How it works" kicker="From a filing to an investor read">
          <ol className="flex flex-col gap-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3.5">
                <span className="font-[Georgia,serif] text-[17px] leading-tight text-zinc-600" aria-hidden="true">{i + 1}</span>
                <div>
                  <p className="text-[14px] font-medium text-zinc-200">{s.title}</p>
                  <p className="mt-0.5 text-[14px] leading-relaxed text-zinc-400">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-zinc-800/70 pt-3 text-[13px] leading-relaxed text-zinc-500">
            Most detailed on SEC EDGAR filings; enhanced on AnnualReports, StockAnalysis, Fool, and Benzinga;
            quick summary and flags on any other site.
          </p>
        </Section>

        {/* FAQ */}
        <Section title="Frequently asked">
          <div>
            {FAQS.map((f, i) => (
              <FaqItem key={f.q} q={f.q} a={f.a} defaultOpen={i === 0} />
            ))}
          </div>
        </Section>

        {/* About */}
        <Section title="About" kicker="Bundled models & this device">
          {BUNDLED_MODELS.map((m, i) => (
            <Row key={m.name} first={i === 0} label={m.name} helper={m.role} control={null} />
          ))}
          {caps && (
            <Row
              label="Generation mode"
              helper="Detected on this device"
              control={
                <div className="flex items-center gap-2">
                  {caps.generationTier === 'builtin' && (
                    <span className={`text-[12px] ${stateColor(caps.promptApi)}`}>{stateLabel(caps.promptApi)}</span>
                  )}
                  <TierBadge tier={caps.generationTier} />
                </div>
              }
            />
          )}
          <Row
            label="Replay onboarding"
            helper="Show the welcome screen again next time you open the side panel."
            control={
              <button
                type="button"
                onClick={replayOnboarding}
                className="rounded-md bg-zinc-800 px-3 py-1.5 text-[13px] font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
              >
                {replayed ? 'Reset ✓' : 'Replay'}
              </button>
            }
          />
        </Section>
      </main>
    </div>
  );
}
