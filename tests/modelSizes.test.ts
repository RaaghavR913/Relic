// ============================================================
// Relic — bundled model size manifest tests
// ------------------------------------------------------------
// 1. Disk truth: every manifest entry must match the bundled file
//    byte-for-byte, so a weights refresh (scripts/fetch-models.mjs) that
//    changes sizes fails loudly here instead of silently skewing the
//    model-load progress bar.
// 2. Tracker behaviour: monotonic 0..1 aggregate from `loaded` bytes;
//    indeterminate (never a fake %) for models without a manifest.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MODEL_FILE_SIZES,
  createLoadProgressTracker,
  type LoadProgressEvent,
} from '../src/workers/modelSizes';

const ROOT = process.cwd();

describe('MODEL_FILE_SIZES', () => {
  it('matches the bundled files on disk byte-for-byte', () => {
    for (const [modelId, files] of Object.entries(MODEL_FILE_SIZES)) {
      for (const [file, size] of Object.entries(files)) {
        const p = path.resolve(ROOT, 'models', modelId, file);
        expect(fs.existsSync(p), `${modelId}/${file} missing on disk`).toBe(true);
        expect(fs.statSync(p).size, `${modelId}/${file} size drifted — update MODEL_FILE_SIZES`).toBe(
          size,
        );
      }
    }
  });
});

describe('createLoadProgressTracker', () => {
  const MODEL = 'mixedbread-ai/mxbai-embed-xsmall-v1';
  const ONNX = 'onnx/model_quantized.onnx';
  const TOKENIZER = 'tokenizer.json';
  const ONNX_SIZE = MODEL_FILE_SIZES[MODEL]![ONNX]!;
  const TOKENIZER_SIZE = MODEL_FILE_SIZES[MODEL]![TOKENIZER]!;
  const TOTAL = ONNX_SIZE + TOKENIZER_SIZE;

  it('produces a monotonic 0..1 aggregate from loaded bytes across files', () => {
    const events: LoadProgressEvent[] = [];
    const track = createLoadProgressTracker(MODEL, (e) => events.push(e));

    track({ status: 'progress', file: TOKENIZER, loaded: TOKENIZER_SIZE / 2 });
    track({ status: 'progress', file: TOKENIZER, loaded: TOKENIZER_SIZE });
    track({ status: 'progress', file: ONNX, loaded: ONNX_SIZE / 2 });
    track({ status: 'progress', file: ONNX, loaded: ONNX_SIZE });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.indeterminate).toBeUndefined();
      expect(e.progress).toBeGreaterThanOrEqual(0);
      expect(e.progress).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.progress).toBeGreaterThan(events[i - 1]!.progress);
    }
    expect(events[events.length - 1]!.progress).toBeCloseTo(1, 6);
    // Halfway through the onnx file the aggregate reflects real bytes.
    const midOnnx = (TOKENIZER_SIZE + ONNX_SIZE / 2) / TOTAL;
    expect(events.some((e) => Math.abs(e.progress - midOnnx) < 1e-6)).toBe(true);
  });

  it('never walks backwards when a file restarts from zero', () => {
    const events: LoadProgressEvent[] = [];
    const track = createLoadProgressTracker(MODEL, (e) => events.push(e));
    track({ status: 'progress', file: ONNX, loaded: ONNX_SIZE });
    track({ status: 'progress', file: ONNX, loaded: 1 }); // re-fetch restarting
    const last = events[events.length - 1]!;
    expect(last.progress).toBeCloseTo(ONNX_SIZE / TOTAL, 6);
    expect(events.every((e, i) => i === 0 || e.progress >= events[i - 1]!.progress)).toBe(true);
  });

  it('clamps overshooting loaded values to the known file size', () => {
    const events: LoadProgressEvent[] = [];
    const track = createLoadProgressTracker(MODEL, (e) => events.push(e));
    track({ status: 'progress', file: ONNX, loaded: ONNX_SIZE * 10 });
    expect(events[events.length - 1]!.progress).toBeLessThanOrEqual(1);
  });

  it('ignores unknown metadata files and non-progress statuses for known models', () => {
    const emit = vi.fn();
    const track = createLoadProgressTracker(MODEL, emit);
    track({ status: 'progress', file: 'config.json', loaded: 500 });
    track({ status: 'initiate', file: ONNX });
    track({ status: 'done', file: ONNX });
    track({ file: ONNX, loaded: 100 }); // no status
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits a single indeterminate event for a model without a manifest', () => {
    const events: LoadProgressEvent[] = [];
    const track = createLoadProgressTracker('some/unknown-model', (e) => events.push(e));
    track({ status: 'progress', file: 'onnx/model.onnx', loaded: 100 });
    track({ status: 'progress', file: 'onnx/model.onnx', loaded: 200 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ progress: 0, indeterminate: true });
  });
});
