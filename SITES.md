# Relic — Site Support & Functionality Reference

> Source-of-truth notes on **which pages Relic works on** and **how much
> functionality** each gets. Derived from the codebase, not marketing copy.
> Primary sources: [`manifest.json`](manifest.json),
> [`src/background/inject.ts`](src/background/inject.ts),
> [`src/content/ingest/siteProfiles.ts`](src/content/ingest/siteProfiles.ts),
> [`src/content/ingest/classify.ts`](src/content/ingest/classify.ts),
> [`src/sidepanel/App.tsx`](src/sidepanel/App.tsx).

---

## TL;DR

- **Best experience:** SEC EDGAR filings on `sec.gov` — auto-runs, full features,
  and the **only** place the year-over-year redline ("Redline") works.
- **Good when the page parses as a real filing:** annualreports.com,
  stockanalysis.com, fool.com, benzinga.com, sec.report, finviz.com.
- **On-demand (one-time permission grant):** Yahoo Finance, Macrotrends, BAM SEC,
  CNBC, Reuters — often blocked by consent banners / paywalls.
- **Any other site:** click the toolbar icon to analyze; usually Summary +
  language flags only.
- **Not supported:** PDFs, the Chrome Web Store, and browser pages
  (`chrome://`, `file://`, `about:`).

---

## How it actually works: two independent axes

"What works and how well" is decided by **two separate systems**, not one list.

### Axis A — Can the extension reach the page? (permission + injection)
Decided by **hostname only** (static, hard-coded in the manifest + `inject.ts`).
This controls *how the analysis script gets onto the page*.

### Axis B — How much functionality does it show? (which tabs/features)
Decided by **the page's content + URL path** (dynamic, per-page in
`classify.ts` + `App.tsx`). This controls *which of the four tabs appear*.

> A site's "group" only controls Axis A. The **feature level is decided
> per-page by content**, which is why a supported host can still show
> "Summary only" if the page isn't actually a filing.

---

## Axis A — The 5 host tiers (reachability)

| Tier | Hosts | Permission | Auto-runs? | Notes |
|------|-------|-----------|-----------|-------|
| **1. SEC EDGAR** | `*.sec.gov` (HTTPS) | Granted at install | ✅ Yes, all frames | Reaches the inline-XBRL viewer iframe. The flagship surface. |
| **2. Group A** | annualreports.com, stockanalysis.com, fool.com, benzinga.com | Granted at install | ✅ Yes, top frame | Assumes static HTML present on load. |
| **3. Group B** | sec.report, finviz.com | Granted at install | ✅ Yes, but **content-gated** | Waits for a content selector first, to avoid parsing a "Redirecting…" / anti-bot page. |
| **4. Group C** | finance.yahoo.com, macrotrends.net, bamsec.com, cnbc.com, reuters.com | **On-demand grant** (user clicks "Allow access") | ❌ No | Also detects consent walls / paywalls and bails (never auto-dismisses them). |
| **5. Everything else** | any other `http(s)` site | `activeTab` (toolbar click) | ❌ Manual only | Injected in the click gesture. |

**Hard exclusions (cannot analyze at all):** the Chrome Web Store
(`chromewebstore.google.com`), non-web pages (`chrome://`, `file://`,
`about:`), unparseable URLs, and **local PDFs**.

---

## Axis B — Functionality level (the page categories)

Every reachable page is classified into a category, which decides the tabs.
The four tabs are **Analyst · Summary · Sentiment · Redline**. The investor
tabs (Analyst, Sentiment, Redline) are hidden — and not even loaded — on
non-filing pages.

| Page type | How it's detected | Features shown |
|-----------|------------------|----------------|
| **EDGAR filing** | `/Archives/edgar/data/` path or XBRL `dei:*` facts | **Full** (all 4 tabs + YoY redline) |
| **Inline-XBRL viewer** | `ix:` / `contextref` markup | **Full** (all 4 tabs) |
| **EDGAR filing index** | URL ends in `-index.htm(l)` | Summary only — banner points to the primary document |
| **EDGAR search / browse** | full-text search, browse-edgar, company profile | Summary only |
| **SEC data/report page** | any other `sec.gov` page (rules, research, news) | Summary only — labeled "not a company filing" |
| **Off-SEC financial page** | any non-`sec.gov` host | **Conditional** — see below |
| **Unsupported** | non-web scheme, Web Store, unparseable | Cannot ingest |

