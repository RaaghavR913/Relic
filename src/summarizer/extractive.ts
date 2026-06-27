// ============================================================
// Relic — Extractive summarization algorithm (Session 3)
// ------------------------------------------------------------
// Pure functions — no Chrome APIs, no Workers, no IndexedDB.
// Imported by offscreen.ts (which supplies the embeddings) and
// tested directly in vitest.
// ============================================================

export interface SentenceSpan {
  text: string;
  /** [start, end) offsets within the input text (section-space). */
  range: [number, number];
}

// Common abbreviations that should NOT end a sentence.
const ABBREVS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'corp',
  'inc', 'ltd', 'llc', 'plc', 'co', 'dept', 'no', 'approx', 'est',
  'fig', 'eg', 'ie', 'etc', 'jan', 'feb', 'mar', 'apr', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'us', 'uk', 'eu',
  // dotted abbreviations without the dot (matched after stripping the terminal)
  'u.s', 'u.k', 'e.g', 'i.e',
]);

/**
 * Split a text string into sentence spans, tracking exact char ranges.
 * Handles common SEC filing patterns: dollar amounts, abbreviations, U.S.,
 * numbered lists, and parenthetical closings.
 *
 * @param minLen Minimum sentence length to include (default 20 chars).
 */
export function splitSentences(text: string, minLen = 20): SentenceSpan[] {
  const result: SentenceSpan[] = [];
  let segStart = 0; // start of the current sentence in `text`

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;

    // Skip closing quotes / parens that immediately follow the punctuation.
    let j = i + 1;
    while (j < text.length && /["')\]]/.test(text[j] ?? '')) j++;

    // Must be followed by whitespace (not end of string — tail is handled below).
    if (j >= text.length || !/[ \t\n\r]/.test(text[j] ?? '')) continue;

    // Advance past whitespace to find the first char of the next sentence.
    let k = j + 1;
    while (k < text.length && /[ \t\n\r]/.test(text[k] ?? '')) k++;

    // The next sentence must start with uppercase, digit, or an opening char.
    if (k >= text.length || !/[A-Z0-9"'(\[]/.test(text[k] ?? '')) continue;

    // Abbreviation guard: look back for the word that ends at position i.
    let wEnd = i;
    let wStart = i - 1;
    while (wStart >= segStart && /[a-zA-Z.]/.test(text[wStart] ?? '')) wStart--;
    wStart++;
    const rawWord = text.slice(wStart, wEnd);
    // Strip internal dots so "U.S" matches "us" in the set.
    const word = rawWord.replace(/\./g, '').toLowerCase();

    // Skip if it's a single alphabetic letter (e.g. "J. Smith") or known abbreviation.
    // An empty rawWord (preceding char is non-alpha like %, ), ]) means there IS no
    // alphabetic word — the full stop is sentence-terminal, so we do NOT skip.
    if (word.length === 1 || ABBREVS.has(word) || ABBREVS.has(rawWord.toLowerCase())) continue;

    // Also skip pure-number endings like "1." or "2." in numbered lists
    // — but let "section 3." end normally when followed by a new paragraph.
    if (/^\d+$/.test(rawWord)) continue;

    // Extract the sentence: from segStart, trimming leading whitespace.
    let sStart = segStart;
    while (sStart < i && /[ \t\n\r]/.test(text[sStart] ?? '')) sStart++;

    // Sentence ends just after the punctuation + closing chars (at position j).
    const sentence = text.slice(sStart, j).trimEnd();
    if (sentence.length >= minLen) {
      const end = sStart + sentence.length;
      result.push({ text: sentence, range: [sStart, end] });
    }

    segStart = k;
    i = k - 1; // loop will ++i
  }

  // Tail (everything after the last boundary).
  let sStart = segStart;
  while (sStart < text.length && /[ \t\n\r]/.test(text[sStart] ?? '')) sStart++;
  const tail = text.slice(sStart).trimEnd();
  if (tail.length >= minLen) {
    result.push({ text: tail, range: [sStart, sStart + tail.length] });
  }

  return result;
}

/**
 * Cosine similarity of two unit-length Float32Arrays (dot product).
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(-1, Math.min(1, dot)); // clamp for floating-point safety
}

/**
 * Rank sentences by degree centrality: sum of pairwise cosine similarities
 * to all other sentences. O(n²) — cheap for section-scale n (< 200 sentences).
 *
 * Embeddings must be unit-length (as produced by mxbai-embed-xsmall normalize:true).
 * Arrays must be parallel (spans[i] ↔ embeddings[i]).
 */
export function rankByCentrality(
  spans: readonly SentenceSpan[],
  embeddings: readonly Float32Array[],
): Array<SentenceSpan & { score: number }> {
  const n = spans.length;
  if (n === 0) return [];
  if (n === 1) return [{ ...spans[0]!, score: 1 }];

  const scores = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // ReLU: negative similarities don't contribute to centrality (standard TextRank practice).
      if (i !== j) scores[i] = (scores[i] ?? 0) + Math.max(0, cosineSim(embeddings[i]!, embeddings[j]!));
    }
  }

  // Normalize by (n - 1) so scores are in [0, 1].
  const norm = n - 1;
  return spans.map((s, i) => ({ ...s, score: (scores[i] ?? 0) / norm }));
}

/**
 * How many sentences to extract based on section text length.
 * Tuned for typical SEC section sizes.
 */
export function targetSentenceCount(textLength: number): number {
  if (textLength < 500) return 2;
  if (textLength < 2_000) return 3;
  if (textLength < 8_000) return 5;
  if (textLength < 20_000) return 7;
  return 9;
}

/**
 * Take the top-N sentences by centrality score, then re-sort by their
 * original position in the text (reading order).
 */
export function selectTopN(
  ranked: ReadonlyArray<SentenceSpan & { score: number }>,
  n: number,
): Array<SentenceSpan & { score: number }> {
  return ranked
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, n))
    .sort((a, b) => (a.range[0] ?? 0) - (b.range[0] ?? 0));
}
