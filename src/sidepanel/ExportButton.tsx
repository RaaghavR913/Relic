// ============================================================
// Disclora — header Export control
// ------------------------------------------------------------
// One click gathers every cached artifact for the current filing (investor
// analysis, section summaries, sentiment, YoY redline), renders the styled
// report into a hidden iframe, and opens the browser's print dialog so the user
// can save it as a PDF (selectable text, no rasterization). Going through the
// browser's print engine keeps the export dependency-free and on-device — no
// bundled PDF library, no network, nothing leaves the browser.
// ============================================================

import { useCallback, useState } from 'react';
import type { DocumentModel } from '@/types';
import { collectFilingExportData } from '@/export/collect';
import { buildFilingReportHtml, hasExportableData } from '@/export/report';

type State = 'idle' | 'busy' | 'empty' | 'error';

/**
 * Render `html` into an off-screen iframe and open the print dialog on it, so
 * the user can "Save as PDF". Resolves once printing finishes or is dismissed.
 * The iframe carries the extension origin, so its inline <style> is allowed by
 * the extension CSP (no inline scripts are emitted into the report).
 */
function printReportAsPdf(html: string): Promise<void> {
  return new Promise((resolve) => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    // Off-screen with real page dimensions so layout resolves before printing.
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;';

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // Defer teardown so the spawned print job can still read the document.
      setTimeout(() => {
        iframe.remove();
        URL.revokeObjectURL(url);
      }, 1000);
      resolve();
    };

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        finish();
        return;
      }
      win.addEventListener('afterprint', finish, { once: true });
      // Let styles/layout settle a beat before the dialog opens.
      setTimeout(() => {
        try {
          win.focus();
          win.print();
        } catch {
          finish();
        }
      }, 120);
    };

    iframe.src = url;
    document.body.appendChild(iframe);
  });
}

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
      await printReportAsPdf(buildFilingReportHtml(data));
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
    : 'Export PDF';

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={state === 'busy'}
      title="Save all analysis for this filing as a PDF (opens the print dialog → Save as PDF)"
      aria-label="Export all analysis for this filing as a PDF"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-sky-500/50 hover:bg-zinc-800 hover:text-sky-300 disabled:cursor-default disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 font-['Roboto',-apple-system,BlinkMacSystemFont,sans-serif]"
    >
      <ExportIcon />
      {label}
    </button>
  );
}
