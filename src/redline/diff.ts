// ============================================================
// Relic — Section diff engine (Session 6)
// ------------------------------------------------------------
// Pure functions — no Chrome APIs, no Workers, no IndexedDB.
// Imported by offscreen.ts (which supplies sentence embeddings for the semantic
// pass) and tested directly in vitest with synthetic similarity matchers.
//
// Hybrid strategy:
//   1. structuralDiff(): sentence-level LCS over normalized text → the set of
//      added (current-only) and removed (prior-only) sentences. This is the
//      precise textual layer.
//   2. assembleSectionDiff(): pairs leftover added↔removed sentences by a
//      similarity function (Jaccard by default; cosine of embeddings in the
//      offscreen "semantic" path). Paired sentences are REWORDED — a word-level
//      diff extracts the exact changed spans. Very-high-similarity pairs are
//      COSMETIC and dropped (only when cosmeticMin is set, i.e. the semantic
//      path). The remainder are genuinely added / removed.
//
// All ranges are SECTION-space: added → offsets into the CURRENT section text,
// removed → offsets into the PRIOR section text. The caller lifts added ranges
// into DOCUMENT space for on-page highlighting.
// ============================================================

import { splitSentences } from '@/summarizer/extractive';
import type { DiffSpan } from '@/types';

// ── public types ──────────────────────────────────────────────────────────────

export interface SentenceUnit {
  text: string;
  /** [start, end) offsets within the section text. */
  range: [number, number];
}

export interface TextualDiff {
  currentSentences: SentenceUnit[];
  priorSentences: SentenceUnit[];
  /** Indices into currentSentences with no exact match in prior. */
  addedIdx: number[];
  /** Indices into priorSentences with no exact match in current. */
  removedIdx: number[];
  currentLen: number;
  priorLen: number;
}

export interface DiffStats {
  addedSentences: number;
  removedSentences: number;
  rewordedSentences: number;
  /** Near-identical pairs dropped as cosmetic (semantic path only). */
  cosmeticDropped: number;
  addedChars: number;
  removedChars: number;
  /** Rounded percent of section text changed (magnitude × 100). */
  pctChanged: number;
  /** First words of the longest added passage (for the templated summary). */
  longestAdded: string;
}

export interface SectionDiffCore {
  /** Section-space ranges into the CURRENT text. */
  added: DiffSpan[];
  /** Section-space ranges into the PRIOR text. */
  removed: DiffSpan[];
  /** 0..1 — fraction of combined section text that changed. */
  magnitude: number;
  stats: DiffStats;
}

/**
 * Similarity in [0, 1] between an added (current) sentence and a removed (prior)
 * sentence. Default is token Jaccard; the offscreen semantic path supplies a
 * cosine-of-embeddings matcher.
 */
export type Similarity = (
  addedText: string,
  removedText: string,
  addedIdx: number,
  removedIdx: number,
) => number;

export interface DiffOptions {
  similarity?: Similarity;
  /** Pairs with similarity ≥ this are treated as REWORDED. Default 0.5 (Jaccard). */
  rewordMin?: number;
  /** Pairs with similarity ≥ this are dropped as COSMETIC. Default Infinity (off). */
  cosmeticMin?: number;
}

// ── normalization & tokenization ──────────────────────────────────────────────

/** Aggressive normalization used for EXACT sentence matching across years. */
export function normForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9%$.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(s: string): Token[] {
  const toks: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    toks.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return toks;
}

function tokenSet(s: string): Set<string> {
  return new Set(normForMatch(s).split(' ').filter(Boolean));
}

/** Token-set Jaccard similarity in [0, 1]. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── sentence-level LCS structural diff ────────────────────────────────────────

/**
 * Longest-common-subsequence of two key arrays. Returns a boolean[] for each
 * input marking which positions participate in the LCS (i.e. are "matched").
 */
