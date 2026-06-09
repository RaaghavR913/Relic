// ============================================================
// FilingLens — Language Flag side-panel component (Session 5)
// ------------------------------------------------------------
// Displays per-section flag counts by type; clicking a type badge scrolls
// to and briefly highlights the first occurrence of that type in the section.
//
// Legend:
//   - -   uncertainty  (mirrors dashed underline in the filing)
//   ···   weak_modal   (mirrors dotted underline)
//   ══    litigious    (mirrors double underline)
//   ~~~   negative     (mirrors wavy underline)
// ============================================================

import { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { DocumentModel, LanguageFlag, Section } from '@/types';
import type { ContentScrollToFlagMsg } from '@/messages/types';

// ── types ─────────────────────────────────────────────────────────────────────

type FlagType = LanguageFlag['type'];

interface SectionFlagSummary {
  section: Section;
  counts: Record<FlagType, number>;
  firstRanges: Partial<Record<FlagType, [number, number]>>;
  total: number;
}

// ── constants ─────────────────────────────────────────────────────────────────

const FLAG_TYPES: FlagType[] = ['uncertainty', 'weak_modal', 'litigious', 'negative'];

const FLAG_LABEL: Record<FlagType, string> = {
  uncertainty: 'Uncertainty',
  weak_modal:  'Weak Modal',
  litigious:   'Litigious',
  negative:    'Negative',
};

/** Pattern markers mirror the underline styles in the filing overlay (WCAG non-colour cue). */
const FLAG_MARKER: Record<FlagType, string> = {
  uncertainty: '- -',
  weak_modal:  '···',
  litigious:   '══',
  negative:    '~~~',
};

/** Tailwind colour classes per type (bg + text), intentionally distinct. */
const FLAG_COLOURS: Record<FlagType, { badge: string; label: string }> = {
  uncertainty: { badge: 'bg-amber-500/15 text-amber-300 ring-amber-500/25',  label: 'text-amber-400' },
  weak_modal:  { badge: 'bg-sky-500/15 text-sky-300 ring-sky-500/25',        label: 'text-sky-400'   },
  litigious:   { badge: 'bg-red-500/15 text-red-300 ring-red-500/25',        label: 'text-red-400'   },
  negative:    { badge: 'bg-rose-500/15 text-rose-300 ring-rose-500/25',     label: 'text-rose-400'  },
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function getActiveTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function sendScrollToFlag(range: [number, number]): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === undefined) return;
  const msg: ContentScrollToFlagMsg = {
    target: 'content',
    type:   'SCROLL_TO_FLAG',
    range,
  };
  await chrome.tabs.sendMessage(tabId, msg);
}

function buildSummaries(
  sections: Section[],
  flags: LanguageFlag[],
): SectionFlagSummary[] {
  const sorted = [...sections].sort((a, b) => a.order - b.order);

  return sorted.map((section) => {
    const sectionFlags = flags.filter((f) => f.sectionId === section.id);
    const counts = { uncertainty: 0, weak_modal: 0, litigious: 0, negative: 0 } as Record<FlagType, number>;
    const firstRanges: Partial<Record<FlagType, [number, number]>> = {};

    for (const flag of sectionFlags) {
      counts[flag.type]++;
      if (!firstRanges[flag.type]) firstRanges[flag.type] = flag.range;
    }

    return { section, counts, firstRanges, total: sectionFlags.length };
  }).filter((s) => s.total > 0); // only show sections that have flags
}

// ── TypeBadge ─────────────────────────────────────────────────────────────────

