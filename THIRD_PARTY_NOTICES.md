# Third-Party Notices

Relic's own source code is licensed under the [MIT License](LICENSE). The
MIT grant covers code authored in this repository **only**. It does not cover the
language-flagging word lists described below, or the bundled and referenced
third-party components, which are not owned by this project and remain subject
to their own licenses and terms. Nothing in this repository's MIT license should
be read as relicensing them.

## Language-flagging word lists

The lexicons in `src/flagging/lexicons/*.json` (multi-word phrases and
single-word vocabulary across the negative / uncertainty / litigious /
weak_modal categories) are **not** covered by Relic's MIT license. They are
provided for **noncommercial use only**.

The phrase lists were first described in this repository as a curated subset of
the [Loughran-McDonald Master Dictionary](https://sraf.nd.edu/loughranmcdonald-master-dictionary/)
word lists, and the single-word lists share part of their vocabulary with those
lists. The Loughran-McDonald dictionary is free for academic and noncommercial
use; commercial use requires a license from its authors. If you reuse these
lists, treat them under the same terms.

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
