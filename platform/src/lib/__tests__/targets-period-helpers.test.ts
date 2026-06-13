/// <reference types="vitest/globals" />
/**
 * TPH — targets.ts period helpers
 *
 * TPH1: currentPeriod() returns a string matching YYYY-MM for today's date
 * TPH2: currentPeriod() is consistent with new Date() month/year
 * TPH3: getPrimarySchemeTarget returns first entry with targetValue > 0
 * TPH4: getPrimarySchemeTarget falls back to targets[0] when all targetValues are 0
 * TPH5: getPrimarySchemeTarget returns null for an empty array
 */

import { describe, it, expect } from 'vitest';
import { currentPeriod, getPrimarySchemeTarget } from '@/lib/targets';

describe('TPH — currentPeriod()', () => {
  it('TPH1: returns a string in YYYY-MM format', () => {
    const result = currentPeriod();
    expect(result).toMatch(/^\d{4}-\d{2}$/);
  });

  it('TPH2: matches today\'s year and month', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(currentPeriod()).toBe(expected);
  });
});

describe('TPH — getPrimarySchemeTarget()', () => {
  it('TPH3: returns first entry with targetValue > 0', () => {
    const targets = [
      { id: 'a', targetValue: 0, achievedValue: 0 },
      { id: 'b', targetValue: 100, achievedValue: 50 },
      { id: 'c', targetValue: 200, achievedValue: 80 },
    ];
    const result = getPrimarySchemeTarget(targets);
    expect(result?.id).toBe('b');
  });

  it('TPH4: falls back to targets[0] when all targetValues are 0', () => {
    const targets = [
      { id: 'x', targetValue: 0, achievedValue: 10 },
      { id: 'y', targetValue: 0, achievedValue: 20 },
    ];
    const result = getPrimarySchemeTarget(targets);
    expect(result?.id).toBe('x');
  });

  it('TPH5: returns null for an empty array', () => {
    expect(getPrimarySchemeTarget([])).toBeNull();
  });
});
