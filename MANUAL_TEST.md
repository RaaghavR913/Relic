# Relic — Session 7 Manual Test Script

Covers the unified side panel: first-run → first analyzed filing → all tabs
(Analyst · Summary · Sentiment · Redline) in **both** generation tiers (`builtin`
vs `extractive`).

## 0. Build & load

```bash
npm install
npm run build          # outputs dist/
npm test               # 512 tests should pass (7 skipped)
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Pin **Relic**. Click the toolbar icon to open the side panel.

### Resetting between runs
The first-run screen and overlay prefs persist in `chrome.storage.local`. To replay
onboarding, open the side panel's service-worker/devtools console and run:
```js
chrome.storage.local.remove([
  'relic:onboarded',
  'relic:flagsEnabled',
]);
```
Then reopen the panel.

---

## 1. First-run (new user)

**Open the panel with no filing tab focused, after clearing `relic:onboarded`.**

- [ ] A **Welcome to Relic** screen appears (not the tabs).
- [ ] **Private by design** lists the on-device guarantees.
- [ ] **What downloads to your device** lists exactly two encoder models —
      `mxbai-embed-xsmall` and `FinBERT` — with sizes. **Gemini Nano is NOT listed
      as something Relic downloads.**
- [ ] **Generation mode** shows a tier badge:
  - On Chrome with built-in AI → **Built-in AI** + a **Gemini Nano** status row
    (`Ready` / `Needs download` / `Downloading…`). If downloadable, the copy says
    *Chrome* manages that download on first question.
  - On a browser without built-in AI → **Extractive** with a **positive** green
    banner (graceful degradation framed as a feature, not an error).
- [ ] **Get started** dismisses onboarding; it does not reappear on reopen.

Accessibility: Tab through the screen — the CTA and any links are focus-visible;
contrast is legible on the dark surface.

---

## 2. First analyzed filing

Navigate a tab to a real EDGAR document, e.g. a recent **10-K** primary document:
`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&...` → open the filing's
HTML. (Any 10-K / 10-Q / 8-K / S-1 / DEF 14A primary doc works.)

- [ ] The content script ingests the filing (check the page console for
      `[Relic] ingested …`).
- [ ] In the side panel **header**: company name, ticker (if any), a **filing-type
      chip**, **Period**, and section count appear.
- [ ] **Sections** navigator lists the filing's sections; clicking one scrolls the
      page to that section and briefly flashes it.
- [ ] **Language flags** — flagged phrases (uncertainty, weak-modal, litigious,
      negative) are underlined on the filing page. Hovering a flagged phrase shows a
      tooltip with the flag type.

### Tabs
- [ ] **Analyst** (default tab) — analysis auto-starts on document load.
  - builtin tier → the stage indicator cycles (snapshot → takeaways → … → synthesis);
    the **Investor Snapshot** card lands first (overall read chip Bullish/Bearish/
    Mixed/Neutral, document type, confidence, key question), then sections stream in:
    takeaways, what changed, what-this-means (revenue / margins / cash flow & balance
    sheet / shares), risk signals, narrative check, bull vs bear, watch list,
    plain-English explanation, and 1–5 score bars in the snapshot.
  - Evidence quotes show a ↗ that highlights the quoted passage **on the page**.
  - No output anywhere says "buy", "sell", or "short", or predicts the stock price.
  - Re-opening the panel on the same filing replays the analysis instantly (cached);
    **Re-Analyze** re-runs it.
  - extractive tier → amber degraded banner; snapshot + what-changed only.
  - Sparse docs (e.g. a Form 4) → sections show "Not enough information", no errors.
- [ ] **Summary** — click *Summarize* on a section.
  - builtin tier → markdown key-points + a **Plain / Analyst** toggle (Analyst enabled).
  - extractive tier → key sentences as bullets, each with a ↗ jump link; the
    *Analyst* toggle is disabled with a tooltip, and an amber degradation banner shows.
- [ ] **Sentiment** — click *Analyze Sentiment*.
  - FinBERT model-load progress bar, then per-section progress.
  - Document-level + per-section sentiment bars populate in the side panel.
- [ ] **Redline** — click *Compare to prior year*. Resolves the prior filing from
      EDGAR (watch progress: resolving → fetching → parsing → aligning → diffing),
      then shows per-section diffs with magnitude bars and +/− passages.
      *Show on page* highlights additions. (builtin upgrades the templated summary
      to natural language.)

### On-page highlights (Settings)
- [ ] Settings → **On-page highlights** off → flag underlines + tooltip disappear; on → return.
- [ ] Reload the side panel → toggle state persists.

---

## 3. First run / stalled download & low-end WASM

Simulate a first-run machine: `chrome://on-device-internals` → **Model status** →
remove *Optimization Guide On Device Model* (or `chrome://components` → same entry),
so `LanguageModel.availability()` returns `downloadable`.

**News page (the "stuck at 69%" repro):**
- [ ] Open a Yahoo Finance article → **Analyze this page** → Summary tab.
- [ ] Summaries appear **immediately via the extractive path** — no 2 GB download
      starts, no percentage bar freezes. The amber banner reads *"Chrome's built-in
      AI isn't downloaded yet — showing key sentences instead."*
- [ ] On a long portal page the summary card shows *"Summarized from the first part
      of the page."* (24k-char cap; SEC filings are never capped).

**Stalled download (dev build):**
- [ ] DevSettings → force **builtin**, disconnect the network → trigger a summary.
      The bar is labeled **"Downloading Chrome built-in AI (one-time, ~2 GB)…"**
      and after ≤ 45 s without progress the panel falls back to key sentences —
      it never freezes mid-percent.
