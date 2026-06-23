// ============================================================
// Disclora — shared side-panel UI atoms (Session 7)
// ------------------------------------------------------------
// Small, accessible, dependency-light building blocks reused across every tab:
// tier badge, degradation banner, progress bar, loading skeletons, spinner,
// privacy note, and empty state. All respect prefers-reduced-motion and meet
// WCAG AA contrast on the zinc-950 surface.
// ============================================================

import type { ReactNode } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import type { AvailabilityState, GenerationTier } from '@/runtime/capabilities';

/** Stable extension-root path — emitted to dist/ at build time, not inlined in JS. */
const brandLogoUrl = chrome.runtime.getURL('brand-logo.png');

// ── tier + availability presentation ──────────────────────────────────────────

export function stateColor(s: AvailabilityState): string {
  switch (s) {
    case 'available':    return 'text-emerald-400';
    case 'downloadable': return 'text-amber-400';
    case 'downloading':  return 'text-sky-400';
    case 'unavailable':  return 'text-red-400';
    case 'unsupported':  return 'text-zinc-500';
  }
}

export function stateLabel(s: AvailabilityState): string {
  switch (s) {
    case 'available':    return 'Ready';
    case 'downloadable': return 'Needs download';
    case 'downloading':  return 'Downloading…';
    case 'unavailable':  return 'Unavailable';
    case 'unsupported':  return 'Not supported';
  }
}

export function TierBadge({ tier }: { tier: GenerationTier }) {
  if (tier === 'builtin') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-500/30 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]"
        title="Chrome built-in AI (Gemini Nano) is available — generative summaries and analyst notes run on-device."
      >
        Built-in AI
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-zinc-700/60 px-2.5 py-0.5 text-xs font-semibold text-zinc-300 ring-1 ring-inset ring-zinc-600/40 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]"
      title="Extractive mode — key-sentence summaries run fully on-device."
    >
      Extractive
    </span>
  );
}

// ── banners ───────────────────────────────────────────────────────────────────

type BannerTone = 'info' | 'warn' | 'positive';

const BANNER_TONE: Record<BannerTone, string> = {
  info:     'bg-sky-950/40 text-sky-200 ring-sky-800/40',
  warn:     'bg-amber-950/40 text-amber-200 ring-amber-700/40',
  positive: 'bg-emerald-950/40 text-emerald-200 ring-emerald-800/40',
};

/**
 * A degradation / status banner. `tone='warn'` for missing capabilities,
 * `tone='positive'` for the graceful-degradation framing, `tone='info'` for hints.
 * Uses role=status + aria-live so AT users are notified without an alert interruption.
 */
export function Banner({
  tone = 'info',
  icon,
  children,
  className = '',
}: {
  tone?: BannerTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed ring-1 ring-inset ${BANNER_TONE[tone]} ${className}`}
    >
      {icon && <span aria-hidden="true" className="mt-px shrink-0">{icon}</span>}
      <span>{children}</span>
    </div>
  );
}

// ── progress bar ──────────────────────────────────────────────────────────────

export function ProgressBar({
  value,
  label,
  detail,
  color = 'bg-sky-500',
}: {
  value: number; // 0..1
  label: string;
  detail?: string;
  color?: string;
}) {
  const reduced = useReducedMotion() ?? false;
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={detail ?? label}
      className="flex flex-col gap-1"
    >
      <div className="flex justify-between text-[10px] text-zinc-500">
        <span className="truncate pr-2">{detail ?? label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <m.div
          className={`h-full rounded-full ${color}`}
          animate={{ width: `${pct}%` }}
          transition={reduced ? { duration: 0 } : { duration: 0.3 }}
        />
      </div>
    </div>
  );
}

// ── skeletons ─────────────────────────────────────────────────────────────────

/** One shimmering placeholder line. Pauses animation under prefers-reduced-motion. */
export function SkeletonLine({ className = '' }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <div
      className={`h-3 rounded bg-zinc-800 ${reduced ? '' : 'animate-pulse'} ${className}`}
      aria-hidden="true"
    />
  );
}

/** A card-shaped cluster of skeleton lines, used while a tab's data loads. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-zinc-900 p-3 ring-1 ring-zinc-800" role="status" aria-label="Loading">
      <SkeletonLine className="w-2/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} className={i === lines - 1 ? 'w-1/2' : 'w-full'} />
      ))}
    </div>
  );
}

// ── spinner ───────────────────────────────────────────────────────────────────

export function Spinner({ className = 'h-6 w-6 text-sky-500' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function BrandLogo({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <img
      src={brandLogoUrl}
      alt=""
      aria-hidden="true"
      className={`shrink-0 object-contain ${className}`}
    />
  );
}

/** Lime accent used for the version label and settings control in the header. */
export const VERSION_ACCENT = '#39FF14';

/** User + gear settings glyph — profile ring with corner gear (attached artwork). */
export function SettingsIcon({ className = 'h-[18px] w-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        d="M6.35 5.85a8.65 8.65 0 1 0 12.3 1.35"
      />
      <circle cx="12" cy="10.35" r="2.6" />
      <path d="M7.45 16.85c0-2.45 2.03-4.45 4.55-4.45s4.55 2 4.55 4.45" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17 2L18.07 3.19L19.64 3.52L19.15 5.05L19.64 6.57L18.07 6.91L17 8.1L15.93 6.91L14.36 6.58L14.85 5.05L14.36 3.52L15.92 3.19L17 2ZM16.05 5.05a.95.95 0 1 0 1.9 0 .95.95 0 1 0-1.9 0Z"
      />
    </svg>
  );
}

/** Opens the extension settings page (How it works & settings). */
export function SettingsButton() {
  return (
    <button
      type="button"
      onClick={() => chrome.runtime.openOptionsPage()}
      className="group relative -mr-0.5 flex shrink-0 items-center rounded p-0.5 text-[18px] font-[system-ui,-apple-system,BlinkMacSystemFont,sans-serif] transition hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
      style={{ color: VERSION_ACCENT }}
      aria-label="How it works & Settings"
    >
      <SettingsIcon />
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-10 mt-1.5 hidden whitespace-nowrap rounded bg-zinc-800 px-2 py-1 text-[10px] font-medium text-zinc-200 shadow-lg ring-1 ring-zinc-700 group-hover:block group-focus-visible:block"
      >
        How it works &amp; Settings
      </span>
    </button>
  );
}

export function LockIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" strokeLinejoin="round" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── empty state ───────────────────────────────────────────────────────────────

export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-zinc-900/50 px-4 py-8 text-center ring-1 ring-dashed ring-zinc-800">
      <p className="text-[13px] font-medium text-zinc-400 font-[system-ui,-apple-system,BlinkMacSystemFont,sans-serif]">{title}</p>
      <p className="max-w-xs text-[13px] leading-relaxed text-zinc-600 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]">{body}</p>
    </div>
  );
}
