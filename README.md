# Relic

On-device SEC filing analysis for Chrome. Relic runs entirely on your machine — summaries, sentiment, language flags, and year-over-year redlines never leave your device.

Open any filing on [EDGAR](https://www.sec.gov/edgar) and Relic activates in the side panel with overlays painted directly on the filing page.

## Features

| Tab | What it does |
|-----|--------------|
| **Analyst** | Investor-focused document analysis: snapshot read (Bullish/Bearish/Mixed/Neutral) with 1–5 scores, top takeaways, what changed vs the prior filing, revenue/margin/cash-flow/share impact, risk signals, management narrative check, bull vs bear case, and a watch list — generated stage-by-stage on-device with evidence verified against the source text |
| **Summary** | Plain-English section summaries, with analyst-style notes when Chrome's built-in AI is available |
| **Sentiment** | Sentence-level FinBERT sentiment heatmap overlaid on the filing |
| **Flags** | Highlights hedging, uncertainty, litigious, and negative language via a curated financial-language lexicon |
| **Changes** | Year-over-year redline for comparable prior filings (risk factors, MD&A, and more) |

Additional UI: section navigator, master overlay toggles, first-run onboarding, and jump-to-source highlighting for every insight.

## Privacy

Relic is built around a zero-egress guarantee:

- **No telemetry, no cloud APIs** — analysis runs locally in the extension.
- **No runtime model downloads** — ONNX weights ship inside the build; workers set `allowRemoteModels = false`.
- **Only `*.sec.gov` network access** — used to fetch prior-year filings for redline comparison, routed through a rate-limited queue (≤8 req/s, exponential backoff, 30-minute cache).

Your filing text and derived analysis never leave the device.

## Chrome Web Store submission notes

Permission rationale, for reviewers:

- **`host_permissions: https://*.sec.gov/*`** — the only host the extension fetches from
  (prior-year filings for redline). The content script also auto-runs here.
- **`activeTab` + `scripting`** — power the on-demand "Analyze this page" action: a toolbar
  click grants `activeTab` on the current page, and the content script is injected into it.
  No broad host permission is requested for non-SEC pages; analysis is opt-in per page.
- **`offscreen`** — runs the ONNX Web Workers (DOM-less inference) off the service worker.
- **`storage` / `sidePanel`** — session-scoped model/flag cache and the side-panel UI.
- **`web_accessible_resources: <all_urls>`** — kept broad to support "Analyze this page" as
  it expands across arbitrary financial domains. The exposed resources are **non-sensitive
  bundled ML assets only** (quantized ONNX weights + ORT WASM); they contain no user data and
  expose no analysis. (Today these load only inside the offscreen document; the broad scope is
  forward-looking and can be narrowed to specific hosts on request.)

The CSP (`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://*.sec.gov`) blocks
all egress except SEC, reinforcing the zero-egress guarantee at the platform level.

## How it works

```
EDGAR page
    │
    ▼
content script ──► ingest + positionMap + CSS Custom Highlight overlays
    │
    ▼
side panel (React) ──► Summary · Sentiment · Flags · Changes tabs
    │
    ▼
service worker ──► message router, EDGAR queue, offscreen document lifecycle
    │
    ▼
offscreen document ──► ONNX encoder/sentiment Web Workers (FinBERT + mxbai-embed)
```

**Generation tiers.** At startup, Relic probes Chrome's built-in AI APIs (Summarizer, Prompt API / Gemini Nano) and classifies the device as `builtin` or `extractive`:

- **builtin** — Chrome Summarizer + Prompt API for summaries, analyst notes, and change narratives.
- **extractive** — embedding-centrality sentence selection for summaries; all other analysis (sentiment, flags, redline) is identical.

**Highlighting.** All on-page overlays use the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) — 15 named, priority-stacked layers. No `<span>` injection, so XBRL interactive viewers stay intact.

**Coordinates.** A `positionMap` abstraction maps normalized document text to DOM ranges with O(log n) lookup. All highlighting and scroll-to-source flows go through it.

## Project structure

```
src/
├── background/       # MV3 service worker — routing, EDGAR queue, offscreen lifecycle
├── content/          # Content script — ingestion, positionMap, highlight overlays
│   ├── ingest/       # DOM walk, section detection, metadata extraction
│   └── highlight/    # Sentiment, flag, redline, and citation highlight layers
├── sidepanel/        # React side panel — tabs, onboarding, overlay controls
├── offscreen/        # Offscreen document — embedding/sentiment worker host
├── workers/          # FinBERT sentiment + mxbai embedding Web Workers (ONNX)
├── analyst/          # Investor analysis pipeline — staged Prompt API calls, evidence guards
├── summarizer/       # Two-tier section summarization + IndexedDB cache
├── redline/          # Prior-filing resolution, section alignment, diff engine
├── flagging/         # Lexicon + LM-dictionary language flag detection
├── db/               # IndexedDB stores (summaries, sentiment)
├── runtime/          # Capability detection (builtin vs extractive tier)
├── messages/         # Typed chrome.runtime message contracts
└── types/            # Canonical data model (DocumentModel, Section, etc.)

scripts/
└── fetch-models.mjs  # Download ONNX weights into models/ (build-time only)

tests/                # Vitest unit tests (positionMap, redline, sentiment, …)
public/icons/         # Extension icons
```

## Prerequisites

- **Node.js** 18+
- **Google Chrome** with Manifest V3 extension support
- For the `builtin` tier: Chrome with built-in AI APIs enabled (Summarizer / Prompt API)

## Development setup

```bash
# Install dependencies
npm install

# Download on-device model weights (~134 MB, build-time only)
npm run fetch-models

# Production build → dist/
npm run build

# Watch mode during development
npm run dev
```

`models/`, `dist/`, and `node_modules/` are gitignored. Regenerate them locally after cloning.

### Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Pin Relic and open the side panel from the toolbar icon.
4. Navigate to any `https://*.sec.gov` filing page.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Production build to `dist/` |
| `npm run dev` | Watch build for development |
| `npm run fetch-models` | Download FinBERT + mxbai-embed ONNX weights |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`) |
| `npm test` | Run Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage report |

## Testing

```bash
npm test
```

Tests cover core modules: `positionMap`, section segmentation, redline alignment/diff, sentiment scoring, flag detection, EDGAR queue, and more. See `tests/` and `MANUAL_TEST.md` for the full side-panel manual test script.

## Models

Relic bundles two quantized ONNX models (int8, ~134 MB total):

| Model | Role |
|-------|------|
| `Xenova/finbert` | Sentence-level financial sentiment |
| `mixedbread-ai/mxbai-embed-xsmall-v1` | Sentence embeddings for extractive summaries and the redline semantic pass |

Weights are fetched at build time via `npm run fetch-models` and loaded from `chrome.runtime.getURL('models/…')` at runtime — no Hugging Face requests in the shipped extension.

## Tech stack

- **Extension:** Chrome Manifest V3, service worker, offscreen document, side panel
- **UI:** React 19, Tailwind CSS 4, Framer Motion
- **ML:** ONNX Runtime Web, `@huggingface/transformers`, Chrome built-in AI APIs
- **Build:** Vite, `vite-plugin-web-extension`, TypeScript 6
- **Test:** Vitest, jsdom

## License

Relic's source code — including the language-flagging word lists — is released
under the [MIT License](LICENSE).

The MIT grant covers code and data authored in this repository only. Bundled
third-party components — the on-device ML models and the test fixtures — remain
under their own terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
