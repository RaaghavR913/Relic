# Relic — Shared Context Preamble

> **How to use this file:** This is not a task on its own — do not run it alone. It is the constant header for every Relic work prompt. If you (the agent) have repo access, each work prompt will tell you to read this file first. If you don't, its contents are pasted above the work prompt. Either way, the rules below apply to **every** item you implement.

## What Relic is

An on-device Chrome extension for SEC/EDGAR filing analysis. Everything runs locally; nothing about the user's reading is sent off-device.

## Architecture (do not break these abstractions)

- **positionMap** — a DFS DOM walker producing normalized, table-region-aware document coordinates with O(log n) binary-search lookup. **All DOM-coordinate access goes through this abstraction.** Don't read coordinates off the DOM directly.
- **CSS Custom Highlight API overlay system** — 15 named, priority-stacked highlight layers. **No span injection** — zero DOM pollution, no conflict with inline XBRL interactive viewers. Sentiment, flag, redline, and Q&A-citation overlays all coexist on this system. Anything that highlights text uses these layers; never inject `<span>`s.
- **Two-tier on-device generation** — a **builtin** path (Gemini Nano `LanguageModel` / `Summarizer`) and an **extractive** fallback path. ONNX Runtime Web powers Sentiment and Q&A embeddings.
- **EDGAR access** — a `RateLimitedQueue` at ≤8 req/s with exponential backoff, `Retry-After` honored, and a 30-minute in-memory cache. **Every** request to `*.sec.gov` goes through this queue.
- **Coordinate spaces** — the types distinguish **section-space** from **document-space** coordinates explicitly. Preserve that boundary; never silently mix them.

## The three invariants (treat a violation as a blocker-level regression)

1. **Zero unexpected egress.** No change may introduce any new outbound request. The only permitted network calls are to `*.sec.gov` *through the existing rate-limited queue*. No runtime fetching of models, dictionaries, assets, or telemetry. This is the product's entire trust proposition.
2. **positionMap is the only path to DOM coordinates.** Don't bypass it.
3. **No span injection.** All highlighting goes through the Custom Highlight layers.

If an item appears to require violating any of these, **stop and flag it** rather than working around it.

## Ground rules for every session

1. **Locate the real symbol before editing.** File/line hints in the prompts come from an audit and may have drifted. Grep for the named symbol (e.g. `PRIORITY_IDS`, `MAX_SUMMARIZER_CHARS`, `resolvePrior`, `templatedChangeSummary`, `DEFAULT_FOCUS_IDS`) and confirm the real location before changing anything.
2. **Meet the acceptance criteria** stated in the prompt before marking the item done. Don't declare success on a partial implementation.
3. **Keep the build green.** The extension currently builds clean and tests pass. Run the full test/build (not just the touched module) before finishing.
4. **Report what changed.** End with a short log: what you changed, where, and the acceptance evidence the prompt asked for.

## Delivery preference

Unless told otherwise, open a PR per the prompt's instructions. If you lack repo write access, produce a branch + diff and a PR-style description instead.
