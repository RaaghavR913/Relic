import { describe, it, expect } from 'vitest';
import { getBackendTuning } from '../src/offscreen/backendTuning';

describe('getBackendTuning', () => {
  it('preserves historical WASM low-memory defaults', () => {
    expect(getBackendTuning(true, 'wasm')).toEqual({
      embedBatch: 16,
      embedConcurrency: 1,
      classifyBatch: 4,
      classifyConcurrency: 1,
    });
  });

  it('preserves historical WASM normal-memory defaults', () => {
    expect(getBackendTuning(false, 'wasm')).toEqual({
      embedBatch: 32,
      embedConcurrency: 2,
      classifyBatch: 8,
      classifyConcurrency: 1,
    });
  });

  it('uses larger batches on WebGPU low-memory', () => {
    expect(getBackendTuning(true, 'webgpu')).toEqual({
      embedBatch: 32,
      embedConcurrency: 1,
      classifyBatch: 8,
      classifyConcurrency: 1,
    });
  });

  it('uses largest batches + dual classify lanes on WebGPU normal memory', () => {
    expect(getBackendTuning(false, 'webgpu')).toEqual({
      embedBatch: 48,
      embedConcurrency: 2,
      classifyBatch: 16,
      classifyConcurrency: 2,
    });
  });
});
