import { describe, it, expect } from 'vitest';
import { formatInrCompact, formatCompact, formatInrExact, isInrUnit, formatInrWhole, formatKpiAmount, formatKpiSoFar, formatInrPaise } from '@/lib/format-inr';

describe('formatInrPaise (whole rupees stay whole; paise always 2 dp)', () => {
  it('formats', () => {
    expect(formatInrPaise(1500)).toBe('₹1,500');
    expect(formatInrPaise(1500.5)).toBe('₹1,500.50');
    expect(formatInrPaise(1234567.125)).toBe('₹12,34,567.13');
    expect(formatInrPaise(-10.25)).toBe('-₹10.25');
    expect(formatInrPaise(-0)).toBe('₹0');
    expect(formatInrPaise(NaN)).toBe('₹0');
  });
});

describe('formatCompact (no ₹ symbol — paired achieved/target displays)', () => {
  it('matches the compact scale without the ₹ prefix', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(582)).toBe('582');
    expect(formatCompact(1_000)).toBe('1K');
    expect(formatCompact(5_200)).toBe('5.2K');
    expect(formatCompact(5_80_000)).toBe('5.8L');
    expect(formatCompact(1_23_00_000)).toBe('1.23Cr');
    expect(formatCompact(-5_200)).toBe('-5.2K');
    expect(formatCompact(Number.NaN)).toBe('0');
  });
});

describe('formatInrCompact', () => {
  it('< 1,000 → exact integer, no decimals', () => {
    expect(formatInrCompact(0)).toBe('₹0');
    expect(formatInrCompact(1)).toBe('₹1');
    expect(formatInrCompact(582)).toBe('₹582');
    expect(formatInrCompact(999)).toBe('₹999');        // upper boundary of the exact band
  });

  it('1,000 – 99,999 → thousands with 1 dp, trailing .0 trimmed', () => {
    expect(formatInrCompact(1_000)).toBe('₹1K');        // 1.0 → trimmed; lower boundary
    expect(formatInrCompact(5_200)).toBe('₹5.2K');
    expect(formatInrCompact(58_200)).toBe('₹58.2K');
    expect(formatInrCompact(5_000)).toBe('₹5K');        // trailing .0 trimmed
    expect(formatInrCompact(99_999)).toBe('₹100K');     // upper boundary (99.999 → 100.0 → 100)
  });

  it('1,00,000 – 99,99,999 → lakhs with 1 dp, trailing .0 trimmed', () => {
    expect(formatInrCompact(1_00_000)).toBe('₹1L');     // lower boundary
    expect(formatInrCompact(5_80_000)).toBe('₹5.8L');
    expect(formatInrCompact(58_20_000)).toBe('₹58.2L');
    expect(formatInrCompact(10_00_000)).toBe('₹10L');   // trailing .0 trimmed
    expect(formatInrCompact(99_99_999)).toBe('₹100L');  // upper boundary (99.99999 → 100.0 → 100)
  });

  it('≥ 1,00,00,000 → crores with 2 dp, trailing zeros trimmed', () => {
    expect(formatInrCompact(1_00_00_000)).toBe('₹1Cr'); // lower boundary, 1.00 → 1
    expect(formatInrCompact(1_23_00_000)).toBe('₹1.23Cr');
    expect(formatInrCompact(1_20_00_000)).toBe('₹1.2Cr'); // 1.20 → 1.2
    expect(formatInrCompact(12_34_56_789)).toBe('₹12.35Cr');
  });

  it('handles the exact band/boundary crossings', () => {
    // 999 (exact) vs 1000 (K)
    expect(formatInrCompact(999)).toBe('₹999');
    expect(formatInrCompact(1_000)).toBe('₹1K');
    // 99,999 (K) vs 1,00,000 (L)
    expect(formatInrCompact(99_999)).toBe('₹100K');
    expect(formatInrCompact(1_00_000)).toBe('₹1L');
    // 99,99,999 (L) vs 1,00,00,000 (Cr)
    expect(formatInrCompact(99_99_999)).toBe('₹100L');
    expect(formatInrCompact(1_00_00_000)).toBe('₹1Cr');
  });

  it('prefixes negatives with -', () => {
    expect(formatInrCompact(-582)).toBe('-₹582');
    expect(formatInrCompact(-5_200)).toBe('-₹5.2K');
    expect(formatInrCompact(-5_80_000)).toBe('-₹5.8L');
    expect(formatInrCompact(-1_23_00_000)).toBe('-₹1.23Cr');
  });

  it('non-finite / NaN → ₹0', () => {
    expect(formatInrCompact(NaN)).toBe('₹0');
    expect(formatInrCompact(Infinity)).toBe('₹0');
    expect(formatInrCompact(-Infinity)).toBe('₹0');
  });
});

