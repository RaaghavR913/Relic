// ============================================================
// Relic — Semantic excerpt reranking for the LM stages
// ------------------------------------------------------------
// selectRelevantText() (relevance.ts) ranks candidate sentences by keyword
// match alone, so unusual phrasing (a filing that says "top-line" instead of
// "revenue") can make a stage miss the passage an analyst would actually cite.
// This blends the keyword score with cosine similarity to a per-dimension
// query embedding, computed via the on-device encoder the redline/summarizer
// paths already use (offscreen document → encoder worker, EMBED_TEXTS).
//
// Cost control: the candidate pool (top-N by keyword score across every
// dimension) is embedded ONCE per pipeline run and reused for every stage;
// each dimension's short query string is embedded once and cached too.
//
// FAILS SOFT: whenever the embedder is unavailable (no offscreen document, no
// encoder, a dropped message, an error) this returns the plain keyword-only
// ranking from relevance.ts. The pipeline's render-on-frame-one guarantee must
// never depend on embeddings being available.
// ============================================================

import type { DocumentModel } from '@/types';
import { cosineSim } from '@/summarizer/extractive';
import {
  scoreSentences,
  selectRelevantText,
  packSentencesByBudget,
  KEYWORDS,
  keywordsFor,
  type Dimension,
  type ScoredSentence,
} from './relevance';

type Dim = Exclude<Dimension, 'overview'>;

const ALL_DIMS = Object.keys(KEYWORDS) as Dim[];

/** Top-N keyword-scored sentences embedded once and reused across every dimension. */
const CANDIDATE_CAP = 200;

/** Keyword score is roughly 0–5 (2 per matched dim + 2 numeric + 1 priority); used to normalize into 0..1 for blending. */
const MAX_KEYWORD_SCORE = 5;

/** Short natural-language description of what each dimension is looking for. */
const DIMENSION_QUERIES: Record<Dim, string> = {
  revenue: 'Revenue growth, sales trends, bookings, pricing, and volume.',
  margins: 'Gross margin, operating margin, profitability, and cost trends.',
  cashflow: 'Operating cash flow, free cash flow, capital expenditures, and liquidity.',
  balancesheet: 'Debt, leverage, liabilities, covenants, and balance sheet strength.',
  shares: 'Share buybacks, dividends, dilution, and shares outstanding.',
  risk: 'Business risks, uncertainties, litigation, competition, and regulatory exposure.',
  management: "Management's outlook, guidance, and strategic commentary.",
};

/** Injectable embedding call — resolves to `null` (not throws) when unavailable. */
export type Embedder = (texts: string[]) => Promise<Float32Array[] | null>;

interface EmbeddedCandidate {
  sentence: ScoredSentence;
  vector: Float32Array;
}

/**
 * Per-pipeline-run cache: embeds the shared candidate pool and each
 * dimension's query string at most once, then reranks each stage's excerpt
 * selection against those cached vectors.
 */
export class SemanticExcerptSelector {
  private readonly embed: Embedder;
  private pool: Promise<EmbeddedCandidate[] | null> | null = null;
  private readonly queryVectors = new Map<Dim, Promise<Float32Array | null>>();

  constructor(embed: Embedder) {
    this.embed = embed;
  }

  private candidatePool(doc: DocumentModel): Promise<EmbeddedCandidate[] | null> {
    if (!this.pool) {
      this.pool = (async () => {
        const candidates = scoreSentences(doc, ALL_DIMS).slice(0, CANDIDATE_CAP);
        if (candidates.length === 0) return [];
        let vectors: Float32Array[] | null;
        try {
          vectors = await this.embed(candidates.map((c) => c.text));
        } catch {
          vectors = null;
        }
        if (!vectors || vectors.length !== candidates.length) return null;
        return candidates.map((sentence, i) => ({ sentence, vector: vectors![i]! }));
      })();
    }
    return this.pool;
  }

  private queryVector(dim: Dim): Promise<Float32Array | null> {
    let cached = this.queryVectors.get(dim);
    if (!cached) {
      cached = (async () => {
        try {
          const vectors = await this.embed([DIMENSION_QUERIES[dim]]);
          return vectors?.[0] ?? null;
        } catch {
          return null;
        }
      })();
      this.queryVectors.set(dim, cached);
    }
    return cached;
  }

  /**
   * Semantic-reranked excerpt selection for one or more dimensions (~50/50
   * keyword/cosine blend). Falls back to selectRelevantText()'s pure keyword
   * ranking whenever embeddings are unavailable for this run or this dimension.
   */
  async select(
    doc: DocumentModel,
    dims: ReadonlyArray<Dim>,
    maxChars: number,
  ): Promise<string> {
    const pool = await this.candidatePool(doc);
    if (pool === null || pool.length === 0) return selectRelevantText(doc, dims, maxChars);

    const queryVectors = (await Promise.all(dims.map((d) => this.queryVector(d)))).filter(
      (v): v is Float32Array => v !== null,
    );
    if (queryVectors.length === 0) return selectRelevantText(doc, dims, maxChars);

    // Form-merged keyword set: sentences that entered the pool via a form
    // supplement (e.g. proxy comp terms) must survive this filter too.
    const kw = keywordsFor(doc.filingType);
    const relevant = pool.filter(({ sentence }) => dims.some((d) => kw[d].test(sentence.text)));
    if (relevant.length === 0) return '';

    const blended: ScoredSentence[] = relevant.map(({ sentence, vector }) => {
      const keywordNorm = Math.min(1, sentence.score / MAX_KEYWORD_SCORE);
      const sims = queryVectors.map((q) => cosineSim(vector, q));
      const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;
      const simNorm = (avgSim + 1) / 2; // cosine [-1,1] → [0,1]
      return { ...sentence, score: 0.5 * keywordNorm + 0.5 * simNorm };
    });

    blended.sort((a, b) => b.score - a.score || a.order - b.order);
    return packSentencesByBudget(blended, maxChars);
  }
}