### The content sub-gate (applies to ALL non-SEC sites)
Every off-SEC page (Groups A, B, C, and "everything else") starts as a generic
financial page. It only unlocks the **full** investor features if it **parses as
a real filing**:

- ✅ **Full features** — a recognized form (10-K, 10-Q, 8-K, 20-F, S-1, DEF 14A)
  was detected **and** the document split into multiple sections.
- 🔸 **Demoted to Summary + flags** — the type is unknown, OR a form name was only
  *mentioned* (e.g. a press release referencing "Form 10-K") and the page didn't
  segment into sections, OR section boundaries looked unreliable.
- 🔸 **EDGAR exhibits** (EX-21, EX-23, certifications) also drop to Summary-only.

When demoted, language-flag underlines are off by default but can be turned on manually in Settings or via **show them anyway** in the side panel.

---

## The four features (what "Full" means)

| Tab | What it does | Engine (all on-device) | Extra gating |
|-----|--------------|------------------------|--------------|
| **Summary** | Plain-English key points per section | Chrome Summarizer API → extractive fallback | Works on any readable page |
| **Analyst** | Investment thesis: takeaways, bull/bear, scores, narrative check | Chrome Prompt API → deterministic fallback | Needs a filing-like page |
| **Sentiment** | Sentence-level positive/negative/neutral scores in the side panel | FinBERT (on-device) | Needs a filing-like page |
| **Redline (YoY)** | Diff vs. last year's comparable filing | EDGAR fetch + on-device diff | **EDGAR-only** + form-gated |

### Two limits on "Redline" worth calling out
1. **Effectively EDGAR-only.** The redline needs a company CIK to find the prior
   filing, and the CIK only comes from EDGAR. On other sites the Redline tab may
   appear but can't complete.
2. **Form-gated even on EDGAR.** Only 10-K, 10-Q, 20-F, S-1, DEF 14A, and 8-K are
   supported. Other forms (6-K, Form 3/4, unknown) show "not available yet."

### Device-capability tier (independent of the site)
- **Built-in AI available** → natural-language summaries and analysis.
- **No built-in AI** → Summary uses extracted sentences; Analyst runs in a
  reduced "deterministic-only" mode. Sentiment and language flags work either way.

---

## Per-group quick reference

| Group | Sites | Permission | Auto-run | Realistic ceiling |
|-------|-------|-----------|----------|-------------------|
| **SEC filings** | `*.sec.gov` filing pages | Install | ✅ | **Full + YoY redline** (only place redline works) |
| **SEC non-filing** | search, data, rules, index, exhibits | Install | ✅ | **Summary + flags only** |
| **Group A** | annualreports, stockanalysis, fool, benzinga | Install | ✅ | Full **only if the page parses as a filing**, else Summary+flags. No redline. |
| **Group B** | sec.report, finviz | Install | ✅ (content-gated) | Same content rule as A; reliability caveat from interstitials |
| **Group C** | yahoo finance, macrotrends, bamsec, cnbc, reuters | On-demand grant | ❌ | Same content rule as A; often blocked by consent/paywall |
| **Everything else** | any other site | `activeTab` (toolbar click) | ❌ manual | Usually Summary + flags |

---

## Known caveats & limitations

1. **Consent walls / paywalls (Group C)** are detected, not bypassed. Relic
   asks you to dismiss the banner and retry; it never auto-clicks.
2. **Site detection selectors are mostly unverified best-guesses.** The CSS
   selectors used to detect real content, consent banners, and paywalls on
   Groups B & C have not all been confirmed against live pages — so reliability
   on those sites is not guaranteed.
3. **`www.finviz.com` may not auto-run.** Auto-injection is configured for the
   apex `finviz.com` only; the `www.` subdomain falls back to the manual
   toolbar-click path.
4. **PDFs are unsupported.** This includes local PDFs and PDF-hosted annual
   reports (relevant for annualreports.com).
5. **BAM SEC** document viewer is account-gated; only the open index pages parse.
6. **Privacy:** the only network request the extension makes is the EDGAR fetch
   for the redline. All other analysis runs entirely on-device.

---

*This document reflects the codebase as of Relic v1.2.7. It is reference
material, not user-facing copy — adapt wording before shipping it in-product.*
