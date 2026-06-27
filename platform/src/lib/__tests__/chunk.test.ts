import { describe, it, expect } from 'vitest';
import { chunkArray } from '@/lib/chunk';

describe('chunkArray', () => {
  it('splits into batches of at most `size`, preserving order', () => {
    const arr = Array.from({ length: 6 }, (_, i) => i + 1); // 1..6
    expect(chunkArray(arr, 4)).toEqual([[1, 2, 3, 4], [5, 6]]);
  });

  it('mirrors the 500-cap upload case: 600 rows → [500, 100]', () => {
    const rows = Array.from({ length: 600 }, (_, i) => i);
    const batches = chunkArray(rows, 500);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(500);
    expect(batches[1]).toHaveLength(100);
    // No row is lost or duplicated.
    expect(batches.flat()).toEqual(rows);
  });

  it('returns one batch when size >= length', () => {
    expect(chunkArray([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  it('returns [] for an empty input', () => {
    expect(chunkArray([], 500)).toEqual([]);
  });

  it('handles an exact multiple (1000 / 500 → two full batches)', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    const batches = chunkArray(rows, 500);
    expect(batches.map((b) => b.length)).toEqual([500, 500]);
  });

  it('throws on a non-positive size', () => {
    expect(() => chunkArray([1], 0)).toThrow();
    expect(() => chunkArray([1], -1)).toThrow();
  });
});
