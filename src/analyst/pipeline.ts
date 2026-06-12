// ============================================================
// FilingLens — Analyst pipeline orchestrator
// ------------------------------------------------------------
// Runs in the SIDE PANEL (has Chrome AI APIs). Builds a FilingAnalysis through
// staged Prompt API calls — Gemini Nano's context is too small for one-shot
// generation over a filing, so each stage gets a keyword-targeted excerpt
// budget and a JSON-schema responseConstraint:
//
//   snapshot → takeaways → whatChanged (deterministic, from redline)
//   → revenue → margins → cashflow → shares → risks → narrative → synthesis
//
// Guards on every LM result: enum coercion, evidence verification against the
// source text (fabricated quotes are dropped), and advice scrubbing.
// Stages fail soft: a parse failure skips the stage, the rest continue.
//
// PRIVACY: all calls hit the on-device model; nothing leaves the machine.
// ============================================================

import type {
  AnalysisScores,
  AnalysisStage,
  DocumentModel,
  FilingAnalysis,
  FilingInsight,
  InsightCategory,
  NarrativeCheck,
  ScorePoint,
  WatchItem,
} from '@/types';
import type { GenerationTier } from '@/runtime/capabilities';
import {
  SYSTEM_PROMPT,
  LABELS,
  CATEGORIES,
  SEVERITIES,
  HORIZONS,
  CONFIDENCES,
  READS,
  ASSESSMENTS,
  DOC_TYPES,
  buildStagePrompt,
  insightArraySchema,
  snapshotSchema,
  narrativeSchema,
  synthesisSchema,
} from './prompts';
import { finalizeInsight, scrubAdvice } from './evidence';
import {
  buildHints,
  deterministicAnalysis,
  mapDocumentType,
  whatChangedFromRedline,
  type AuxSignals,
} from './deterministic';
import { selectOverviewText, selectRelevantText, type Dimension } from './relevance';

// ── LM abstraction (injectable for tests) ────────────────────────────────────

