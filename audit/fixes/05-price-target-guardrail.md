# Fix 05 — Extend the no-advice filter to catch price-target phrasing

**Finding:** P3-02 (LOW) — the "not investment advice" guardrail has a narrow gap.
**Execution order:** 5.

## Problem
The post-generation advice filter `scrubAdvice` (`src/analyst/evidence.ts:98-103`) removes sentences matching `ADVICE_PATTERNS` (`:89-95`): buy/sell/short/hold advice and directional price predictions ("the stock will rise/soar"). It does **not** match explicit price-target phrasing ("price target of $200", "target price", "fair value $180", "price objective"). Invented target *numbers* are caught indirectly by `scrubUnverifiedFigures`, but a target phrase reusing an in-document figure, or a non-numeric target, can pass.

## Files to touch
- `src/analyst/evidence.ts` — add one pattern to the `ADVICE_PATTERNS` array (`:89-95`):
  ```ts
  /\b(?:price\s+target|target\s+price|price\s+objective|fair\s+value(?:\s+(?:of|is|at))?)\b/i,
  ```
  Keep it in the same array so it flows through the existing `scrubAdvice` sentence-drop path and `finalizeInsight` (`:191`) unchanged.
- `tests/` — add a case to the existing evidence/advice test (search for a test importing `scrubAdvice` or `finalizeInsight`) asserting a sentence like `"Our price target is $250."` is dropped while a factual sentence like `"The company sells products."` is kept.

## Do NOT touch
- The `verifyEvidence` / `scrubUnverifiedFigures` / `normalizeFiscalLabels` logic.
- The prompt-level guardrail in `prompts.ts:25` (it stays; this hardens the post-gen layer).
- The existing `ADVICE_PATTERNS` entries (only add).

## Acceptance criteria
1. The new test passes: a sentence containing "price target"/"target price"/"fair value $X" is removed from insight fields; a neutral factual sentence is retained.
2. `npm test` passes (no regressions in existing advice/evidence tests).
3. `npm run typecheck` passes.
