// ============================================================
// Relic — extension settings page
// ------------------------------------------------------------
// Opened in a tab via chrome.runtime.openOptionsPage() (options_ui).
// A single centered column: a read-only privacy statement, the handful of
// controls the user can change, and an auto-detected device status block.
//
// Every control is wired to real persisted state through the extension's
// existing storage layer — nothing here is decorative, and the page itself
// makes zero network requests (the privacy promise).
//   • Fetch prior-year filings → relic:secFetch        (useSecFetchPref)
//   • On-page highlights        → relic:flagsEnabled    (overlay prefs)
//   • Clear cached analyses     → clearAllCaches() (IndexedDB)
//   • Replay onboarding         → removes relic:onboarded
//   • Generation mode           → live capability detection (read-only)
// ============================================================

import { useCallback, useState, type ReactNode } from 'react';
import { useCapabilities } from '@/runtime/useCapabilities';
import { useSecFetchPref } from '@/shared/secFetchPref';
import { useOverlayPrefs } from '@/sidepanel/overlayPrefs';
import { clearAllCaches } from '@/shared/clearCaches';
import { BrandLogo, LockIcon } from '@/sidepanel/ui';

// Same storage key the side panel reads on open (src/sidepanel/App.tsx). Removing
// it makes the next side-panel open show the welcome screen again.
const ONBOARDED_KEY = 'relic:onboarded';

// Self-hosted system serif stack — no remote font fetch (privacy + Web Store review).
const SERIF = '"Iowan Old Style", Palatino, Georgia, serif';

// Accent teal-green: version string, status dots, lock icon, focus rings.
const ACCENT = '#34d399';

// ── static content ──────────────────────────────────────────────────────────

/** Three-step walkthrough — rendered as title + detail rows, in document order. */
const STEPS: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Open a filing',
    detail:
      'Go to a 10-K, 10-Q, 8-K, 20-F, S-1, or proxy on SEC EDGAR and open Relic from the side panel. On other financial pages, click the Relic toolbar icon and choose “Analyze this page.”',
  },
  {
    title: 'Read the analysis tabs',
    detail:
      'Analyst gives an investor read, Summary condenses each section, Sentiment scores tone with FinBERT, and Changes compares against last year’s filing. Each appears as it finishes — all on your device.',
  },
  {
    title: 'Use the on-page highlights',
    detail:
      'Relic underlines cautious, litigious, and negative wording directly in the filing so the language that matters is easy to spot. Turn highlights on or off under Settings.',
  },
];

/** Frequently asked questions — question + answer rows. */
const FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Does any of my data leave my device?',
    a: 'No. Filing text, summaries, and notes stay on your device. The only network request is the Changes lookup, which fetches last year’s filing from SEC.gov — and only when you ask. You can turn it off under Settings.',
  },
  {
    q: 'Why are some tabs missing on a page?',
    a: 'Analyst, Sentiment, and Changes need a real company filing. On SEC data pages, EDGAR index pages, exhibits, and pages that don’t look like a filing, Relic keeps Summary only.',
  },
  {
    q: 'What’s the difference between Built-in AI and Extractive?',
    a: 'Built-in AI writes analyst notes and change narratives in natural language. Extractive instead surfaces the filing’s most important existing sentences. Sentiment, highlights, and Changes work fully in both.',
  },
  {
    q: 'Why is the first analysis slow?',
    a: 'The first time you use Built-in AI, your browser downloads its on-device model — a one-time step it manages itself. Large filings also take up to a minute to read. Sentiment and highlights are ready immediately.',
  },
];

// ── primitives ──────────────────────────────────────────────────────────────

