// ============================================================
// Disclora — header Export control
// ------------------------------------------------------------
// One click gathers every cached artifact for the current filing (investor
// analysis, section summaries, sentiment, YoY redline), renders them into a
// real PDF (selectable text, via jsPDF's standard fonts), and downloads it
// straight to the user's Downloads — no print dialog. Everything runs
// on-device; nothing is sent to the network.
// ============================================================

import { useCallback, useState } from 'react';
import type { DocumentModel } from '@/types';
import { collectFilingExportData } from '@/export/collect';
import { hasExportableData } from '@/export/report';
import { downloadFilingReportPdf } from '@/export/pdf';

type State = 'idle' | 'busy' | 'empty' | 'error';

function ExportIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
      <path d="M14 3v5h5" strokeLinejoin="round" />
      <path d="M12 18v-6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m9.5 14.5 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ExportButton({ doc }: { doc: DocumentModel }) {
  const [state, setState] = useState<State>('idle');

  const onClick = useCallback(async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      const data = await collectFilingExportData(doc);
      if (!hasExportableData(data)) {
        setState('empty');
        setTimeout(() => setState('idle'), 3500);
        return;
      }
      downloadFilingReportPdf(data);
      setState('idle');
    } catch (err) {
      console.warn('Disclora export failed', err);
      setState('error');
      setTimeout(() => setState('idle'), 3500);
    }
  }, [doc, state]);

  const label =
    state === 'busy' ? 'Preparing…'
    : state === 'empty' ? 'Nothing to export yet'
    : state === 'error' ? 'Export failed'
    : 'Export';

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={state === 'busy'}
      title="Download all analysis for this filing as a PDF"
      aria-label="Export all analysis for this filing as a PDF"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-sky-500/50 hover:bg-zinc-800 hover:text-sky-300 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]"
    >
      <ExportIcon />
      {label}
    </button>
  );
}
