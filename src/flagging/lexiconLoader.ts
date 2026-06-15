// ============================================================
// FilingLens — Lexicon loader + regex compiler
// ------------------------------------------------------------
// Two-layer lexicon:
//   Layer 1 (base)  — 118-entry curated multi-word phrases with analyst notes.
//                     Imported statically; compiled once on first call.
//   Layer 2 (LM)    — curated/capped Loughran-McDonald subset: 1426 single words
//                     (neg 700 / unc 250 / lit 450 / wm 26), capped from the full
//                     ~3.5k set to balance coverage vs flag noise & bundle size.
//                     Loaded lazily via dynamic import; merged into cache on first
//                     call to awaitLexiconReady(). Run `npm run fetch-lm-dict` to
//                     refresh from the authoritative Notre Dame CSV (caps/curation
//                     live in scripts/fetch-lm-dict.mjs).
//
// Public API:
//   loadCompiledLexicons()  – synchronous; returns whatever is in cache (layer 1
//                             immediately, layer 1+2 after awaitLexiconReady()).
//   awaitLexiconReady()     – async; resolves once LM layer is merged. Callers
//                             that need full coverage must await this first.
//
// Extension point (Pro): callers may supply extra entries per type via
// LexiconOverrides; those entries are merged before compilation and bypass cache.
// ============================================================

import type { LanguageFlag } from '@/types';

import uncertaintyRaw from './lexicons/uncertainty.json';
import weakModalRaw   from './lexicons/weak_modal.json';
import litigiousRaw   from './lexicons/litigious.json';
import negativeRaw    from './lexicons/negative.json';

// ── types ─────────────────────────────────────────────────────────────────────

/** Matches LanguageFlag['type'] — kept in sync with the canonical data model. */
export type FlagType = LanguageFlag['type'];

export interface LexiconEntry {
  term: string;
  note: string;
  caseSensitive?: boolean;
}

/** A compiled entry ready for repeated regex matching (lastIndex must be reset before each exec loop). */
export interface CompiledEntry extends LexiconEntry {
  /** Pre-compiled word-boundary regex with the 'g' flag (+ 'i' unless caseSensitive). */
  regex: RegExp;
}

/**
 * Optional per-type extra entries for Pro custom dictionaries.
 * Pass to loadCompiledLexicons(); they are merged after the bundled defaults.
 */
export type LexiconOverrides = Partial<Record<FlagType, LexiconEntry[]>>;

// ── internal raw JSON shapes ──────────────────────────────────────────────────

interface RawLexicon {
  version: string;
  source: string;
  description: string;
  entries: LexiconEntry[];
}

/** Shape of the compact LM expansion files (flat word arrays). */
interface RawLMWordList {
  version: string;
  source: string;
  words: string[];
}

const BASE_LEXICONS: Record<FlagType, RawLexicon> = {
  uncertainty: uncertaintyRaw as RawLexicon,
  weak_modal:  weakModalRaw  as RawLexicon,
  litigious:   litigiousRaw  as RawLexicon,
  negative:    negativeRaw   as RawLexicon,
};

// ── generic notes for LM single-word expansion entries ────────────────────────
const LM_NOTE: Record<FlagType, string> = {
  negative:    'Loughran-McDonald negative word — financial distress or adverse-outcome signal',
  uncertainty: 'Loughran-McDonald uncertainty qualifier — estimation or outcome hedge',
  litigious:   'Loughran-McDonald litigious term — legal, regulatory, or enforcement context',
  weak_modal:  'Loughran-McDonald weak modal — tentative or conditional assertion',
};

// ── compilation ───────────────────────────────────────────────────────────────

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileEntry(entry: LexiconEntry): CompiledEntry {
  // Word-boundary anchors on both sides handle:
  //   – phrase starts/ends at punctuation (boundary before first char and after last char)
  //   – multi-word phrases with interior spaces (boundaries only matter at phrase edges)
  //   – "may" in "maybe" → no match because \b falls between "y" and "b" in "maybe"
  const flags = entry.caseSensitive === true ? 'g' : 'gi';
  const regex = new RegExp(`\\b${escapeRegex(entry.term)}\\b`, flags);
  return { ...entry, regex };
}