- [ ] Result is cached as **extractive** (re-open → key sentences, no analyst
      badge); once Nano is actually installed, a fresh doc produces analyst notes.

**Model-load progress (WASM):**
- [ ] Sentiment on a filing → *Loading FinBERT…* shows a **real** percentage that
      climbs smoothly (bytes vs. bundled size), not an instant 100%.

**Hang regression:**
- [ ] In the offscreen console, call `terminateWorkers()` mid-summarize → the
      Summary section shows an **Error** chip (not a frozen bar); the next
      summarize rebuilds the worker and succeeds.
- [ ] A long sentiment pass (large 10-K, CPU-throttled) survives past 5 minutes —
      the idle unload no longer fires mid-pass.

**Low-memory profile:**
- [ ] Temporarily hardcode `DEVICE_MEMORY_GB = 4` in `src/offscreen/offscreen.ts`
      (dev build) → the offscreen console logs `EMBED 16×1, CLASSIFY 4×1` and
      2 ORT threads; restore afterwards. With ≥ 8 GB, a second sentiment run
      within 90 s reuses the warm FinBERT worker (no reload).

---

## 5. Empty / degraded states

- [ ] Focus a non-filing tab and reopen the panel → **No filing open** empty state +
      an **On-device capabilities** card + privacy note.
- [ ] **Redline** with no prior comparable filing → neutral "No prior comparable…"
      message (not an error).
- [ ] Disable WebGPU (`chrome://flags` → WebGPU Disabled) → encoders still run via
      WASM fallback (slower but functional); capabilities card **WebGPU adapter**
      shows *Unavailable*. Offscreen console shows a preflight `reason=` (e.g.
      `no_gpu` / `no_adapter`) and `preferred=wasm` **without** a long WebGPU INIT
      attempt. After a WASM fallback (or preferWasm lock), idle-unload + recreate
      of the offscreen doc still prefers WASM for that browser session.
- [ ] **Device tier:** machines with `navigator.deviceMemory ≤ 4` skip WebGPU even
      when an adapter exists — offscreen logs `low-end tier … preferred=wasm (skip WebGPU)`
      and uses the 20s INIT budget. Higher-RAM machines probe WebGPU, prefer it when
      `device=true`, and use a 60s INIT budget before falling back to WASM.

---

## 5b. WebGPU path (acceleration)

- [ ] With WebGPU enabled, open capabilities card → **WebGPU adapter: Available**.
- [ ] Run Summary (extractive) and/or Sentiment; offscreen console shows
      `encoder ready on webgpu` / `FinBERT ready on webgpu` and a preflight line with
      `device=true`; optional `yielding encoder WebGPU to FinBERT` when both would
      share the GPU.
- [ ] After sentiment completes, Summary/Redline still work (encoder rebuilds lazily).
- [ ] `node scripts/smoke-webgpu.mjs` after `npm run build` exits 0 (or skips runtime
      cleanly if Chrome is missing; static jsep assets must still pass).

---

## 6. Accessibility & motion

- [ ] Tab bar: arrow keys move between tabs; focus ring visible; `aria-selected` and
      `role="tabpanel"` wiring correct (inspect).
- [ ] Flag underlines distinguish meaning by **shape**, not colour alone (four
      distinct underline styles: dashed, dotted, double, wavy).
- [ ] Enable OS **Reduce Motion** → progress bars/expanders settle without animation;
      skeletons stop pulsing.
- [ ] All text meets WCAG AA contrast on the zinc-950 background.

---

## 7. Privacy invariant (must hold in every tier)

Open DevTools **Network** for the page, the side panel, and the service worker while
exercising all tabs:

- [ ] The only requests are: (a) EDGAR document/submissions fetches when Redline
      (or “Fetch last year’s filing”) is used, (b) no Hugging Face / model-host
      requests (weights are bundled), (c) no analysis/filing-text POSTs anywhere.
- [ ] No request body contains filing text, questions, answers, or derived analysis.

---

## 8. On-demand "Analyze this page" (non-EDGAR)

> EDGAR keeps auto-analyzing via manifest content scripts. Everything else is
> user-invoked: the toolbar click grants `activeTab`, and the panel button asks the
> service worker to inject the same content script via `chrome.scripting`.

- [ ] **EDGAR regression:** open a 10-K on sec.gov → ingestion, flags, and the panel
      work exactly as before (no behavior change on `*.sec.gov`).
- [ ] **IR press release:** open a company IR news page (e.g. an
      `investor.{company}.com` press release) → click the toolbar icon → panel shows
      **No filing open** with an **Analyze this page** button → click it →
      panel renders results with a ⚠ "doesn't look like an SEC filing" banner;
      flag underlines are NOT painted on the page.
- [ ] **Opt-in flags:** click **show them anyway** in the banner → flag underlines
      appear on the page; Settings → On-page highlights reflects the state.
- [ ] **IR-hosted real filing:** open an HTML 10-K/10-Q hosted off-EDGAR → analyze →
      type is detected from text, NO warning banner, sections segment normally;
      **Redline** reports no prior filing (no CIK) rather than erroring.
- [ ] **Unsupported page:** open `chrome://version`, open the panel, click
      **Analyze this page** → friendly "can't be analyzed" message, no crash.
- [ ] **Double injection:** click **Analyze this page** twice on the same page →
      exactly one `[Relic] ingested …` log in the page console; no duplicate
      highlights or listeners.
- [ ] **Privacy invariant:** DevTools Network on an analyzed IR page shows NO new
      outbound requests from the extension (ingestion is DOM-only).
