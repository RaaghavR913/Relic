# Fix 03 — Remove dead source file and unused exports

**Finding:** P4-01 (LOW) — dead code. Full inventory: `audit/DEAD-CODE.md` §A/§B/§F.
**Execution order:** 3.

## Delete (dead file)
- `src/shared/flagMeta.ts` — zero references; its only export `CATEGORY_META` is also dead.

## Remove these dead exports (delete the symbol; if the file becomes empty, delete the file)
- `clearSentimentCache` — `src/db/sentimentStore.ts:88`
- `clearSummariesForDoc` — `src/summarizer/summaryStore.ts:112`
- `lexiconMeta` — `src/flagging/lexiconLoader.ts:190`
- `getSecFetchEnabled` — `src/shared/secFetchPref.ts:19` (superseded by the `useSecFetchPref` hook in the same file)
- `ProgressBar` — `src/sidepanel/ui.tsx:100`
- `ANALYST_DISCLAIMER` — `src/analyst/prompts.ts:16`
- `AnalysisArtifacts` type — `src/types/index.ts:153`
- Unused message-type interfaces `MessageTarget`, `OffscreenIdleMsg`, `ContentClearMsg`, `ContentResyncFilingMsg`, `WorkerInbound`, `SentimentWorkerInbound` — `src/messages/types.ts:15,131,187,193,416,586`
- Barrel re-export lines — `src/content/ingest/index.ts:152-157` (the functions stay; only the re-export lines go — every consumer already imports them from the sub-modules)

## Collapse the redundant shim
- `src/offscreen/sentenceFilter.ts` is a re-export of `@/lib/sentenceFilter`. Repoint `src/offscreen/offscreen.ts:55` (`import { filterNonTableSentences } from './sentenceFilter'`) to `from '@/lib/sentenceFilter'`, then delete `src/offscreen/sentenceFilter.ts`.

## Do NOT touch (verified LIVE — removing these breaks the build/features)
- `createSummarizer` (`capabilities.ts:196`) — dead today but part of the built-in-AI capability surface; leave pending a separate API-surface decision.
- `DISCLAIMER` (`summarize.ts:28`) — LIVE, used by `SummaryPanel.tsx:246` (do not confuse with `ANALYST_DISCLAIMER`).
- The `content/segment.ts`↔`content/ingest/segment.ts` and `content/positionMap.ts`↔`content/ingest/position-map.ts` pairs — **both members are live** in the ingest pipeline.
- `ingestDocument`, `getCachedRedline`, `putRedline`, `downloadFilingReportPdf`, `probePromptApiAvailability`, `watchWebGpuDeviceLost`, `normalizePageUrl`, `fetchPdfBase64`, `FilingAnalysis` — tool false positives, all used cross-module.

## Acceptance criteria
1. `npm run typecheck` (`tsc --noEmit`) passes.
2. `npm test` passes.
3. `npm run build` prints `✓ verify-dist: … looks shippable`.
4. For each removed symbol, `grep -rn "<symbol>" src/ tests/` returns no remaining reference.
