import { describe, it, expect } from 'vitest';
import { selectEvictions } from '@/lib/idbEvict';

interface Rec { id: string; cachedAt: number }
const rec = (id: string, cachedAt: number): Rec => ({ id, cachedAt });
const tsOf = (r: Rec) => r.cachedAt;
const keyOf = (r: Rec) => r.id;

describe('selectEvictions (LRU cap)', () => {
  it('returns nothing when at or under capacity', () => {
    const records = [rec('a', 1), rec('b', 2), rec('c', 3)];
    expect(selectEvictions(records, 3, tsOf, keyOf)).toEqual([]);
    expect(selectEvictions(records, 5, tsOf, keyOf)).toEqual([]);
  });

  it('evicts the oldest records beyond the cap', () => {
    const records = [rec('new', 30), rec('old', 10), rec('mid', 20)];
    // cap 1 → keep only the newest ("new"); evict the two oldest by timestamp.
    expect(selectEvictions(records, 1, tsOf, keyOf).sort()).toEqual(['mid', 'old']);
    // cap 2 → evict just the single oldest.
    expect(selectEvictions(records, 2, tsOf, keyOf)).toEqual(['old']);
  });

  it('does not mutate the input array', () => {
    const records = [rec('a', 3), rec('b', 1), rec('c', 2)];
    const snapshot = records.map((r) => r.id);
    selectEvictions(records, 1, tsOf, keyOf);
    expect(records.map((r) => r.id)).toEqual(snapshot);
  });
});
