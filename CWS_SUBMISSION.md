# Chrome Web Store submission sheet

Copy-paste-ready text for the Web Store developer dashboard. Keep this in sync
with `manifest.json` — if a permission is added or removed, update it here too.

---

## Single purpose

> Relic analyzes SEC/EDGAR filings and comparable investor documents entirely
> on the user's device, presenting plain-English summaries, sentence-level
> sentiment, language flags, fundamentals, and year-over-year redlines in a
> side panel next to the document being read.

## Category

**Productivity** (best fit; there is no "Finance" category). "Tools" or
"Workflow & Planning" are acceptable alternatives.

---

## Permission justifications

Paste each into the matching field in the dashboard's **Privacy practices** tab.

**`storage`**
> Caches on-device analysis results (summaries, sentiment scores, fundamentals,
> redlines) and the user's settings locally so re-opening a filing is instant.
> Nothing stored is ever transmitted.

**`sidePanel`**
> The extension's entire UI — the Analyst, Summary, Sentiment, and Redline tabs
> — is a side panel shown next to the filing the user is reading.

**`activeTab`**
> When the user clicks the toolbar icon on a financial page, activeTab grants
> temporary access to that one tab so the content script can read the visible
> document text for analysis. Access is limited to the tab the user acted on and
> ends when they navigate away.

**`scripting`**
> Injects the content script into the active tab (authorized by the activeTab
> grant from the toolbar click) to extract the document text and render on-page
> language-flag highlights. Used only on the page the user chose to analyze.

**`offscreen`**
> Hosts the ONNX Runtime Web Workers that run on-device inference (FinBERT
> sentiment + sentence embeddings). An offscreen document is required because
> these workers need a DOM-capable context that the MV3 service worker lacks.

**Host permission — `https://*.sec.gov/*`**
> SEC EDGAR is the primary source of the filings Relic analyzes. The content
> script auto-runs on sec.gov filing pages, and the extension's only network
> request is to sec.gov, to fetch the prior-year filing for the user-initiated
> Redline comparison (toggle-able off in Settings).

**Optional host permissions** (annualreports.com, stockanalysis.com, finviz.com,
finance.yahoo.com, macrotrends.net, bamsec.com, cnbc.com, reuters.com, fool.com,
benzinga.com, sec.report)
> Declared as optional and never granted at install. Relic requests one of these
> via `chrome.permissions.request()` only when the user explicitly chooses to
> analyze that specific non-SEC financial site; the grant lets the content script
> read that page's document text for the same on-device analysis.

**Remote code use — answer: No.**
> All executable code and ML model weights are bundled in the package. The CSP
> forbids remote script (`script-src 'self' 'wasm-unsafe-eval'`) and restricts
> network egress to sec.gov (`connect-src 'self' https://*.sec.gov`).
> `'wasm-unsafe-eval'` is required only to instantiate the bundled ONNX Runtime
> WebAssembly — no code is fetched or evaluated from any remote source.

---

## Data-use certifications (all apply)

- Does **not** collect or transmit user data — all analysis runs locally; the
  only egress is a public document fetch from sec.gov.
- Does **not** sell or transfer user data to third parties.
- Does **not** use or transfer data for purposes unrelated to the single purpose.
- Does **not** use or transfer data to determine creditworthiness / for lending.

## Privacy policy URL

Host [`PRIVACY.md`](PRIVACY.md) at a public URL and paste it here. The dashboard
will not accept a file inside the package.

---

## Pre-submit checklist

- [ ] `npm run build` passes (`verify-dist` prints "looks shippable")
- [ ] Zip **the contents of `dist/`** (not the folder itself) for upload
- [ ] Privacy policy hosted publicly; URL added to the listing
- [ ] At least one screenshot (1280×800 or 640×400) uploaded
- [ ] Permission justifications above pasted into the dashboard
- [ ] Data-use certifications checked
- [ ] Manual smoke test done (side panel opens, analyze a 10-K, run a Redline)
