# Relic Privacy Policy

_Last updated: 2026-07-01_

Relic is a Chrome extension that analyzes SEC/EDGAR filings and other investor
documents entirely on your own device. This policy describes exactly what Relic
does and does not do with your data. It is intentionally short because Relic
collects nothing.

## The short version

**Relic does not collect, store, transmit, sell, or share any personal data.**
All analysis runs locally in your browser. There is no account, no sign-in, no
telemetry, and no analytics.

## What Relic processes, and where

When you open a filing (or click **Analyze this page**), Relic reads the text of
the page you are viewing and runs its analysis — summaries, sentiment, language
flags, fundamentals, and analyst notes — **on your device**, using AI models that
are bundled inside the extension. The filing text, and everything Relic derives
from it, never leaves your machine.

- **On-device AI models.** Relic ships its models (FinBERT for sentiment and a
  small sentence-embedding model) inside the extension package. They are loaded
  locally and are never downloaded from, or contacted at, any third-party server
  at runtime.
- **Chrome built-in AI (optional).** On devices where Chrome provides built-in AI
  (Gemini Nano), Relic uses it for natural-language summaries and analyst notes.
  This runs locally and is downloaded and managed by Chrome itself, not by Relic.

## The only network requests Relic makes

Relic's sole network egress is to **SEC.gov (`*.sec.gov`)**, and only when you ask
for a year-over-year **Redline** comparison. In that case Relic fetches the prior
year's public filing from SEC.gov so it can diff it against the one you're reading.

- This request contains no personal data — it is a normal public request for a
  public SEC document.
- You can turn it off entirely in **Settings → "Fetch prior-year filings from
  SEC.gov."** With it off, Relic makes no network requests at all.

Relic's Content Security Policy blocks all other network connections at the
browser level (`connect-src 'self' https://*.sec.gov`), so the extension cannot
send your data anywhere even in principle.

## Local storage

Relic stores its analysis caches (summaries, sentiment, fundamentals, redlines)
and your preferences locally in your browser, so re-opening a filing is instant.
This data stays on your device and is never transmitted. You can clear it any time
from **Settings → Cached analyses → Clear.**

## Permissions

- **`https://*.sec.gov/*`** — read filings on SEC EDGAR and fetch prior-year
  filings for the Redline comparison.
- **`activeTab` + `scripting`** — analyze the page you're on when you click the
  toolbar icon or **Analyze this page**. No standing access to other sites.
- **Optional site permissions** — granted only if you explicitly allow Relic to
  analyze a specific non-SEC financial site.
- **`storage`, `sidePanel`, `offscreen`** — local caching, the side-panel UI, and
  running the on-device models.

## Data use certifications

Relic does not sell or transfer user data, does not use or transfer data for
purposes unrelated to the extension's single purpose (analyzing financial
disclosure documents), and does not use or transfer data to determine
creditworthiness or for lending purposes.

## Not investment advice

Relic summarizes and analyzes filings for informational and research purposes
only. It does not provide investment advice.

## Changes to this policy

If this policy changes, the "Last updated" date above will change and the revised
policy will ship with the corresponding extension version.

## Contact

Questions about this policy: **raaghav.ramji@gmail.com**