function lcsMatch(a: string[], b: string[]): { aMatched: boolean[]; bMatched: boolean[] } {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const aMatched = new Array<boolean>(n).fill(false);
  const bMatched = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aMatched[i] = true;
      bMatched[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { aMatched, bMatched };
}

export function structuralDiff(currentText: string, priorText: string): TextualDiff {
  const currentSentences = splitSentences(currentText);
  const priorSentences = splitSentences(priorText);

  const curKeys = currentSentences.map((s) => normForMatch(s.text));
  const priKeys = priorSentences.map((s) => normForMatch(s.text));

  const { aMatched, bMatched } = lcsMatch(curKeys, priKeys);

  const addedIdx: number[] = [];
  const removedIdx: number[] = [];
  for (let i = 0; i < currentSentences.length; i++) if (!aMatched[i]) addedIdx.push(i);
  for (let j = 0; j < priorSentences.length; j++) if (!bMatched[j]) removedIdx.push(j);

  return {
    currentSentences,
    priorSentences,
    addedIdx,
    removedIdx,
    currentLen: currentText.length,
    priorLen: priorText.length,
  };
}

// ── word-level diff (for reworded pairs) ──────────────────────────────────────

interface WordRun {
  text: string;
  start: number;
  end: number;
}

/** Merge consecutive unmatched tokens into contiguous char spans. */
function unmatchedRuns(tokens: Token[], matched: boolean[]): WordRun[] {
  const runs: WordRun[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (matched[i]) {
      i++;
      continue;
    }
    const start = tokens[i]!.start;
    let end = tokens[i]!.end;
    let j = i + 1;
    while (j < tokens.length && !matched[j]) {
      end = tokens[j]!.end;
      j++;
    }
    runs.push({ text: '', start, end });
    i = j;
  }
  return runs;
}

/**
 * Word-level diff of two sentences. Returns the changed char spans within each
 * (relative to that sentence's start). `added` spans live in `curText`,
 * `removed` spans in `priText`.
 */
export function wordDiff(
  curText: string,
  priText: string,
): { added: WordRun[]; removed: WordRun[] } {
  const curToks = tokenize(curText);
  const priToks = tokenize(priText);
  const curKeys = curToks.map((t) => normForMatch(t.text));
  const priKeys = priToks.map((t) => normForMatch(t.text));
  const { aMatched, bMatched } = lcsMatch(curKeys, priKeys);

  const added = unmatchedRuns(curToks, aMatched).map((r) => ({
    ...r,
    text: curText.slice(r.start, r.end),
  }));
  const removed = unmatchedRuns(priToks, bMatched).map((r) => ({
    ...r,
    text: priText.slice(r.start, r.end),
  }));
  return { added, removed };
}

// ── pairing + assembly ────────────────────────────────────────────────────────

interface Pair {
  a: number; // index into addedIdx-resolved current sentences
  r: number; // index into removedIdx-resolved prior sentences
  score: number;
}

/**
 * Greedily pair leftover added/removed sentences by similarity. Pairs at or
 * above `rewordMin` are kept; each sentence is used at most once, highest scores
 * first.
 */
function pairBySimilarity(
  td: TextualDiff,
  sim: Similarity,
  rewordMin: number,
): Pair[] {
  const candidates: Pair[] = [];
  for (let a = 0; a < td.addedIdx.length; a++) {
    const curText = td.currentSentences[td.addedIdx[a]!]!.text;
    for (let r = 0; r < td.removedIdx.length; r++) {
      const priText = td.priorSentences[td.removedIdx[r]!]!.text;
      const score = sim(curText, priText, td.addedIdx[a]!, td.removedIdx[r]!);
      if (score >= rewordMin) candidates.push({ a, r, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);

  const usedA = new Set<number>();
  const usedR = new Set<number>();
  const pairs: Pair[] = [];
  for (const c of candidates) {
    if (usedA.has(c.a) || usedR.has(c.r)) continue;
    usedA.add(c.a);
    usedR.add(c.r);
    pairs.push(c);
  }
  return pairs;
}

export function assembleSectionDiff(td: TextualDiff, opts: DiffOptions = {}): SectionDiffCore {
  const sim = opts.similarity ?? jaccardSimilarity;
  const rewordMin = opts.rewordMin ?? 0.5;
  const cosmeticMin = opts.cosmeticMin ?? Infinity;

  const pairs = pairBySimilarity(td, sim, rewordMin);
  const pairedA = new Set(pairs.map((p) => p.a));
  const pairedR = new Set(pairs.map((p) => p.r));

  const added: DiffSpan[] = [];
  const removed: DiffSpan[] = [];
  let rewordedSentences = 0;
  let cosmeticDropped = 0;

  // Reworded / cosmetic pairs.
  for (const p of pairs) {
    const cur = td.currentSentences[td.addedIdx[p.a]!]!;
    const pri = td.priorSentences[td.removedIdx[p.r]!]!;
    if (p.score >= cosmeticMin) {
      cosmeticDropped++;
      continue; // near-identical wording — not a substantive change
    }
    rewordedSentences++;
    const wd = wordDiff(cur.text, pri.text);
    for (const run of wd.added) {
      if (!run.text.trim()) continue;
      added.push({ text: run.text, range: [cur.range[0] + run.start, cur.range[0] + run.end] });
    }
    for (const run of wd.removed) {
      if (!run.text.trim()) continue;
      removed.push({ text: run.text, range: [pri.range[0] + run.start, pri.range[0] + run.end] });
    }
  }

  // Genuinely added (unpaired current) sentences.
  let addedSentences = 0;
  for (let a = 0; a < td.addedIdx.length; a++) {
    if (pairedA.has(a)) continue;
    addedSentences++;
    const cur = td.currentSentences[td.addedIdx[a]!]!;
    added.push({ text: cur.text, range: [cur.range[0], cur.range[1]] });
  }

  // Genuinely removed (unpaired prior) sentences.
  let removedSentences = 0;
  for (let r = 0; r < td.removedIdx.length; r++) {
    if (pairedR.has(r)) continue;
    removedSentences++;
    const pri = td.priorSentences[td.removedIdx[r]!]!;
    removed.push({ text: pri.text, range: [pri.range[0], pri.range[1]] });
  }

  const addedChars = added.reduce((n, s) => n + s.text.length, 0);
  const removedChars = removed.reduce((n, s) => n + s.text.length, 0);
  const denom = td.currentLen + td.priorLen;
  const magnitude = denom === 0 ? 0 : Math.min(1, (addedChars + removedChars) / denom);

  // Longest added passage → first words.
  let longest = '';
  for (const s of added) if (s.text.length > longest.length) longest = s.text;
  const longestAdded = firstWords(longest, 10);

  return {
    added,
    removed,
    magnitude,
    stats: {
      addedSentences,
      removedSentences,
      rewordedSentences,
      cosmeticDropped,
      addedChars,
      removedChars,
      pctChanged: Math.round(magnitude * 100),
      longestAdded,
    },
  };
}

/** Convenience: structuralDiff → assembleSectionDiff in one call. */
export function diffSection(
  currentText: string,
  priorText: string,
  opts: DiffOptions = {},
): SectionDiffCore {
  return assembleSectionDiff(structuralDiff(currentText, priorText), opts);
}

// ── templated change summary (extractive tier) ────────────────────────────────

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

function firstWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const head = words.slice(0, n).join(' ');
  return words.length > n ? head + '…' : head;
}

/**
 * Build a deterministic, no-model summary from diff stats.
 * e.g. "3 additions, 1 removal; ~22% of section text changed;
 *       longest added passage: 'The Company faces new regulatory…'"
 */
export function templatedChangeSummary(stats: DiffStats): string {
  const totalAdds = stats.addedSentences;
  const totalRems = stats.removedSentences;
  if (
    totalAdds === 0 &&
    totalRems === 0 &&
    stats.rewordedSentences === 0
  ) {
    return 'No substantive changes detected in this section.';
  }

  const parts: string[] = [];
  const head: string[] = [];
  if (totalAdds > 0) head.push(plural(totalAdds, 'addition'));
  if (totalRems > 0) head.push(plural(totalRems, 'removal'));
  if (stats.rewordedSentences > 0) head.push(plural(stats.rewordedSentences, 'reworded passage'));
  parts.push(head.join(', '));

  parts.push(`~${stats.pctChanged}% of section text changed`);

  if (stats.longestAdded) {
    parts.push(`longest added passage: “${stats.longestAdded}”`);
  }

  return parts.join('; ') + '.';
}
