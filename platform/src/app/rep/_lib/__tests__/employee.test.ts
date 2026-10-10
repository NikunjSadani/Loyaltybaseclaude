import { describe, it, expect } from 'vitest';
import {
  affordability,
  formatInr,
  pickFeatured,
  formatContestDateRange,
  contestStatusBadge,
  type CatalogItem,
} from '../employee';

function item(over: Partial<CatalogItem>): CatalogItem {
  return {
    id: over.id ?? 'x',
    code: '',
    name: 'Item',
    description: '',
    category: 'Rewards',
    imageUrl: null,
    pointsCost: over.pointsCost ?? 100,
    redemptionMode: 'PHYSICAL_GIFT',
    isAffordable: over.isAffordable ?? false,
    requiresConsent: false,
    inStock: over.inStock ?? true,
    ...over,
  };
}

describe('affordability', () => {
  it('affordable when balance >= cost, zero shortfall', () => {
    expect(affordability(500, 300)).toEqual({ affordable: true, shortfall: 0 });
    expect(affordability(300, 300)).toEqual({ affordable: true, shortfall: 0 });
  });

  it('not affordable returns the point shortfall', () => {
    expect(affordability(120, 500)).toEqual({ affordable: false, shortfall: 380 });
  });

  it('clamps negative / NaN inputs to a safe zero', () => {
    expect(affordability(-10, 50)).toEqual({ affordable: false, shortfall: 50 });
    expect(affordability(Number.NaN, Number.NaN)).toEqual({ affordable: true, shortfall: 0 });
  });
});

describe('formatInr', () => {
  it('formats with the Indian grouping and a ₹ prefix', () => {
    expect(formatInr(1234567)).toBe('₹12,34,567');
    expect(formatInr(0)).toBe('₹0');
  });

  it('rounds fractional values', () => {
    expect(formatInr(99.6)).toBe('₹100');
  });
});

describe('pickFeatured', () => {
  it('affordable items first (priciest affordable), then nearest-reach aspirational', () => {
    const items = [
      item({ id: 'cheap-aff', pointsCost: 50, isAffordable: true }),
      item({ id: 'pricey-aff', pointsCost: 200, isAffordable: true }),
      item({ id: 'far', pointsCost: 900, isAffordable: false }),
      item({ id: 'near', pointsCost: 400, isAffordable: false }),
    ];
    const ids = pickFeatured(items).map((i) => i.id);
    expect(ids).toEqual(['pricey-aff', 'cheap-aff', 'near', 'far']);
  });

  it('excludes out-of-stock items and respects the limit', () => {
    const items = [
      item({ id: 'a', pointsCost: 10, isAffordable: true }),
      item({ id: 'oos', pointsCost: 20, isAffordable: true, inStock: false }),
      item({ id: 'b', pointsCost: 30, isAffordable: true }),
    ];
    const ids = pickFeatured(items, 1).map((i) => i.id);
    expect(ids).toEqual(['b']); // priciest affordable in-stock, limited to 1
    expect(pickFeatured(items).map((i) => i.id)).not.toContain('oos');
  });
});

describe('formatContestDateRange', () => {
  // Midday-UTC instants so the IST (UTC+5:30) calendar day is unambiguous.
  it('collapses a same-month range to one month + year', () => {
    expect(
      formatContestDateRange('2026-11-01T12:00:00Z', '2026-11-30T12:00:00Z'),
    ).toBe('1 – 30 Nov 2026');
  });

  it('keeps both months but shares the year within a year', () => {
    expect(
      formatContestDateRange('2026-11-01T12:00:00Z', '2026-12-05T12:00:00Z'),
    ).toBe('1 Nov – 5 Dec 2026');
  });

  it('shows both years when the range spans a year boundary', () => {
    expect(
      formatContestDateRange('2026-12-20T12:00:00Z', '2027-01-05T12:00:00Z'),
    ).toBe('20 Dec 2026 – 5 Jan 2027');
  });

  it('returns empty when both ends are missing/invalid, and a single date when one is', () => {
    expect(formatContestDateRange('not-a-date', 'also-bad')).toBe('');
    expect(formatContestDateRange('2026-11-01T12:00:00Z', 'bad')).toBe('1 Nov 2026');
    expect(formatContestDateRange('bad', '2026-11-30T12:00:00Z')).toBe('30 Nov 2026');
  });
});

describe('contestStatusBadge', () => {
  it('maps SCHEDULED to an Upcoming/info badge', () => {
    expect(contestStatusBadge('SCHEDULED')).toEqual({ label: 'Upcoming', variant: 'info' });
  });

  it('maps ACTIVE (and anything unrecognised) to a Live/success badge', () => {
    expect(contestStatusBadge('ACTIVE')).toEqual({ label: 'Live', variant: 'success' });
    expect(contestStatusBadge('WHATEVER')).toEqual({ label: 'Live', variant: 'success' });
  });
});
