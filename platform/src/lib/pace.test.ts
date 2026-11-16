import { describe, it, expect } from 'vitest';
import { buildCasesToGoMsg, classifyPaceGap, fmtKpiNum, fmtRemaining, remainingOf } from './pace';

describe('buildCasesToGoMsg', () => {
  it('shows remaining units and days left — behind pace', () => {
    expect(buildCasesToGoMsg(190, 'cases', 0)).toBe('190 cases to go · 0 days left');
  });

  it('shows zero remaining when on pace', () => {
    expect(buildCasesToGoMsg(0, 'cases', 24)).toBe('0 cases to go · 24 days left');
  });

  it('singularises "day" when daysLeft is 1', () => {
    expect(buildCasesToGoMsg(50, 'cases', 1)).toBe('50 cases to go · 1 day left');
  });

  it('works with non-cases units', () => {
    expect(buildCasesToGoMsg(3, 'SKUs', 10)).toBe('3 SKUs to go · 10 days left');
  });

  it('rounds a fractional INR remainder UP to a whole number with Indian grouping (prod 2026-11-16)', () => {
    expect(buildCasesToGoMsg(674971.2084833332, 'INR', 14)).toBe('6,74,972 INR to go · 14 days left');
  });
});

describe('fmtRemaining', () => {
  it('whole, Indian-grouped, rounded up; never "0" while something remains', () => {
    expect(fmtRemaining(674971.2084833332)).toBe('6,74,972');
    expect(fmtRemaining(12345678)).toBe('1,23,45,678');
    expect(fmtRemaining(400)).toBe('400');
    expect(fmtRemaining(4.0001)).toBe('5');
    expect(fmtRemaining(0.2)).toBe('1');
  });
  it('0 / negative / NaN / Infinity → "0"', () => {
    for (const v of [0, -5, NaN, Infinity]) expect(fmtRemaining(v)).toBe('0');
  });
});

describe('remainingOf', () => {
  it('target − achieved, never negative; float noise on a met target snaps to 0', () => {
    expect(remainingOf(1000, 400)).toBe(600);
    expect(remainingOf(100, 150)).toBe(0);
    expect(remainingOf(0.3, 0.1 + 0.2)).toBe(0);
    expect(remainingOf(1349942.4166666667, 674971.2081833335)).toBeCloseTo(674971.2084833332, 6);
    expect(remainingOf(10, 9.5)).toBe(0.5);
    // a REAL ₹49 shortfall on a ₹5 Cr aggregate is never snapped to met
    expect(remainingOf(50_000_000, 49_999_951)).toBe(49);
    expect(remainingOf(1, 0.99)).toBeCloseTo(0.01, 6);
  });
});

describe('fmtKpiNum', () => {
  it('INR → whole rupees grouped; other units ≤2 dp grouped; non-finite → 0', () => {
    expect(fmtKpiNum(1349942.4167, 'INR')).toBe('13,49,942');
    expect(fmtKpiNum(1000, 'INR')).toBe('1,000');
    expect(fmtKpiNum(12.4999999, 'Litre')).toBe('12.5');
    expect(fmtKpiNum(800, 'cases')).toBe('800');
    expect(fmtKpiNum(NaN, 'cases')).toBe('0');
  });
});

describe('classifyPaceGap — relative amber threshold', () => {
  // User spec: 40% time elapsed, threshold=10 → amber zone is 36%–39.99% achievement
  // i.e. gap (timePct − achievedPct) of 0.01–4.00 pp is amber (4 = 40 × 0.10)

  it('returns green when exactly on pace (gap = 0)', () => {
    expect(classifyPaceGap(0, 40, 10)).toBe('green');
  });

  it('returns green when ahead of pace (gap < 0)', () => {
    expect(classifyPaceGap(-5, 40, 10)).toBe('green');
  });

  it('returns amber when gap is at the boundary (gap = timePct × threshold/100)', () => {
    // 40 × 0.10 = 4 pp → amber
    expect(classifyPaceGap(4, 40, 10)).toBe('amber');
  });

  it('returns amber when gap is within threshold', () => {
    expect(classifyPaceGap(1, 40, 10)).toBe('amber');
    expect(classifyPaceGap(3, 40, 10)).toBe('amber');
  });

  it('returns red when gap exceeds threshold', () => {
    // 4.01 pp > 40 × 0.10 = 4 → red
    expect(classifyPaceGap(5,  40, 10)).toBe('red');
    expect(classifyPaceGap(20, 40, 10)).toBe('red');
  });

  it('scales with timePct — later in month amber zone widens', () => {
    // 80% elapsed, threshold 10 → amber if gap ≤ 8 pp
    expect(classifyPaceGap(8,  80, 10)).toBe('amber');
    expect(classifyPaceGap(9,  80, 10)).toBe('red');
  });

  it('honours a custom threshold (old default was 15)', () => {
    // 40% elapsed, threshold 15 → amber if gap ≤ 6 pp
    expect(classifyPaceGap(6,  40, 15)).toBe('amber');
    expect(classifyPaceGap(7,  40, 15)).toBe('red');
  });
});