export interface AnalystLMSession {
  prompt(
    text: string,
    opts?: { responseConstraint?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<string>;
  destroy(): void;
}

export type AnalystLMFactory = (
  systemPrompt: string,
  signal?: AbortSignal,
  /** Surfaces Gemini Nano's one-time download progress (0..1) on first create. */
  onDownloadProgress?: (loaded: number) => void,
) => Promise<AnalystLMSession | null>;

interface LMMonitor {
  addEventListener(
    type: 'downloadprogress',
    cb: (e: { loaded: number; total?: number }) => void,
  ): void;
}

interface LMCtor {
  create(opts: {
    initialPrompts?: Array<{ role: string; content: string }>;
    monitor?: (m: LMMonitor) => void;
    signal?: AbortSignal;
  }): Promise<AnalystLMSession>;
}

const defaultLMFactory: AnalystLMFactory = async (systemPrompt, signal, onDownloadProgress) => {
  const LM = (globalThis as Record<string, unknown>)['LanguageModel'] as LMCtor | undefined;
  if (!LM) return null;
  try {
    return await LM.create({
      initialPrompts: [{ role: 'system', content: systemPrompt }],
      // Mirror summarize.ts / capabilities.ts: surface the first-use model
      // download so the UI shows progress instead of looking frozen.
      monitor: (m) => {
        m.addEventListener('downloadprogress', (e) => onDownloadProgress?.(e.loaded));
      },
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    return null;
  }
};

// ── budgets ──────────────────────────────────────────────────────────────────

const OVERVIEW_BUDGET = 3_600;
const DIMENSION_BUDGET = 3_200;
const SYNTHESIS_BUDGET = 2_800;
/** Below this many relevant chars, skip the LM call (sparse docs, e.g. Form 4). */
const MIN_EXCERPT_CHARS = 200;

// Per-stage deadlines. The first LM call can include a one-time model download
// or cold warmup, so it gets a longer budget than subsequent stages. Without
// these, a hung LanguageModel.create()/prompt() wedges the whole pipeline and
// pins the panel on "Reading the document…" forever (the bug this fixes).
const SNAPSHOT_TIMEOUT_MS = 30_000;
const STAGE_TIMEOUT_MS = 20_000;

/**
 * Run `fn` with a hard deadline. Returns `fn`'s result, or `null` if it doesn't
 * settle within `ms` (the child signal is aborted, best-effort, to free the LM
 * session). A real parent-abort (user cancel / unmount / new run) propagates as
 * an AbortError so the caller can bail cleanly. The Promise.race guarantees we
 * stop awaiting even if Chrome ignores the abort signal mid-download.
 */
async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent: AbortSignal | undefined,
): Promise<T | null> {
  if (parent?.aborted) throw new DOMException('aborted', 'AbortError');
  const child = new AbortController();
  const onAbort = () => child.abort();
  parent?.addEventListener('abort', onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      child.abort();
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([fn(child.signal), timeout]);
  } catch (err) {
    if (parent?.aborted) throw new DOMException('aborted', 'AbortError');
    // Timeout-driven abort or a stage-local failure → fail soft.
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  }
}

// ── parsing / validation helpers ─────────────────────────────────────────────

function parseJson(raw: string): unknown {
  let s = raw.trim();
  // Strip markdown fences if the model added them despite the constraint.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = Math.min(
    ...['{', '['].map((c) => {
      const i = s.indexOf(c);
      return i === -1 ? Number.POSITIVE_INFINITY : i;
    }),
  );
  if (!Number.isFinite(start)) throw new Error('no JSON in model output');
  return JSON.parse(s.slice(start)) as unknown;
}

function coerce<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coerceInsights(
  doc: DocumentModel,
  raw: unknown,
  defaultCategory: InsightCategory,
  max: number,
): FilingInsight[] {
  if (!Array.isArray(raw)) return [];
  const out: FilingInsight[] = [];
  for (const item of raw.slice(0, max)) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const summary = str(o['summary']);
    const title = str(o['title']);
    if (!summary || !title) continue;
    const evidence = str(o['evidence']);
    const insight: FilingInsight = {
      label: coerce(o['label'], LABELS, 'Unclear'),
      category: coerce(o['category'], CATEGORIES, defaultCategory),
      title,
      summary,
      whyItMatters: str(o['whyItMatters']),
      investorMeaning: str(o['investorMeaning']),
      ...(evidence ? { evidence } : {}),
      severity: coerce(o['severity'], SEVERITIES, 'Low'),
      timeHorizon: coerce(o['timeHorizon'], HORIZONS, 'Medium-term'),
      confidence: coerce(o['confidence'], CONFIDENCES, 'Low'),
    };
    const finalized = finalizeInsight(doc, insight);
    if (finalized) out.push(finalized);
  }
  return out;
}

function coerceScores(raw: unknown): AnalysisScores | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const point = (v: unknown): ScorePoint =>
    (typeof v === 'number' && v >= 1 && v <= 5 ? Math.round(v) : 3) as ScorePoint;
  return {
    revenueStrength: point(o['revenueStrength']),
    marginQuality: point(o['marginQuality']),
    cashFlowQuality: point(o['cashFlowQuality']),
    balanceSheetStrength: point(o['balanceSheetStrength']),
    riskLevel: point(o['riskLevel']),
    managementCredibility: point(o['managementCredibility']),
    shareholderFriendliness: point(o['shareholderFriendliness']),
  };
}

// ── synthesis digest ─────────────────────────────────────────────────────────

