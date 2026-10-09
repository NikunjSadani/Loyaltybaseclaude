import { describe, it, expect } from 'vitest';
import { affordability, formatInr, pickFeatured, type CatalogItem } from '../employee';

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
