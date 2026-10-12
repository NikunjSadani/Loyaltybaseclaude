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
  clampPercent,
  trendMeta,
  sortByAchievement,
  teamChartMax,
  mapTeam,
  type CatalogItem,
  type ApiEmployeeDream,
  type ApiTeamMember,
  type ApiTeamResponse,
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

/* ─── Team manager-rollup helpers ───────────────────────────────────────────── */

function member(over: Partial<ApiTeamMember>): ApiTeamMember {
  return {
    salesUserId: over.salesUserId ?? 'm',
    name: over.name ?? 'Member',
    employeeCode: over.employeeCode ?? 'E1',
    roleName: over.roleName ?? 'SALES_OFFICER',
    region: over.region ?? 'West',
    isManager: over.isManager ?? false,
    directReportCount: over.directReportCount ?? 0,
    teamSize: over.teamSize ?? 0,
    pointsBalance: over.pointsBalance ?? 0,
    earnedThisMonth: over.earnedThisMonth ?? 0,
    redeemedThisMonth: over.redeemedThisMonth ?? 0,
    targetPoints: over.targetPoints ?? null,
    achievedPct: over.achievedPct ?? null,
    trend: over.trend ?? 'flat',
    ...over,
  };
}

describe('clampPercent', () => {
  it('rounds and clamps a percent to an integer 0–100', () => {
    expect(clampPercent(42.6)).toBe(43);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(100)).toBe(100);
  });

  it('floors negatives at 0 and saturates above 100', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });

  it('treats null / undefined / NaN as 0', () => {
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('trendMeta', () => {
  it('maps up / down to the matching direction + tone', () => {
    expect(trendMeta('up')).toEqual({ direction: 'up', label: 'Trending up', tone: 'up' });
    expect(trendMeta('down')).toEqual({ direction: 'down', label: 'Trending down', tone: 'down' });
  });

  it('maps flat and anything unrecognised to a steady/flat trend', () => {
    expect(trendMeta('flat')).toEqual({ direction: 'flat', label: 'Steady', tone: 'flat' });
    expect(trendMeta('garbage')).toEqual({ direction: 'flat', label: 'Steady', tone: 'flat' });
    expect(trendMeta(null)).toEqual({ direction: 'flat', label: 'Steady', tone: 'flat' });
  });
});

describe('sortByAchievement', () => {
  it('sorts by achievement desc with nulls last', () => {
    const rows = [
      member({ salesUserId: 'none', achievedPct: null }),
      member({ salesUserId: 'low', achievedPct: 30 }),
      member({ salesUserId: 'high', achievedPct: 95 }),
    ];
    expect(sortByAchievement(rows).map((m) => m.salesUserId)).toEqual(['high', 'low', 'none']);
  });

  it('breaks ties by earned-this-month desc, then name asc', () => {
    const rows = [
      member({ salesUserId: 'b', name: 'Bob', achievedPct: 50, earnedThisMonth: 100 }),
      member({ salesUserId: 'a', name: 'Ann', achievedPct: 50, earnedThisMonth: 100 }),
      member({ salesUserId: 'c', name: 'Cal', achievedPct: 50, earnedThisMonth: 500 }),
    ];
    // Cal (higher earned) first; Ann before Bob on the name tiebreak.
    expect(sortByAchievement(rows).map((m) => m.salesUserId)).toEqual(['c', 'a', 'b']);
  });

  it('ranks an over-achiever (>100%) above a sub-100% peer even with lower earnings', () => {
    // Audit regression: if achievement were clamped to 100 before sorting, the two would tie and
    // fall to the earned-this-month tiebreak, wrongly ranking the lower over-achiever first.
    const rows = [
      member({ salesUserId: 'steady', achievedPct: 105, earnedThisMonth: 9000 }),
      member({ salesUserId: 'star', achievedPct: 300, earnedThisMonth: 1000 }),
    ];
    expect(sortByAchievement(rows).map((m) => m.salesUserId)).toEqual(['star', 'steady']);
  });

  it('does not mutate the input array', () => {
    const rows = [member({ salesUserId: 'x', achievedPct: 10 }), member({ salesUserId: 'y', achievedPct: 90 })];
    const snapshot = rows.map((m) => m.salesUserId);
    sortByAchievement(rows);
    expect(rows.map((m) => m.salesUserId)).toEqual(snapshot);
  });
});

describe('teamChartMax', () => {
  it('returns the largest single earned/redeemed value', () => {
    expect(
      teamChartMax([
        { monthKey: '2026-05', label: 'May', earned: 300, redeemed: 120 },
        { monthKey: '2026-06', label: 'Jun', earned: 150, redeemed: 420 },
      ]),
    ).toBe(420);
  });

  it('floors at 1 for an empty or all-zero series (no divide-by-zero)', () => {
    expect(teamChartMax([])).toBe(1);
    expect(teamChartMax([{ monthKey: '2026-05', label: 'May', earned: 0, redeemed: 0 }])).toBe(1);
  });
});

describe('mapTeam', () => {
  const base: ApiTeamResponse = {
    root: { salesUserId: 'r', name: 'Root RM', employeeCode: 'RM1', roleName: 'SALES_RM' },
    isManager: true,
    rollup: {
      memberCount: 3,
      earnedThisMonth: 1200,
      redeemedThisMonth: 400,
      avgAchievementPct: 150.4, // a team averaging OVER 100% — must NOT be capped
      onTrackCount: 2,
    },
    members: [
      member({ salesUserId: 'none', achievedPct: null, earnedThisMonth: 10 }),
      member({ salesUserId: 'top', achievedPct: 250, earnedThisMonth: 50 }),
      member({ salesUserId: 'mid', achievedPct: 40, earnedThisMonth: 20 }),
    ],
    monthly: [{ monthKey: '2026-05', label: 'May', earned: 300, redeemed: 120 }],
  };

  it('sorts members by achievement (nulls last) and keeps over-achievement UNCAPPED', () => {
    const t = mapTeam(base);
    expect(t.members.map((m) => m.salesUserId)).toEqual(['top', 'mid', 'none']);
    expect(t.rollup.avgAchievementPct).toBe(150); // rounded, NOT clamped to 100
    // achievedPct is the uncapped DISPLAY value (over-achievement survives); null stays null.
    expect(t.members.find((m) => m.salesUserId === 'top')!.achievedPct).toBe(250);
    expect(t.members.find((m) => m.salesUserId === 'none')!.achievedPct).toBeNull();
  });

  it('clamps negative / NaN numbers and preserves a null targetPoints', () => {
    const t = mapTeam({
      ...base,
      rollup: { ...base.rollup, earnedThisMonth: -5, onTrackCount: Number.NaN },
      members: [member({ salesUserId: 'm', pointsBalance: -100, targetPoints: null })],
      monthly: [{ monthKey: '2026-05', label: 'May', earned: -10, redeemed: Number.NaN }],
    });
    expect(t.rollup.earnedThisMonth).toBe(0);
    expect(t.rollup.onTrackCount).toBe(0);
    expect(t.members[0].pointsBalance).toBe(0);
    expect(t.members[0].targetPoints).toBeNull();
    expect(t.monthly[0].earned).toBe(0);
    expect(t.monthly[0].redeemed).toBe(0);
  });

  it('tolerates a no-team payload (non-manager, empty collections)', () => {
    const t = mapTeam({ root: null, isManager: false, rollup: base.rollup, members: [], monthly: [] });
    expect(t.isManager).toBe(false);
    expect(t.members).toEqual([]);
    expect(t.monthly).toEqual([]);
  });
});