function TypeBadge({
  type,
  count,
  onScrollTo,
}: {
  type: FlagType;
  count: number;
  onScrollTo: () => void;
}) {
  if (count === 0) return null;
  const { badge } = FLAG_COLOURS[type];
  return (
    <button
      onClick={onScrollTo}
      title={`${FLAG_LABEL[type]}: ${count} flag${count !== 1 ? 's' : ''} — click to jump to first`}
      aria-label={`${count} ${FLAG_LABEL[type]} flag${count !== 1 ? 's' : ''} in this section. Click to jump.`}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset transition hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${badge}`}
    >
      <span aria-hidden="true" className="font-mono tracking-wider">{FLAG_MARKER[type]}</span>
      <span>{count}</span>
    </button>
  );
}

// ── SectionFlagRow ────────────────────────────────────────────────────────────

function SectionFlagRow({
  summary,
  onScrollTo,
}: {
  summary: SectionFlagSummary;
  onScrollTo: (type: FlagType) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-zinc-900 px-3 py-2.5 ring-1 ring-zinc-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex-1 truncate text-xs font-medium text-zinc-200 leading-snug">
          {summary.section.label}
        </span>
        <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
          {summary.total}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FLAG_TYPES.map((type) => (
          <TypeBadge
            key={type}
            type={type}
            count={summary.counts[type]}
            onScrollTo={() => onScrollTo(type)}
          />
        ))}
      </div>
    </div>
  );
}

// ── TotalsRow ─────────────────────────────────────────────────────────────────

function TotalsRow({ flags }: { flags: LanguageFlag[] }) {
  const totals = useMemo(() => {
    const t = { uncertainty: 0, weak_modal: 0, litigious: 0, negative: 0 } as Record<FlagType, number>;
    for (const f of flags) t[f.type]++;
    return t;
  }, [flags]);

  return (
    <div className="flex flex-wrap gap-2">
      {FLAG_TYPES.map((type) => {
        const n = totals[type];
        if (n === 0) return null;
        const { label } = FLAG_COLOURS[type];
        return (
          <div key={type} className="flex items-center gap-1 text-[11px]">
            <span aria-hidden="true" className={`font-mono tracking-wider ${label}`}>
              {FLAG_MARKER[type]}
            </span>
            <span className="text-zinc-400">{FLAG_LABEL[type]}</span>
            <span className={`font-semibold tabular-nums ${label}`}>{n}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── FlagPanel ─────────────────────────────────────────────────────────────────

interface FlagPanelProps {
  doc: DocumentModel;
  flags: LanguageFlag[];
}

export function FlagPanel({ doc, flags }: FlagPanelProps) {
  const [open, setOpen] = useState(true);
  const [scrolling, setScrolling] = useState(false);

  const summaries = useMemo(
    () => buildSummaries(doc.sections, flags),
    [doc.sections, flags],
  );

  const scrollToFlag = useCallback(
    async (summary: SectionFlagSummary, type: FlagType) => {
      const range = summary.firstRanges[type];
      if (!range || scrolling) return;
      setScrolling(true);
      try {
        await sendScrollToFlag(range);
      } catch {
        // Silently ignore — tab may not have the content script active.
      } finally {
        setScrolling(false);
      }
    },
    [scrolling],
  );

  if (flags.length === 0) return null;

  return (
    <section aria-labelledby="flags-heading" className="flex flex-col gap-3">
      {/* Panel header */}
      <div className="flex items-center gap-2">
        <button
          id="flags-heading"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          aria-controls="flags-body"
        >
          <p className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
            Language Flags
          </p>
          <span className="ml-auto text-[11px] text-zinc-600 tabular-nums">
            {flags.length}
          </span>
          <svg
            className={`h-3 w-3 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
          >
            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="flags-body"
            key="flags-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-3">
              {/* Legend / totals */}
              <div
                className="rounded-lg bg-zinc-900/60 px-3 py-2.5 ring-1 ring-zinc-800/60"
                role="region"
                aria-label="Flag type totals"
              >
                <p className="mb-1.5 text-[10px] uppercase tracking-widest text-zinc-600">
                  Totals across all sections
                </p>
                <TotalsRow flags={flags} />
                <p className="mt-2 text-[10px] text-zinc-600 leading-relaxed">
                  Each marker mirrors the underline pattern in the filing overlay.
                  Hover any flagged phrase in the filing for its note.
                </p>
              </div>

              {/* Per-section rows */}
              <div className="flex flex-col gap-2" role="list" aria-label="Sections with flags">
                {summaries.map((summary) => (
                  <div key={summary.section.id} role="listitem">
                    <SectionFlagRow
                      summary={summary}
                      onScrollTo={(type) => void scrollToFlag(summary, type)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
