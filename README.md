# Relic

**On-device SEC filing analysis. Nothing leaves your browser.**

[relicinvestor.com](https://relicinvestor.com) · [Chrome Web Store](https://chromewebstore.google.com/detail/relic-instant-investor-an/jhafapgofjljfafafikedcnfelmndgoe)

## The problem

Retail investors and small research teams who want to actually read a 10-K or 10-Q are stuck choosing between two bad options: read the filing manually (dense, slow, easy to miss what changed since last time) or paste it into a cloud AI tool (fast, but your research thesis and unpublished analysis now live on someone else's server). Neither works if you care about both speed and privacy.

## What Relic does

Relic is a browser extension for Chrome and Brave. Open a filing on SEC EDGAR and Relic analyzes it in the side panel. The filing and everything Relic derives from it stay on your device.

- **Analyst**: a snapshot read comes first (Bullish / Bearish / Mixed / Neutral), then more detail arrives stage by stage: key takeaways, what changed, the impact on revenue, margins and cash flow, risk signals, the bull and bear cases, and a watch list.
- **Summary**: plain-English summaries of each section.
- **Sentiment**: FinBERT tone scores for each sentence, broken down by section.
- **Redline**: a diff against the prior comparable filing. That's the most recent earlier filing of the same form relative to the one you're viewing, not whatever is newest on EDGAR. Amendments are skipped.
- **Language flags**: hedging, uncertainty, litigious and negative wording are underlined directly on the filing page.

All inference runs locally. ONNX Runtime Web runs the sentiment and embedding models, and Chrome's built-in Gemini Nano writes the generated text. When Nano isn't available (on Brave, for example), Relic falls back to extractive summaries and everything else works the same. The only network requests go to sec.gov, to fetch the prior filing for the redline. The extension's content security policy blocks all other destinations.

Every quote the model cites as evidence is checked against the filing text. If a quote doesn't appear in the source, Relic drops it and marks the insight low confidence.

## Why I built it this way

I chose on-device processing over a cloud API because for financial research, "nothing leaves the device" isn't a nice-to-have. It's the product decision that makes the tool usable for the people it's built for. That constraint drove everything after it:

- **Model selection**: small quantized models (FinBERT for sentiment and mxbai-embed-xsmall for embeddings, about 134 MB total) ship inside the extension, so nothing is downloaded at runtime.
- **Capability tiering**: Relic checks whether Gemini Nano is available. It runs generative analysis where Nano exists and extractive analysis where it doesn't. Model inference uses WebGPU when the device supports it.

## What's next

- Support for Firefox and Safari (Relic currently runs only on Chromium browsers)

## Built with AI assistance

I built Relic using Claude Code as a coding agent. I owned the product decisions, the architecture direction, the licensing research and the QA scope. I'm open about this because directing an AI agent well is itself part of the job I'm building toward.

## Stack

- **Extension:** Chrome Manifest V3 (service worker, offscreen document, side panel)
- **ML:** ONNX Runtime Web, Transformers.js, FinBERT, mxbai-embed-xsmall, Chrome built-in AI (Gemini Nano)
- **UI:** React 19, Tailwind CSS 4, Framer Motion
- **Build and test:** TypeScript, Vite, Vitest

## Development

Architecture, build setup, browser support, permissions and testing are covered in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE). The bundled ML models keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