describe('formatInrExact', () => {
  it('renders full en-IN grouping with a ₹ prefix', () => {
    expect(formatInrExact(0)).toBe('₹0');
    expect(formatInrExact(582)).toBe('₹582');
    expect(formatInrExact(1_20_000)).toBe('₹1,20,000');
    expect(formatInrExact(1_23_45_678)).toBe('₹1,23,45,678');
  });

  it('non-finite / NaN → ₹0', () => {
    expect(formatInrExact(NaN)).toBe('₹0');
    expect(formatInrExact(Infinity)).toBe('₹0');
  });
});

describe('isInrUnit', () => {
  it('true for currency units (case/space-insensitive)', () => {
    expect(isInrUnit('INR')).toBe(true);
    expect(isInrUnit('inr')).toBe(true);
    expect(isInrUnit(' INR ')).toBe(true);
    expect(isInrUnit('₹')).toBe(true);
    expect(isInrUnit('Rs')).toBe(true);
    expect(isInrUnit('Rupees')).toBe(true);
  });

  it('false for non-currency / empty / nullish units', () => {
    expect(isInrUnit('Litre')).toBe(false);
    expect(isInrUnit('Unit')).toBe(false);
    expect(isInrUnit('outlets')).toBe(false);
    expect(isInrUnit('')).toBe(false);
    expect(isInrUnit(undefined)).toBe(false);
    expect(isInrUnit(null)).toBe(false);
  });
});

describe('formatInrWhole (Targets page Achieved/Target for INR KPIs)', () => {
  it('rounds to whole rupees with Indian grouping; sign before ₹; never -₹0', () => {
    expect(formatInrWhole(10414.4)).toBe('₹10,414');
    expect(formatInrWhole(10000)).toBe('₹10,000');
    expect(formatInrWhole(250000)).toBe('₹2,50,000');
    expect(formatInrWhole(999.5)).toBe('₹1,000');
    expect(formatInrWhole(-1500.2)).toBe('-₹1,500');
    expect(formatInrWhole(-0.4)).toBe('₹0');
    expect(formatInrWhole(0)).toBe('₹0');
    expect(formatInrWhole(Number.NaN)).toBe('₹0');
  });
});

describe('formatKpiAmount / formatKpiSoFar (no-target KPI figures)', () => {
  it('compact ₹ for INR, en-IN + unit otherwise; null → "—"', () => {
    expect(formatKpiAmount(2755.12, 'INR')).toBe('₹2.8K');
    expect(formatKpiAmount(-1500, 'INR')).toBe('-₹1.5K');
    expect(formatKpiAmount(-0.3, 'INR')).toBe('₹0');
    expect(formatKpiAmount(2755.12, 'cases')).toBe('2,755.1 cases');
    expect(formatKpiSoFar(2755.12, 'INR')).toBe('₹2.8K so far');
    expect(formatKpiSoFar(null, 'INR')).toBe('—');
    expect(formatKpiSoFar(undefined, 'INR')).toBe('—');
  });
});
