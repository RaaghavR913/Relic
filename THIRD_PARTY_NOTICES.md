# Third-Party Notices

Disclora's own source code is licensed under the [MIT License](LICENSE). The
MIT grant covers code authored in this repository **only**. The following
bundled or referenced third-party components are **not** owned by this project
and remain subject to their own licenses and terms. Nothing in this repository's
MIT license should be read as relicensing them.

## Bundled ML models (fetched at build time, not stored in this repo)

Downloaded by `npm run fetch-models` into the gitignored `models/` directory and
bundled into the shipped extension:

- **`Xenova/finbert`** — ONNX port of ProsusAI/FinBERT. See the model card on
  Hugging Face for its license before redistribution.
- **`mixedbread-ai/mxbai-embed-xsmall-v1`** — Apache-2.0. See the model card on
  Hugging Face.

## Test fixtures

- `fixtures/edgar/*` — U.S. SEC/EDGAR filings, included solely as test inputs.
  These are public records and are **not** covered by this project's MIT license.

Saved HTML snapshots of third-party financial sites are intentionally **not**
included in this repository (they are copyrighted page captures). The offline
extraction harness covers the SEC.gov path with inline fixtures; to smoke-test a
non-SEC site layout, capture the live page's `outerHTML` locally.
