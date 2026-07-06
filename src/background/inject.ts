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
 *
 * Only sec.gov is auto-injected at install. Every other financial host
 * (formerly "Group A/B" auto-hosts) now lives in optional_host_permissions and
 * is reached on demand: a toolbar click grants activeTab and injects in the
 * gesture, or the side panel requests the optional grant for panel-driven
 * injection. This keeps the install prompt scoped to "sec.gov only".
 */
const AUTO_HOSTS: ReadonlyArray<RegExp> = [
  /(?:^|\.)sec\.gov$/i,
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
  /** Plain http(s) page, or a local file:// page — inject on demand. */
  | 'injectable'
  /** Browser UI, Web Store, or unparseable URL — cannot inject. */
  | 'unsupported';

export function classifyInjectability(url: string | undefined): Injectability {
  if (!url) return 'unsupported';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unsupported';
  }

  // http(s) for remote pages; file: for local documents (typically PDFs opened
  // from disk). file:// injection additionally requires the user to enable
  // "Allow access to file URLs" — the caller checks that grant separately and
  // shows guidance when it is missing.
  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'file:'
  ) {
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
