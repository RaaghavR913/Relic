# FilingLens — Session 7 Manual Test Script

Covers the unified side panel: first-run → first analyzed filing → all tabs → **Ask**
in **both** generation tiers (`builtin` synthesized answers vs `extractive` relevant
passages).

## 0. Build & load

```bash
npm install
npm run build          # outputs dist/
npm test               # 144 tests should pass
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Pin **FilingLens**. Click the toolbar icon to open the side panel.

### Resetting between runs
The first-run screen and overlay prefs persist in `chrome.storage.local`. To replay
onboarding, open the side panel's service-worker/devtools console and run:
```js
chrome.storage.local.remove([
  'filinglens:onboarded',
  'filinglens:sentimentEnabled',
  'filinglens:flagsEnabled',
]);
```
Then reopen the panel.

---

## 1. First-run (new user)

**Open the panel with no filing tab focused, after clearing `filinglens:onboarded`.**

- [ ] A **Welcome to FilingLens** screen appears (not the tabs).
- [ ] **Private by design** lists the on-device guarantees.
- [ ] **What downloads to your device** lists exactly two encoder models —
      `mxbai-embed-xsmall` and `FinBERT` — with sizes. **Gemini Nano is NOT listed
      as something FilingLens downloads.**
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
      `[FilingLens] ingested …`).
- [ ] In the side panel **header**: company name, ticker (if any), a **filing-type
      chip**, **Period**, and section count appear.
- [ ] **Sections** navigator lists the filing's sections; clicking one scrolls the
      page to that section and briefly flashes it.
- [ ] **Overlays** strip shows **Heatmap** (off) and **Flags** (on) switches and a
      **Legend** disclosure with non-colour cues (underline styles + markers).

### Tabs
- [ ] **Summary** — click *Summarize* on a section.
  - builtin tier → markdown key-points + a **Plain / Analyst** toggle (Analyst enabled).
  - extractive tier → key sentences as bullets, each with a ↗ jump link; the
    *Analyst* toggle is disabled with a tooltip, and an amber degradation banner shows.
- [ ] **Sentiment** — click *Analyze Sentiment*.
  - FinBERT model-load progress bar, then per-section progress.
  - Document-level + per-section sentiment bars populate.
  - With **Heatmap** overlay on, sentence underlines appear **on the page**,
    progressively, without freezing scroll.
- [ ] **Flags** — tab shows a count badge. Per-section flag chips; clicking a chip
      jumps to the first occurrence on the page. Hovering a flagged phrase on the
      page shows a tooltip.
- [ ] **Changes** — click *Compare to prior year*. Resolves the prior filing from
      EDGAR (watch progress: resolving → fetching → parsing → aligning → diffing),
      then shows per-section diffs with magnitude bars and +/− passages.
      *Show on page* highlights additions. (builtin upgrades the templated summary
      to natural language.)

### Overlay master toggles
- [ ] Turn **Heatmap** off → page underlines disappear; turn on → they return
      **without re-running analysis**.
- [ ] Turn **Flags** off → page flag underlines + tooltip disappear; on → return.
- [ ] Reload the side panel → toggle states persist.

---

## 3. Ask — builtin tier (synthesized)

Use Chrome with built-in AI available (`Built-in AI` badge in the header).

1. Open the **Ask** tab.
2. Click a suggested question (e.g. *"What are the most significant risk factors?"*)
   or type your own and press **Ask**.

- [ ] First ask shows **Preparing on-device search index** progress (encoder load +
      embedding). Subsequent asks skip it (index cached).
- [ ] If Gemini Nano needs downloading, a **Chrome is downloading Gemini Nano**
      progress bar appears (Chrome-managed).
- [ ] An **Answer** card streams tokens live (blinking caret while generating).
- [ ] The answer contains inline **[1] [2]** citation chips; clicking one highlights
      and scrolls to that passage **in the filing**.
- [ ] **Sources** list shows the retrieved passages; cited ones are ring-highlighted,
      uncited ones dimmed. Each has a ↗ **Show** deep-link.
- [ ] **Stop** halts streaming mid-answer.
- [ ] A "verify against the source" disclaimer shows under a completed answer.

---

## 4. Ask — extractive tier (relevant passages)

Use a browser/profile **without** built-in AI (`Extractive` badge), **or** test on a
Chrome where `LanguageModel` is absent.

1. Open the **Ask** tab. A green **positive** banner explains passages-only mode.
2. Ask a question.

- [ ] Index-build progress shows on first ask.
- [ ] **No Answer card** is rendered (no synthesis).
- [ ] A **Relevant passages** list appears, clearly labelled, each numbered with a
      section label, snippet, and ↗ **Show** deep-link that highlights it in the filing.
- [ ] No Gemini Nano download bar appears.

---

## 5. Empty / degraded states

- [ ] Focus a non-filing tab and reopen the panel → **No filing open** empty state +
      an **On-device capabilities** card + privacy note.
- [ ] **Flags** tab with no detected flags → "No language flags" empty state.
- [ ] **Changes** with no prior comparable filing → neutral "No prior comparable…"
      message (not an error).
- [ ] Disable WebGPU (`chrome://flags` → WebGPU Disabled) → encoders still run via
      WASM fallback (slower but functional); capabilities card shows *WASM fallback*.

---

## 6. Accessibility & motion

- [ ] Tab bar: arrow keys move between tabs; focus ring visible; `aria-selected` and
      `role="tabpanel"` wiring correct (inspect).
- [ ] Every overlay distinguishes meaning by **shape**, not colour alone (sentiment
      solid vs wavy underline; four distinct flag underline styles).
- [ ] Enable OS **Reduce Motion** → progress bars/expanders settle without animation;
      skeletons stop pulsing.
- [ ] All text meets WCAG AA contrast on the zinc-950 background.

---

## 7. Privacy invariant (must hold in every tier)

Open DevTools **Network** for the page, the side panel, and the service worker while
exercising all tabs:

- [ ] The only requests are: (a) EDGAR document/submissions fetches, (b) one-time
      Hugging Face encoder-model downloads, (c) no analysis/filing-text POSTs anywhere.
- [ ] No request body contains filing text, questions, answers, or derived analysis.
