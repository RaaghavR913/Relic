/**
 * Per-site configuration for the multi-site extension.
 *
 * All site-specific knowledge lives here, isolated from the extraction pipeline.
 * The pipeline itself is host-agnostic; this module supplies the overrides.
 *
 * Only sec.gov is a static content_scripts match (auto-injected at install).
 * Every other financial host lives in optional_host_permissions (group 'C') so the
 * install prompt stays "sec.gov only"; those sites are reached on demand — a toolbar
 * click grants activeTab and injects in the gesture, or the side panel requests the
 * host's optionalHostPattern for panel-driven injection. Some group-'C' profiles also
 * carry a contentSelector (gate extraction past a JS-redirect / anti-bot interstitial)
 * and/or consent/paywall selectors (detect-only, never auto-dismissed).
 */

export type SiteGroup = 'sec' | 'A' | 'B' | 'C';

export type GateState = 'open' | 'consent_wall' | 'paywall';

export interface SiteProfile {
  readonly group: SiteGroup;
  /** Human-readable site label for permission dialogs and banners. */
  readonly label: string;
  /**
   * Group B only: CSS selector for real page content.
   * waitForContent() will not resolve until this selector matches, preventing
   * extraction from running against a JS redirect interstitial or bot-check page.
   * UNVERIFIED — replace with outerHTML-derived selectors when fixtures are available.
   */
  readonly contentSelector?: string;
  /**
   * Group C only: the optional_host_permissions pattern to request at runtime.
   * Must exactly match the pattern declared in manifest.json optional_host_permissions.
   */
  readonly optionalHostPattern?: string;
  /**
   * Group C: CSS selector for a consent / cookie interstitial that occludes content.
   * When matched, detectGateState() returns 'consent_wall'.
   * UNVERIFIED — replace with real selectors from live DOM captures.
   */
  readonly consentSelector?: string;
  /**
   * Group C: CSS selector for a paywall or registration gate.
   * When matched, detectGateState() returns 'paywall'.
   * UNVERIFIED — replace with real selectors from live DOM captures.
   */
  readonly paywallSelector?: string;
  /**
   * Group C CNBC-specific: true when the server delivers an empty JS shell.
   * waitForContent() handles this via its MutationObserver + settle timer; this flag
   * is informational for diagnostics.
   */
  readonly jsShellOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Site registry
// ---------------------------------------------------------------------------

// CSS selectors are BEST-GUESS / UNVERIFIED (no live DOM captures available).
// Replace each with real selectors after running the extension on the live page
// and inspecting outerHTML.

const PROFILES: readonly SiteProfile[] = [
  // ── Former Group A (now optional-permission) ─────────────────────────────────
  // Static pages readable at document_idle. Moved out of install-time host
  // permissions into optional_host_permissions so the install prompt stays
  // "sec.gov only". Reached on demand: a toolbar click (activeTab) injects in the
  // gesture, or the side panel requests optionalHostPattern for panel-driven runs.
  { group: 'C', label: 'Annual Reports', optionalHostPattern: 'https://*.annualreports.com/*' },
  { group: 'C', label: 'Stock Analysis', optionalHostPattern: 'https://*.stockanalysis.com/*' },
  { group: 'C', label: 'The Motley Fool', optionalHostPattern: 'https://*.fool.com/*' },
  { group: 'C', label: 'Benzinga', optionalHostPattern: 'https://*.benzinga.com/*' },

  // ── Former Group B (now optional-permission, still content-gated) ─────────────
  // Optional-permission like the rest, but keep the content selector so extraction
  // waits for real page content instead of parsing an interstitial.
  {
    group: 'C',
    label: 'SEC Report Viewer',
    optionalHostPattern: 'https://*.sec.report/*',
    // sec.report wraps filings in a viewer element. The Cloudflare interstitial
    // ("Redirecting…") has no article-class element, so extraction waits for it.
    // UNVERIFIED — inspect live outerHTML to confirm selector.
    contentSelector: 'article, .filing-document, .document-viewer, [class*="viewer-content"]',
  },
  {
    group: 'C',
    label: 'Finviz',
    optionalHostPattern: 'https://finviz.com/*',
    // Finviz is static HTML. Anti-bot applies only to server-side fetches; the
    // in-browser content script sees the real page. Selector acts as a sanity
    // gate in case a rate-limit placeholder is served.
    // UNVERIFIED — inspect live outerHTML to confirm selector.
    contentSelector: '#content, #fv-cont, .fv-container',
  },

  // ── Group C ─────────────────────────────────────────────────────────────────
  // optional_host_permissions — granted on demand, not at install.
  // Consent selectors and paywall selectors are UNVERIFIED best-guesses.
  {
    group: 'C',
    label: 'Yahoo Finance',
    optionalHostPattern: '*://finance.yahoo.com/*',
    // GUCE / EU consent interstitial.
    consentSelector: '#consent-page, [data-testid="consent-page"], .consent-overlay, #guce-consent',
  },
  {
    group: 'C',
    label: 'Macrotrends',
    optionalHostPattern: '*://*.macrotrends.net/*',
    // Email registration modal after a few free views.
    paywallSelector: '.bwal-modal, .modal[class*="register"], .signup-wall, [class*="bwal"]',
  },
  {
    group: 'C',
    label: 'BAM SEC',
    optionalHostPattern: '*://*.bamsec.com/*',
    // Login-centric; document viewer is account-gated; index is open.
    paywallSelector: '.login-required, [class*="login-wall"], [class*="auth-gate"]',
  },
  {
    group: 'C',
    label: 'CNBC',
    optionalHostPattern: '*://*.cnbc.com/*',
    // OneTrust consent banner (injected at runtime — confirm against a live capture).
    // NOTE: server-rendered, NOT a JS shell — a 2026-06 server fetch of a /quotes/
    // page returned ~252k chars of content (QuotePageBuilder / QuoteStrip present),
    // so waitForContent resolves on the initial DOM.
    consentSelector: '#onetrust-banner-sdk, .onetrust-pc-dark-filter',
    jsShellOnly: false,
  },
  {
    group: 'C',
    label: 'Reuters',
    optionalHostPattern: '*://*.reuters.com/*',
    // EU consent wall + Piano metered paywall on article bodies.
    consentSelector: '[data-testid="ConsentBanner"], .tp-modal[class*="consent"]',
    paywallSelector: '[data-testid="Paywall"], .tp-backdrop, .tp-modal:not([class*="consent"])',
  },
] as const;

// ---------------------------------------------------------------------------
// Hostname → profile lookup
// ---------------------------------------------------------------------------

/** Map of every recognised hostname (including www. variant) → SiteProfile. */
const HOST_MAP = new Map<string, SiteProfile>([
  // Group A
  ['annualreports.com',     PROFILES[0]!],
  ['www.annualreports.com', PROFILES[0]!],
  ['stockanalysis.com',     PROFILES[1]!],
  ['www.stockanalysis.com', PROFILES[1]!],
  ['fool.com',              PROFILES[2]!],
  ['www.fool.com',          PROFILES[2]!],
  ['benzinga.com',          PROFILES[3]!],
  ['www.benzinga.com',      PROFILES[3]!],
  // Group B
  ['sec.report',            PROFILES[4]!],
  ['www.sec.report',        PROFILES[4]!],
  ['finviz.com',            PROFILES[5]!],
  ['www.finviz.com',        PROFILES[5]!],
  // Group C
  ['finance.yahoo.com',     PROFILES[6]!],
  ['macrotrends.net',       PROFILES[7]!],
  ['www.macrotrends.net',   PROFILES[7]!],
  ['bamsec.com',            PROFILES[8]!],
  ['www.bamsec.com',        PROFILES[8]!],
  ['efts.bamsec.com',       PROFILES[8]!],
  ['cnbc.com',              PROFILES[9]!],
  ['www.cnbc.com',          PROFILES[9]!],
  ['reuters.com',           PROFILES[10]!],
  ['www.reuters.com',       PROFILES[10]!],
]);

/** Look up the site profile for a URL, or undefined for unregistered sites. */
export function getSiteProfile(url: string): SiteProfile | undefined {
  try {
    return HOST_MAP.get(new URL(url).hostname.toLowerCase());
  } catch {
    return undefined;
  }
}

/** True when the URL maps to a group-C (optional-permission) site. */
export function isGroupCSite(url: string): boolean {
  return getSiteProfile(url)?.group === 'C';
}

// ---------------------------------------------------------------------------
// Gate detection
// ---------------------------------------------------------------------------

/**
 * Inspect the live DOM for a consent banner or paywall gate on a group-C page.
 *
 * Returns 'open' when the page appears accessible.
 * Returns 'consent_wall' when a consent/cookie interstitial is found.
 * Returns 'paywall' when a paywall or registration gate is found.
 *
 * NOTE: Selectors are UNVERIFIED. A false-negative (gate present but selector
 * doesn't match) returns 'open' and falls through to normal extraction, which
 * will produce low-quality results — acceptable until real selectors are sourced.
 * A false-positive would incorrectly bail on an accessible page — also low-risk
 * since the user can retry after dismissing the banner.
 *
 * Do NOT use this to auto-click or dismiss banners. Detect only.
 */
export function detectGateState(profile: SiteProfile, doc: Document): GateState {
  if (profile.consentSelector && doc.querySelector(profile.consentSelector) !== null) {
    return 'consent_wall';
  }
  if (profile.paywallSelector && doc.querySelector(profile.paywallSelector) !== null) {
    return 'paywall';
  }
  return 'open';
}
