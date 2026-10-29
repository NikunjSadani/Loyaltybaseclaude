import { derivePointsCost } from './derive-points-cost.helper';

describe('derivePointsCost (shared ₹→points helper)', () => {
  it('points = round(sellingValue/100 × rate)', () => {
    expect(derivePointsCost(50000, 1)).toBe(500); // ₹500 × 1
    expect(derivePointsCost(50000, 2)).toBe(1000); // ₹500 × 2
    expect(derivePointsCost(20000, 3)).toBe(600); // ₹200 × 3
  });

  it('rounds to the nearest point', () => {
    expect(derivePointsCost(33300, 1.5)).toBe(500); // round(333 × 1.5 = 499.5)
  });

  it('a missing / non-positive rate yields 0 (caller treats 0 as "cannot price yet")', () => {
    expect(derivePointsCost(50000, 0)).toBe(0);
    expect(derivePointsCost(50000, -1)).toBe(0);
    expect(derivePointsCost(50000, NaN)).toBe(0);
  });
});
