# Chrome Web Store — Store Listing copy

Everything for the dashboard's **Store listing** tab. The Privacy practices tab
(single purpose, permission justifications, data-use certs) lives in
[CWS_SUBMISSION.md](CWS_SUBMISSION.md).

The dashboard renders the detailed description as **plain text** (line breaks are
kept; there is no Markdown/HTML). The copy below is written to read well as-is.

---

## Product name

```
Relic — On-device SEC filing analysis
```

(The manifest name is "Relic". The store product name may be longer/descriptive;
use the above, or just "Relic" if you prefer the clean brand.)

## Summary (short description — 132 char max)

```
On-device AI for SEC filings: summaries, sentiment, language flags, and year-over-year redlines. Nothing leaves your browser.
```

(125 characters.)

## Category

**Productivity**

## Language

**English (United States)**

---

## Detailed description

```
Relic turns dense SEC filings into something you can actually read. Open any
10-K, 10-Q, 8-K, or other filing on SEC EDGAR and Relic activates in a side
panel — with summaries, sentiment, language flags, and a year-over-year redline.

Everything runs on your own device. Your filing text and Relic's analysis never
leave your browser.


WHAT YOU GET

• Analyst — An investor-focused read of the document: an overall snapshot
  (Bullish / Bearish / Mixed / Neutral) with 1–5 scores, the top takeaways, what
  changed versus the prior filing, revenue / margin / cash-flow / share-count
  impact, risk signals, a management-narrative check, a bull-vs-bear case, and a
  watch list. Every point is generated on-device and checked against the source
  text so claims stay grounded in the filing.

• Summary — Plain-English section-by-section summaries, with analyst-style notes
  when Chrome's built-in AI is available on your device.

• Sentiment — Sentence-level financial tone scoring (FinBERT), broken down into
  positive / negative / neutral for each section.

• Redline — A year-over-year comparison against the prior comparable filing, so
  you can see exactly what language was added, cut, or rewritten in the risk
  factors, MD&A, and more.

• On-page language flags — Hedging, uncertainty, litigious, and negative wording
  are underlined directly on the filing page as you read.

Plus a section navigator, jump-to-source highlighting that takes you straight to
the sentence behind any insight, and a first-run walkthrough.


PRIVATE BY DESIGN

• No accounts, no sign-in, no telemetry, no analytics.
• The AI models are bundled inside the extension and run locally — they are never
  downloaded from or contacted at any third-party server.
• The only network request Relic makes is to SEC.gov, and only when you request a
  Redline — to fetch last year's public filing to compare against. You can turn
  even that off in Settings.
• A Content Security Policy blocks every other network connection at the browser
  level, so your data cannot be sent anywhere, even in principle.


HOW TO USE IT

1. Pin Relic and open any filing on https://www.sec.gov/edgar.
2. Click the Relic toolbar icon to open the side panel.
3. Browse the Analyst, Summary, Sentiment, and Redline tabs.

You can also click "Analyze this page" on other financial documents; Relic asks
for permission for that specific site first, and only then.


GOOD TO KNOW

• Some devices with Chrome's built-in AI (Gemini Nano) get richer natural-language
  summaries and notes; on other devices Relic uses a fast on-device extractive
  method instead. Everything else — sentiment, flags, and redlines — is identical.
• Relic summarizes and analyzes filings for informational and research purposes
  only. It is not investment advice and does not tell you to buy, sell, or hold.
```

---

## Screenshots (you must capture these — 1280×800 PNG, up to 5)

Capture each against a real, well-known filing (e.g. a recent Apple or Microsoft
10-K on EDGAR) so reviewers immediately recognize the context. Suggested caption
text to overlay on each tile:

1. **Analyst tab** — the snapshot read (Bullish/Bearish + 1–5 scores) with top
   takeaways visible.
   Caption: "An investor-focused read — grounded in the filing's own text."

2. **Redline tab** — the year-over-year diff showing added/removed risk-factor
   language.
   Caption: "See exactly what changed since last year's filing."

3. **Sentiment tab** — the positive/negative/neutral breakdown per section.
   Caption: "Sentence-level financial tone, section by section."

4. **On-page flags** — the EDGAR filing page with hedging/uncertainty wording
   underlined, side panel alongside.
   Caption: "Hedging and risk language, underlined as you read."

5. **Summary tab** (or first-run onboarding) — plain-English section summaries.
   Caption: "Plain-English summaries of every section — 100% on your device."

Tip: a consistent background color and caption band across all five looks far
more credible than raw screenshots.

## Promo images (optional in the new dashboard, but help discovery)

- **Small promo tile — 440×280 PNG.** Relic logo + tagline:
  "On-device SEC filing analysis."
- **Marquee promo tile — 1400×560 PNG.** Only needed if you want to be eligible
  for featuring. Same tagline, wider composition.

---

## Distribution settings

- **Visibility:** Public
- **Pricing:** Free
- **Regions:** All regions
- **Mature content:** No

---

## Fields recap (where each piece goes)

| Dashboard field | Source |
|---|---|
| Product name | this file |
| Summary (132 char) | this file |
| Detailed description | this file |
| Category / Language | this file |
| Screenshots / promo tiles | capture per the plan above |
| Store icon (128×128) | `public/icons/icon128.png` (already in build) |
| Single purpose | [CWS_SUBMISSION.md](CWS_SUBMISSION.md) |
| Permission justifications | [CWS_SUBMISSION.md](CWS_SUBMISSION.md) |
| Data-use certifications | [CWS_SUBMISSION.md](CWS_SUBMISSION.md) |
| Privacy policy URL | host [PRIVACY.md](PRIVACY.md) publicly, then paste URL |
