// ============================================================
// Relic — programmatic-injection URL classification
// ------------------------------------------------------------
// The "Analyze this page" action injects the content script into the active
// tab via chrome.scripting.executeScript (authorized by the activeTab grant
// from the toolbar click). This module decides, from the tab URL alone,
// whether injection is needed, redundant, or impossible.
//
// Pure: no chrome.* access, so it is unit-testable.
// ============================================================

/**
 * Hosts the manifest already auto-injects into (content_scripts matches).
 * Keep in sync with manifest.json content_scripts entries.
 * Group C sites are NOT listed — they require optional_host_permissions granted
 * on demand and are never auto-injected at install.
 */
const AUTO_HOSTS: ReadonlyArray<RegExp> = [
  // sec.gov (original)
  /(?:^|\.)sec\.gov$/i,
  // Group A — static pages, content readable at document_idle
  /(?:^|\.)annualreports\.com$/i,
  /(?:^|\.)stockanalysis\.com$/i,
  /(?:^|\.)fool\.com$/i,
  /(?:^|\.)benzinga\.com$/i,
  // Group B — auto-injected; content-gated in waitForContent (interstitials)
  /(?:^|\.)sec\.report$/i,
  /^finviz\.com$/i,
];

/**
 * Pages Chrome never lets extensions script, even with activeTab.
 */
const UNSUPPORTED_HOSTS: ReadonlyArray<RegExp> = [
  /(?:^|\.)chromewebstore\.google\.com$/i,
  /^chrome\.google\.com$/i, // legacy Web Store host
];

export type Injectability =
  /** Manifest content_scripts already ran here — no injection needed. */
  | 'auto_host'
  /** Plain http(s) page — inject on demand. */
  | 'injectable'
  /** Browser UI, Web Store, local files, or unparseable URL — cannot inject. */
  | 'unsupported';

export function classifyInjectability(url: string | undefined): Injectability {
  if (!url) return 'unsupported';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unsupported';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'unsupported';
  }
  if (UNSUPPORTED_HOSTS.some((re) => re.test(parsed.hostname))) {
    return 'unsupported';
  }
  if (AUTO_HOSTS.some((re) => re.test(parsed.hostname))) {
    return 'auto_host';
  }
  return 'injectable';
}
