import { describe, it, expect } from 'vitest';
import {
  affordability,
  formatInr,
  pickFeatured,
  formatContestDateRange,
  contestStatusBadge,
  pct,
  forecastFromRate,
  daysLate,
  onTimeBadge,
  addMonths,
  formatMonthYear,
  mapCatalogItem,
  mapDream,
  type CatalogItem,
  type ApiEmployeeDream,
} from '../employee';

const DAY_MS = 24 * 60 * 60 * 1000;

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
    featured: false,
    dreamEligible: false,
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

describe('mapCatalogItem (Wave 4 featured / dreamEligible)', () => {
  it('maps the new flags, defaulting missing ones to false', () => {
    const on = mapCatalogItem({ id: 'a', name: 'A', pointsCost: 10, featured: true, dreamEligible: true });
    expect(on.featured).toBe(true);
    expect(on.dreamEligible).toBe(true);
    const off = mapCatalogItem({ id: 'b', name: 'B', pointsCost: 10 });
    expect(off.featured).toBe(false);
    expect(off.dreamEligible).toBe(false);
  });
});

describe('pct', () => {
  it('rounds a ratio to an integer percent', () => {
    expect(pct(1, 4)).toBe(25);
    expect(pct(1, 3)).toBe(33);
  });

  it('saturates at 100 when a >= b and floors at 0', () => {
    expect(pct(500, 500)).toBe(100);
    expect(pct(900, 500)).toBe(100);
    expect(pct(0, 500)).toBe(0);
  });

  it('returns 0 for a non-positive / non-finite denominator', () => {
    expect(pct(10, 0)).toBe(0);
    expect(pct(10, -5)).toBe(0);
    expect(pct(Number.NaN, 5)).toBe(0);
  });
});

describe('forecastFromRate', () => {
  // A fixed reference instant passed in explicitly — deterministic, and the assertions
  // are computed RELATIVE to it (no hardcoded absolute future date).
  const from = new Date('2026-05-01T06:00:00Z');

  it('projects from + ceil(remaining / rate * 30) days', () => {
    // 10000 remaining at 5000/mo → 2 months → 60 days.
    const out = forecastFromRate(10000, 5000, from);
    expect(out).not.toBeNull();
    expect(out!.getTime()).toBe(from.getTime() + 60 * DAY_MS);
  });

  it('rounds partial months UP to whole days', () => {
    // 5000 at 3000/mo → 1.667 months → 50 days exactly.
    const out = forecastFromRate(5000, 3000, from);
    expect(out!.getTime()).toBe(from.getTime() + 50 * DAY_MS);
    // 1 point at 3000/mo → ceil(0.01) = 1 day.
    const tiny = forecastFromRate(1, 3000, from);
    expect(tiny!.getTime()).toBe(from.getTime() + 1 * DAY_MS);
  });

  it('returns today when nothing remains (already reached)', () => {
    expect(forecastFromRate(0, 5000, from)!.getTime()).toBe(from.getTime());
    expect(forecastFromRate(-100, 5000, from)!.getTime()).toBe(from.getTime());
  });

  it('returns null when the rate is non-positive / non-finite (not forecastable)', () => {
    expect(forecastFromRate(10000, 0, from)).toBeNull();
    expect(forecastFromRate(10000, -1, from)).toBeNull();
    expect(forecastFromRate(10000, Number.NaN, from)).toBeNull();
  });

  it('does not mutate the passed-in `from`', () => {
    const snapshot = from.getTime();
    forecastFromRate(10000, 5000, from);
    expect(from.getTime()).toBe(snapshot);
  });
});

describe('daysLate / onTimeBadge', () => {
  const base = new Date('2026-05-01T00:00:00Z');

  it('is 0 / on-time when projected is on or before target', () => {
    const target = new Date(base.getTime() + 30 * DAY_MS);
    const projected = new Date(base.getTime() + 20 * DAY_MS);
    expect(daysLate(projected, target)).toBe(0);
    expect(onTimeBadge(projected, target)).toEqual({ onTime: true, daysLate: 0 });
    expect(daysLate(target, target)).toBe(0);
  });

  it('counts whole days when projected overshoots the target', () => {
    const target = new Date(base.getTime() + 30 * DAY_MS);
    const projected = new Date(base.getTime() + 37 * DAY_MS);
    expect(daysLate(projected, target)).toBe(7);
    expect(onTimeBadge(projected, target)).toEqual({ onTime: false, daysLate: 7 });
  });

  it('reads as on-time when either side is null (cannot judge)', () => {
    expect(daysLate(null, base)).toBe(0);
    expect(daysLate(base, null)).toBe(0);
    expect(onTimeBadge(null, base)).toEqual({ onTime: true, daysLate: 0 });
  });
});

describe('addMonths', () => {
  it('adds whole months without mutating the input', () => {
    const from = new Date('2026-05-10T00:00:00Z');
    const snapshot = from.getTime();
    const out = addMonths(from, 2);
    // Compare IST calendar month key rather than an absolute string (tz-robust).
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(out);
    expect(key).toBe('2026-07');
    expect(from.getTime()).toBe(snapshot);
  });
});

describe('formatMonthYear', () => {
  it('formats an instant as "Mon YYYY" in IST', () => {
    expect(formatMonthYear('2026-11-15T12:00:00Z')).toBe('Nov 2026');
  });

  it('returns empty for a missing / invalid date', () => {
    expect(formatMonthYear(null)).toBe('');
    expect(formatMonthYear('not-a-date')).toBe('');
  });
});

describe('mapDream', () => {
  const apiBase: ApiEmployeeDream = {
    dreamReward: { id: 'r1', name: 'Dream TV', imageUrl: null, pointsCost: 50000 },
    pointsRequired: 50000,
    pointsRemaining: 30000,
    redeemablePoints: 20000,
    monthlyEarnRate: 5000,
    forecastDate: '2026-11-01T00:00:00Z',
    reached: false,
  };

  it('maps the resolved dream and preserves a null forecastDate', () => {
    const d = mapDream({ ...apiBase, forecastDate: null });
    expect(d.reward?.id).toBe('r1');
    expect(d.forecastDate).toBeNull();
    expect(d.reached).toBe(false);
  });

  it('keeps a null dream when none is chosen', () => {
    const d = mapDream({ ...apiBase, dreamReward: null });
    expect(d.reward).toBeNull();
  });

  it('clamps negative / NaN point fields to a safe zero', () => {
    const d = mapDream({ ...apiBase, pointsRemaining: -10, monthlyEarnRate: Number.NaN });
    expect(d.pointsRemaining).toBe(0);
    expect(d.monthlyEarnRate).toBe(0);
  });
});
