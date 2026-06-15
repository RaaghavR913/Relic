// ============================================================
// FilingLens — FinBERT sentiment calibration (pure, no Chrome/Workers)
// ------------------------------------------------------------
// FinBERT's top-1 label is taken at face value, which paints boilerplate and
// legal prose with confident colour. A confidence floor pulls low-score
// positive/negative predictions back to neutral so the heatmap reflects only
// predictions the model is reasonably sure about. Tunable in one place.
// ============================================================

/**
 * Minimum top-1 probability for a positive/negative prediction to be surfaced.
 * Below this the sentence is treated as neutral (not painted).
 */
export const SENTIMENT_CONFIDENCE_FLOOR = 0.6;

/** Map a raw FinBERT label + score to a calibrated polarity. */
export function calibrateSentimentLabel(
  rawLabel: string,
  score: number,
): 'positive' | 'negative' | 'neutral' {
  const label = rawLabel === 'positive' || rawLabel === 'negative' ? rawLabel : 'neutral';
  if (label === 'neutral') return 'neutral';
  return score >= SENTIMENT_CONFIDENCE_FLOOR ? label : 'neutral';
}
