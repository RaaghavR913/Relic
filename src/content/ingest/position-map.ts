/**
 * PositionMap wrapper for the ingest pipeline.
 * DomPositionMap is the class-based façade that satisfies the PositionMap interface.
 */

import { buildPositionMap } from '../positionMap.js';
import { toDocRange as liftToDocRange } from '../../lib/docRange.js';
import type { BuildResult, PositionMap, Section, Segment } from '../../types/index.js';

export class DomPositionMap implements PositionMap {
  text = '';
  segments: ReadonlyArray<Segment> = [];

  private _inner!: PositionMap;
  private _tableRanges: Array<[number, number]> = [];

  constructor(root: Element | Document) {
    this._ingest(root);
  }

  private _ingest(root: Element | Document): void {
    const { positionMap, tableRanges } = buildPositionMap(root);
    this._inner = positionMap;
    this._tableRanges = tableRanges as Array<[number, number]>;
    this.text = positionMap.text;
    this.segments = positionMap.segments;
  }

  getTableRanges(): ReadonlyArray<[number, number]> {
    return this._tableRanges;
  }

  toDomRange(range: [number, number]): Range | null {
    return this._inner.toDomRange(range);
  }

  toClientRects(range: [number, number]): DOMRect[] {
    return this._inner.toClientRects(range);
  }

  fromNode(node: Text, offset: number): number | null {
    return this._inner.fromNode(node, offset);
  }

  fromPoint(x: number, y: number): number | null {
    return this._inner.fromPoint(x, y);
  }

  toDocRange(base: Section | number, range: [number, number]): [number, number] {
    return liftToDocRange(base, range);
  }

  rebuild(root: Element | Document): PositionMap {
    this._ingest(root);
    return this;
  }
}

export function buildNormalizedText(root: Element | Document): BuildResult {
  const pm = new DomPositionMap(root);
  return { positionMap: pm, tableRanges: pm.getTableRanges() };
}