// ── module-level cache ─────────────────────────────────────────────────────────
// Filled immediately from the curated base on first call; expanded in-place when
// the LM layer loads. The cache maps FlagType → compiled entries (sorted by term
// length descending so longer phrases shadow shorter substrings during iteration).

let _cache: Record<FlagType, CompiledEntry[]> | null = null;

function buildBaseCache(): Record<FlagType, CompiledEntry[]> {
  const result = {} as Record<FlagType, CompiledEntry[]>;
  for (const type of Object.keys(BASE_LEXICONS) as FlagType[]) {
    result[type] = BASE_LEXICONS[type]!.entries.map(compileEntry);
  }
  return result;
}

// ── LM lazy-load state ────────────────────────────────────────────────────────

let _lmReady: Promise<void> | null = null;

async function _loadLMExpansion(): Promise<void> {
  const [negMod, uncMod, litMod, wmMod] = await Promise.all([
    import('./lexicons/lm_negative.json'),
    import('./lexicons/lm_uncertainty.json'),
    import('./lexicons/lm_litigious.json'),
    import('./lexicons/lm_weak_modal.json'),
  ]);

  const lmSources: Record<FlagType, RawLMWordList> = {
    negative:    negMod.default as unknown as RawLMWordList,
    uncertainty: uncMod.default as unknown as RawLMWordList,
    litigious:   litMod.default as unknown as RawLMWordList,
    weak_modal:  wmMod.default  as unknown as RawLMWordList,
  };

  // Ensure base cache exists (may have been built already by loadCompiledLexicons).
  if (!_cache) _cache = buildBaseCache();

  for (const type of Object.keys(lmSources) as FlagType[]) {
    const existing = _cache[type]!;
    // Build a set of already-present terms (lower-cased) to skip duplicates.
    const seen = new Set(existing.map((e) => e.term.toLowerCase()));

    const note = LM_NOTE[type];
    for (const word of lmSources[type]!.words) {
      if (seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      existing.push(compileEntry({ term: word, note, caseSensitive: false }));
    }
  }
}

/**
 * Start (or return the already-started) LM expansion load.
 * Resolves once all LM words have been compiled and merged into the cache.
 *
 * Call this as early as possible (e.g. at content-script startup) so the
 * dynamic imports are in-flight while the DOM walk is happening. Then await
 * before calling loadCompiledLexicons() to guarantee full coverage.
 */
export function awaitLexiconReady(): Promise<void> {
  if (!_lmReady) _lmReady = _loadLMExpansion();
  return _lmReady;
}

/**
 * Return compiled lexicons, synchronous.
 *
 * Returns the base (118-entry) set immediately; once awaitLexiconReady()
 * has resolved, subsequent calls return the full LM-expanded set.
 *
 * @param overrides  Optional Pro custom entries merged after bundled defaults.
 *                   When provided the result is NOT cached (may differ per call).
 */
export function loadCompiledLexicons(
  overrides?: LexiconOverrides,
): Record<FlagType, CompiledEntry[]> {
  if (!_cache) _cache = buildBaseCache();
  if (!overrides) return _cache;

  // With overrides: merge on top of whatever is currently in cache (base or base+LM).
  const result = {} as Record<FlagType, CompiledEntry[]>;
  for (const type of Object.keys(_cache) as FlagType[]) {
    const extra = overrides[type] ?? [];
    result[type] = [..._cache[type]!, ...extra.map(compileEntry)];
  }
  return result;
}

/** Metadata accessors for UI and diagnostics. */
export function lexiconMeta(type: FlagType): { source: string; description: string } {
  const lex = BASE_LEXICONS[type]!;
  return { source: lex.source, description: lex.description };
}
