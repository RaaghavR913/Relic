/**
 * Vitest global setup — runs before every test file.
 *
 * jsdom provides the DOM environment but doesn't implement:
 *   - getComputedStyle cascading (inline styles are reflected, stylesheets are not)
 *   - CSS Custom Highlight API (CSS.highlights)
 *   - caretRangeFromPoint / caretPositionFromPoint
 *
 * We provide minimal stubs for the APIs called by positionMap.ts so tests work
 * without a real browser layout engine.
 */

// Stub CSS.highlights (CSS Custom Highlight API — Chrome 105+)
if (typeof CSS !== 'undefined' && !('highlights' in CSS)) {
  const map = new Map<string, unknown>();
  Object.defineProperty(CSS, 'highlights', {
    value: {
      set: (name: string, h: unknown) => map.set(name, h),
      get: (name: string) => map.get(name),
      delete: (name: string) => map.delete(name),
      has: (name: string) => map.has(name),
    },
    configurable: true,
  });
}

// Stub caretRangeFromPoint (not implemented in jsdom)
if (typeof document !== 'undefined' && !document.caretRangeFromPoint) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (document as any).caretRangeFromPoint = () => null;
}

// Stub globalThis.Highlight constructor (CSS Custom Highlight API)
if (typeof globalThis.Highlight === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Highlight = class Highlight {
    private ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
    add(r: Range) { this.ranges.push(r); }
    delete(r: Range) { this.ranges = this.ranges.filter(x => x !== r); }
    has(r: Range) { return this.ranges.includes(r); }
    [Symbol.iterator]() { return this.ranges[Symbol.iterator](); }
  };
}
