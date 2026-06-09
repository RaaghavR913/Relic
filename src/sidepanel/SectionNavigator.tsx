// ============================================================
// FilingLens — section navigator (Session 7)
// ------------------------------------------------------------
// A compact, collapsible list of the filing's sections. Selecting one scrolls
// the filing to that section and briefly flashes it (SCROLL_TO_RANGE → content),
// deep-linking through positionMap. Keyboard-reachable; reduced-motion aware.
// ============================================================

import { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { DocumentModel, Section } from '@/types';
import type { ContentScrollToRangeMsg } from '@/messages/types';

async function jumpToSection(section: Section): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return;
  // A 1-char range at the section start is enough to scroll + flash.
  const start = section.charRange[0];
  const range: [number, number] = [start, Math.min(start + 1, section.charRange[1])];
  const msg: ContentScrollToRangeMsg = { target: 'content', type: 'SCROLL_TO_RANGE', range };
  await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

export function SectionNavigator({ doc }: { doc: DocumentModel }) {
  const reduced = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);

  const sections = useMemo(
    () => [...doc.sections].sort((a, b) => a.order - b.order),
    [doc],
  );

  const onJump = useCallback((section: Section) => {
    void jumpToSection(section);
  }, []);

  if (sections.length === 0) return null;

  return (
    <section aria-label="Section navigator" className="rounded-xl bg-zinc-900 ring-1 ring-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="section-nav-list"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-zinc-800/40 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Sections</span>
        <span className="text-[11px] text-zinc-600">({sections.length})</span>
        <svg className={`ml-auto h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="section-nav-list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.18 }}
            className="overflow-hidden"
          >
            <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto border-t border-zinc-800 p-2" role="list">
              {sections.map((section) => (
                <li key={section.id}>
                  <button
                    onClick={() => onJump(section)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                    title={`Jump to ${section.label}`}
                  >
                    <span className="flex-1 truncate leading-snug">{section.label}</span>
                    <span aria-hidden="true" className="shrink-0 text-zinc-600">↗</span>
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