/** Compact, model-readable digest of all prior findings (no raw filing text). */
export function digestForSynthesis(a: FilingAnalysis): string {
  const lines: string[] = [
    `Overall read so far: ${a.overallRead} (confidence ${a.confidence}). ${a.oneSentenceSummary}`,
    `Theme: ${a.investorSnapshot.mainFinancialTheme}. Key question: ${a.investorSnapshot.mostImportantInvestorQuestion}`,
  ];
  const dump = (name: string, items: FilingInsight[]) => {
    for (const i of items.slice(0, 4)) {
      lines.push(`[${name}] (${i.label}/${i.category}/sev ${i.severity}) ${i.title}: ${i.summary}`);
    }
  };
  dump('takeaway', a.topTakeaways);
  dump('changed', a.whatChanged);
  dump('revenue', a.revenueImpact);
  dump('margins', a.marginImpact);
  dump('cashflow', a.cashFlowImpact);
  dump('balance', a.balanceSheetHealth);
  dump('shares', a.shareImpact);
  dump('risk', a.riskSignals);
  for (const n of a.managementNarrativeCheck.slice(0, 3)) {
    lines.push(`[narrative] "${n.claim}" → ${n.assessment}: ${n.investorMeaning}`);
  }
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > SYNTHESIS_BUDGET) break;
    out += l + '\n';
  }
  return out.trim();
}

// ── public entry point ────────────────────────────────────────────────────────

export interface GenerateAnalysisOptions {
  tier: GenerationTier;
  aux?: AuxSignals;
  signal?: AbortSignal;
  /** Called after every completed stage with the (mutated) analysis so far. */
  onStage?: (stage: AnalysisStage, analysis: FilingAnalysis) => void;
  /** Surfaces Gemini Nano's one-time download progress (0..1) to the UI. */
  onDownloadProgress?: (loaded: number) => void;
  /** Test seam — defaults to the Chrome Prompt API. */
  lmFactory?: AnalystLMFactory;
}