function Section({
  title,
  sublabel,
  children,
}: {
  title: string;
  sublabel: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="text-[20px] font-medium text-[#f4f4f5]" style={{ fontFamily: SERIF }}>
        {title}
      </h2>
      <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.13em] text-[#7f7f87]">
        {sublabel}
      </p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A row: title + description on the left, control flush right, 0.5px top divider. */
function Row({
  title,
  desc,
  control,
}: {
  title: string;
  desc: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 border-t-[0.5px] border-[#1f1f22] py-4">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-[#ededf0]">{title}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-[#8a8a90]">{desc}</p>
      </div>
      {control && <div className="mt-0.5 shrink-0">{control}</div>}
    </div>
  );
}

/** Pill switch: ON = #3b82f6 + white knob, OFF = #3a3a3e. Keyboard-operable, reduced-motion aware. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full outline-none transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-[#34d399] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c0d] motion-reduce:transition-none"
      style={{ backgroundColor: checked ? '#3b82f6' : '#3a3a3e' }}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none ${
          checked ? 'translate-x-[23px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

/** Secondary action button (Clear / Replay). */
function ActionButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-[#1c1c1f] px-3 py-1.5 text-[13px] font-medium text-[#ededf0] ring-1 ring-[#2a2a2e] outline-none transition hover:bg-[#26262a] disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#34d399] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c0d]"
    >
      {children}
    </button>
  );
}

/** Live generation-mode status: a dot + label reflecting real capability detection. */
function GenerationStatus() {
  const { caps, error } = useCapabilities();

  let dot = '#6b6b70';
  let text = 'Checking…';
  let textColor = '#8a8a90';
  let busy = false;

  if (error) {
    text = 'Unavailable';
  } else if (!caps) {
    busy = true; // detecting
  } else if (caps.generationTier === 'builtin') {
    dot = ACCENT;
    text = 'Built-in AI · ready';
    textColor = ACCENT;
  } else {
    dot = '#8a8a90';
    text = 'Extractive';
    textColor = '#c4c4c8';
  }

  return (
    <div role="status" aria-live="polite" aria-busy={busy} className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${busy ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        style={{ backgroundColor: dot }}
      />
      <span className="text-[13px] font-medium" style={{ color: textColor }}>
        {text}
      </span>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function SettingsApp() {
  const { enabled: secFetch, setSecFetch } = useSecFetchPref();
  const { prefs, setFlags } = useOverlayPrefs();
  const version = chrome.runtime.getManifest().version;

  const [cacheState, setCacheState] = useState<'idle' | 'clearing' | 'done'>('idle');
  const [replayed, setReplayed] = useState(false);
  // Polite live region so screen readers hear the result of the one-shot actions.
  const [announce, setAnnounce] = useState('');

  const clearCaches = useCallback(() => {
    setCacheState('clearing');
    void clearAllCaches()
      .then(() => {
        setCacheState('done');
        setAnnounce('Cached analyses cleared.');
        setTimeout(() => setCacheState('idle'), 2500);
      })
      .catch(() => setCacheState('idle'));
  }, []);

  const replayOnboarding = useCallback(() => {
    void chrome.storage.local.remove(ONBOARDED_KEY).catch(() => {});
    setReplayed(true);
    setAnnounce('The welcome screen will show next time you open the side panel.');
    setTimeout(() => setReplayed(false), 2500);
  }, []);

  return (
    <div className="min-h-screen bg-[#0c0c0d] text-[#c4c4c8] selection:bg-[#34d399]/25">
      <main className="mx-auto max-w-[560px] px-5 py-12 sm:px-6">
        {/* Header */}
        <header className="mb-12 flex flex-col items-center text-center">
          <BrandLogo className="h-12 w-12" />
          <h1
            className="mt-3 text-[26px] font-medium tracking-tight text-[#f4f4f5]"
            style={{ fontFamily: SERIF }}
          >
            Relic
          </h1>
          <p className="mt-1 text-[13px] text-[#8a8a90]">
            Settings ·{' '}
            <span className="font-medium" style={{ color: ACCENT }}>
              v{version}
            </span>
          </p>
        </header>

        {/* Privacy & data — read-only */}
        <Section title="Privacy & data" sublabel="Your research stays on your computer">
          <p className="flex items-start gap-2.5 text-[14px] leading-relaxed text-[#c4c4c8]">
            <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#34d399]" />
            <span>
              No filing text, summaries, or notes leave your device — the models run locally. The one
              network request is the Changes lookup below, and it only fires when you compare against
              last year&rsquo;s filing.
            </span>
          </p>
        </Section>

        {/* How to use — read-only walkthrough */}
        <Section title="How to use" sublabel="From a filing to an investor read">
          {STEPS.map((s) => (
            <Row key={s.title} title={s.title} desc={s.detail} control={null} />
          ))}
        </Section>

        {/* Settings — interactive */}
        <Section title="Settings" sublabel="Everything you can control, in one place">
          <Row
            title="Fetch prior-year filings from SEC.gov"
            desc="Powers the year-over-year Changes comparison. The only network request Relic makes."
            control={
              <Toggle
                checked={secFetch}
                onChange={setSecFetch}
                label="Fetch prior-year filings from SEC.gov"
              />
            }
          />
          <Row
            title="On-page highlights"
            desc="Paint language flags onto the filing: uncertainty, weak-modal, litigious, negative."
            control={
              <Toggle checked={prefs.flags} onChange={setFlags} label="On-page highlights" />
            }
          />
          <Row
            title="Cached analyses"
            desc="Kept on this device so re-opening a filing is instant."
            control={
              <ActionButton onClick={clearCaches} disabled={cacheState !== 'idle'}>
                {cacheState === 'clearing' ? 'Clearing…' : cacheState === 'done' ? 'Cleared ✓' : 'Clear'}
              </ActionButton>
            }
          />
          <Row
            title="Replay onboarding"
            desc="Show the welcome screen next time you open the side panel."
            control={
              <ActionButton onClick={replayOnboarding}>
                {replayed ? 'Replayed ✓' : 'Replay'}
              </ActionButton>
            }
          />
        </Section>

        {/* FAQ — read-only */}
        <Section title="FAQ" sublabel="Questions, answered">
          {FAQS.map((f) => (
            <Row key={f.q} title={f.q} desc={f.a} control={null} />
          ))}
        </Section>

        {/* On this device — read-only status */}
        <Section title="On this device" sublabel="Detected automatically · nothing to set">
          <Row
            title="Generation mode"
            desc="Chosen automatically from the page you’re viewing — Built-in AI when your browser supports it, otherwise the extractive model."
            control={<GenerationStatus />}
          />
          <Row
            title="Bundled models"
            desc="FinBERT for financial sentiment, plus an on-device encoder for summaries and Changes matching."
            control={null}
          />
        </Section>

        {/* Footer */}
        <footer className="mt-12 border-t-[0.5px] border-[#1f1f22] pt-6 text-center text-[12px] text-[#8a8a90]">
          Relic summarizes filings. It isn&rsquo;t investment advice.
        </footer>

        {/* Polite announcements for one-shot actions (visually hidden). */}
        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>
      </main>
    </div>
  );
}
