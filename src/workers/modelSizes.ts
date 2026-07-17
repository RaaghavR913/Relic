// ============================================================
// Relic — bundled model file sizes (build-time truth)
// ------------------------------------------------------------
// chrome-extension:// responses carry no Content-Length header, so
// Transformers.js cannot compute model-load progress itself: readResponse
// clamps `total` up to `loaded` on every chunk and reports ~100% from the
// first byte. The workers instead divide the callback's `loaded` byte count
// by these known bundled sizes. tests/modelSizes.test.ts asserts every entry
// matches the file on disk, so a weights refresh (scripts/fetch-models.mjs)
// that changes sizes fails the suite loudly instead of silently skewing the
// progress bar.
//
// Small metadata files (config.json, tokenizer_config.json) are deliberately
// omitted: unknown files simply don't contribute to the aggregate.
// ============================================================

export const MODEL_FILE_SIZES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'mixedbread-ai/mxbai-embed-xsmall-v1': {
    'onnx/model_quantized.onnx': 24_448_010,
    'tokenizer.json': 711_661,
  },
  'Xenova/finbert': {
    'onnx/model_quantized.onnx': 110_717_965,
    'tokenizer.json': 711_396,
  },
};

export interface LoadProgressEvent {
  /** Aggregate 0..1 across all known files for the model. */
  progress: number;
  /** File the triggering chunk belonged to. */
  file?: string;
  /** True when the model has no size manifest — render an indeterminate bar. */
  indeterminate?: boolean;
}

/**
 * Fold raw Transformers.js progress_callback events ({status:'progress', file,
 * loaded, …}) into a monotonic 0..1 aggregate using the known bundled sizes.
 * `emit` fires only when there is something new to report: strictly increasing
 * fractions for known models, or a single indeterminate event for a model
 * missing from the manifest — never a fake percentage.
 */
export function createLoadProgressTracker(
  modelId: string,
  emit: (e: LoadProgressEvent) => void,
): (raw: unknown) => void {
  const sizes = MODEL_FILE_SIZES[modelId];
  const total = sizes ? Object.values(sizes).reduce((a, b) => a + b, 0) : 0;
  const loadedByFile = new Map<string, number>();
  let last = -1;
  let indeterminateSent = false;

  return (raw: unknown) => {
    const p = raw as { status?: string; file?: string; loaded?: number };
    if (p.status !== 'progress') return;

    if (!sizes || total === 0) {
      if (!indeterminateSent) {
        indeterminateSent = true;
        emit({
          progress: 0,
          indeterminate: true,
          ...(typeof p.file === 'string' ? { file: p.file } : {}),
        });
      }
      return;
    }

    const file = typeof p.file === 'string' ? p.file : '';
    const size = sizes[file];
    if (size === undefined || typeof p.loaded !== 'number') return; // tiny metadata file

    // Clamp per-file to its known size and keep per-file byte counts monotonic
    // (a re-fetch restarting at 0 must not walk the bar backwards).
    loadedByFile.set(file, Math.min(size, Math.max(loadedByFile.get(file) ?? 0, p.loaded)));
    let loadedTotal = 0;
    for (const [f, l] of loadedByFile) loadedTotal += Math.min(l, sizes[f] ?? 0);

    const progress = Math.min(1, loadedTotal / total);
    if (progress > last) {
      last = progress;
      emit({ progress, file });
    }
  };
}