export async function generateFilingAnalysis(
  doc: DocumentModel,
  opts: GenerateAnalysisOptions,
): Promise<FilingAnalysis> {
  const aux: AuxSignals = opts.aux ?? {};

  if (opts.tier !== 'builtin') {
    const det = deterministicAnalysis(doc, aux);
    opts.onStage?.('snapshot', det);
    return det;
  }

  const lmFactory = opts.lmFactory ?? defaultLMFactory;
  const sig = opts.signal;
  const hints = buildHints(aux);

  // Deterministic floor, then upgrade. We keep the full deterministic analysis
  // (snapshot one-liner, takeaways, per-dimension cards, risk signals, redline
  // changes) as a baseline and let each LM stage OVERWRITE its section only when
  // it produces real content. This guarantees the panel always has something to
  // render immediately — so a slow/hung/unavailable LM can never pin the UI on
  // the blank "Reading the document…" card — and if every LM stage fails the
  // user still gets the honest on-device read instead of nothing.
  const analysis = deterministicAnalysis(doc, aux);
  // Optimistically suppress the degraded banner while we attempt the LM upgrade
  // (the header stage-label is the "upgrading" cue). Re-derived at the end from
  // whether the model actually contributed anything.
  analysis.degraded = false;
  let anyLMSuccess = false;

  const markDone = (stage: AnalysisStage) => {
    if (!analysis.stagesDone.includes(stage)) analysis.stagesDone.push(stage);
    opts.onStage?.(stage, analysis);
  };

  // Emit the floor immediately so the panel renders real content (non-null) from
  // the first frame, before the first — potentially slow — LM call.
  opts.onStage?.('snapshot', analysis);

  /** One LM round-trip with constraint + hard deadline; returns parsed JSON or null. */
  const ask = async (
    stage: AnalysisStage,
    excerpts: string,
    schema: Record<string, unknown>,
    stageHints?: string,
  ): Promise<unknown | null> => {
    if (sig?.aborted) throw new DOMException('aborted', 'AbortError');
    const ms = stage === 'snapshot' ? SNAPSHOT_TIMEOUT_MS : STAGE_TIMEOUT_MS;
    return withDeadline(async (signal) => {
      const session = await lmFactory(SYSTEM_PROMPT, signal, opts.onDownloadProgress);
      if (!session) return null;
      try {
        const raw = await session.prompt(buildStagePrompt(stage, doc, excerpts, stageHints), {
          responseConstraint: schema,
          signal,
        });
        return parseJson(raw);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        console.warn(`[FilingLens] analyst stage "${stage}" failed:`, err);
        return null;
      } finally {
        session.destroy();
      }
    }, ms, sig);
  };

  const overview = selectOverviewText(doc, OVERVIEW_BUDGET);

  // 1 ── snapshot
  const snapRaw = await ask('snapshot', overview, snapshotSchema, hints);
  if (snapRaw && typeof snapRaw === 'object') {
    const o = snapRaw as Record<string, unknown>;
    analysis.documentType = coerce(o['documentType'], DOC_TYPES, mapDocumentType(doc.filingType));
    analysis.overallRead = coerce(o['overallRead'], READS, 'Neutral');
    analysis.confidence = coerce(o['confidence'], CONFIDENCES, 'Low');
    analysis.oneSentenceSummary =
      scrubAdvice(str(o['oneSentenceSummary'])) || analysis.oneSentenceSummary;
    analysis.investorSnapshot = {
      mainFinancialTheme:
        scrubAdvice(str(o['mainFinancialTheme'])) || analysis.investorSnapshot.mainFinancialTheme,
      timeHorizon: coerce(o['timeHorizon'], HORIZONS, analysis.investorSnapshot.timeHorizon),
      mostImportantInvestorQuestion:
        scrubAdvice(str(o['mostImportantInvestorQuestion'])) ||
        analysis.investorSnapshot.mostImportantInvestorQuestion,
    };
    anyLMSuccess = true;
    markDone('snapshot');
  } else {
    // The first — and simplest — LM call produced nothing: the model is
    // unavailable, still downloading, or hung past its deadline. Don't attempt
    // 8 more doomed stages (each its own timeout). Finalize on the deterministic
    // floor, which is already rendered, and flag it as an on-device read.
    analysis.degraded = true;
    analysis.generatedAt = Date.now();
    return analysis;
  }

  // 2 ── top takeaways
  const takeRaw = await ask('takeaways', overview, insightArraySchema(7), hints);
  const takeaways = coerceInsights(doc, takeRaw, 'Operations', 7);
  if (takeaways.length > 0) {
    analysis.topTakeaways = takeaways;
    anyLMSuccess = true;
    markDone('takeaways');
  }

  // 3 ── what changed (deterministic — redline engine is ground truth)
  analysis.whatChanged = whatChangedFromRedline(doc, aux.redline);
  markDone('whatChanged');

  // 4–8 ── dimension passes (each skipped when the doc has no relevant text)
  const dimensionStages: Array<{
    stage: AnalysisStage;
    dims: ReadonlyArray<Exclude<Dimension, 'overview'>>;
    category: InsightCategory;
    max: number;
    assign: (insights: FilingInsight[]) => void;
  }> = [
    { stage: 'revenue', dims: ['revenue'], category: 'Revenue', max: 3,
      assign: (i) => { analysis.revenueImpact = i; } },
    { stage: 'margins', dims: ['margins'], category: 'Margins', max: 3,
      assign: (i) => { analysis.marginImpact = i; } },
    { stage: 'cashflow', dims: ['cashflow', 'balancesheet'], category: 'Cash Flow', max: 4,
      assign: (i) => {
        analysis.cashFlowImpact = i.filter((x) => x.category !== 'Balance Sheet');
        analysis.balanceSheetHealth = i.filter((x) => x.category === 'Balance Sheet');
      } },
    { stage: 'shares', dims: ['shares'], category: 'Shares', max: 3,
      assign: (i) => { analysis.shareImpact = i; } },
    { stage: 'risks', dims: ['risk'], category: 'Risk', max: 5,
      assign: (i) => { analysis.riskSignals = i; } },
  ];

  for (const d of dimensionStages) {
    const excerpts = selectRelevantText(doc, d.dims, DIMENSION_BUDGET);
    if (excerpts.length < MIN_EXCERPT_CHARS) {
      // Not enough source material — honest empty (UI renders "Not enough information").
      markDone(d.stage);
      continue;
    }
    const raw = await ask(d.stage, excerpts, insightArraySchema(d.max), d.stage === 'risks' ? hints : undefined);
    const insights = coerceInsights(doc, raw, d.category, d.max);
    // Overwrite the deterministic floor only when the LM produced real insights;
    // a null/empty response keeps the on-device cards rather than wiping them.
    if (insights.length > 0) {
      d.assign(insights);
      anyLMSuccess = true;
      markDone(d.stage);
    }
  }

  // 9 ── management narrative check
  const mgmtText = selectRelevantText(doc, ['management'], DIMENSION_BUDGET);
  if (mgmtText.length >= MIN_EXCERPT_CHARS) {
    const narrRaw = await ask('narrative', mgmtText, narrativeSchema, hints);
    if (Array.isArray(narrRaw)) {
      const checks: NarrativeCheck[] = [];
      for (const item of narrRaw.slice(0, 4)) {
        if (typeof item !== 'object' || item === null) continue;
        const o = item as Record<string, unknown>;
        const claim = str(o['claim']);
        if (!claim) continue;
        checks.push({
          claim,
          evidence: scrubAdvice(str(o['evidence'])),
          assessment: coerce(o['assessment'], ASSESSMENTS, 'Unclear'),
          investorMeaning: scrubAdvice(str(o['investorMeaning'])),
        });
      }
      analysis.managementNarrativeCheck = checks;
      anyLMSuccess = true;
      markDone('narrative');
    }
  } else {
    markDone('narrative');
  }

  // 10 ── synthesis (bull/bear, watch list, plain English, scores) — uses only
  // prior findings, never raw filing text, so the model can't introduce new "facts".
  const haveFindings =
    analysis.topTakeaways.length + analysis.revenueImpact.length +
    analysis.marginImpact.length + analysis.cashFlowImpact.length +
    analysis.riskSignals.length > 0;
  if (haveFindings) {
    const synthRaw = await ask('synthesis', digestForSynthesis(analysis), synthesisSchema);
    if (synthRaw && typeof synthRaw === 'object') {
      const o = synthRaw as Record<string, unknown>;
      const strArr = (v: unknown, max: number): string[] =>
        Array.isArray(v) ? v.map(str).map(scrubAdvice).filter(Boolean).slice(0, max) : [];
      analysis.bullCase = strArr(o['bullCase'], 5);
      analysis.bearCase = strArr(o['bearCase'], 5);
      analysis.netRead = scrubAdvice(str(o['netRead']));
      analysis.plainEnglishExplanation = scrubAdvice(str(o['plainEnglishExplanation']));
      if (Array.isArray(o['whatToWatchNext'])) {
        const items: WatchItem[] = [];
        for (const w of (o['whatToWatchNext'] as unknown[]).slice(0, 6)) {
          if (typeof w !== 'object' || w === null) continue;
          const wo = w as Record<string, unknown>;
          const item = str(wo['item']);
          if (!item) continue;
          const relatedMetric = str(wo['relatedMetric']);
          items.push({
            item,
            whyItMatters: scrubAdvice(str(wo['whyItMatters'])),
            ...(relatedMetric ? { relatedMetric } : {}),
          });
        }
        analysis.whatToWatchNext = items;
      }
      const scores = coerceScores(o['scores']);
      if (scores) analysis.scores = scores;
      anyLMSuccess = true;
      markDone('synthesis');
    }
  }

  // If no LM stage contributed (e.g. every call timed out or returned empty),
  // the result is effectively the deterministic floor — label it honestly so
  // the on-device banner explains what the user is looking at.
  analysis.degraded = !anyLMSuccess;
  analysis.generatedAt = Date.now();
  return analysis;
}
