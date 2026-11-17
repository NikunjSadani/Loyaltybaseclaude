// Billing comparison (MTD vs last month / 3-month average to the same day) — loader, month coverage, day alignment,
// availability + honest reasons, slower-than-usual list, service paging/cache, export kind.
// Run: npx jest src/admin-core/dashboards/billing-comparison.spec.ts
//
// Dates: every month / "now" is computed RELATIVE to the real current IST month (never a hard-coded future date); the
// loader takes `now`, so each test pins "today" to a day of a relative month.
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { istMonthKey } from '../../common/ist-date';
import {
  alignedDay,
  availableFromMonth,
  coveredTo,
  DAY_DATA_START_MONTH,
  type DaySetInfo,
  deltaPct,
  loadBillingComparison,
  type BillingComparisonOptions,
  type MonthContext,
  monthCompleteIn,
  priorStatus,
  ratioPct,
  shiftMonth,
  SLOWER_THRESHOLD_PCT,
  summarizeBillingComparison,
} from './billing-comparison';
import { BillingComparisonDashboardService } from './billing-comparison-dashboard.service';
import { BillingProgressDashboardService } from './billing-progress-dashboard.service';
import { daysInMonthOf } from './billing-progress';
import { EXPORT_KINDS } from '../../exports/kinds';
import { BILLING_COMPARISON_SLOWER_KIND } from '../../exports/kinds/batch2/billing-comparison.kind';
import { monthLabel } from '../../sales-import/months/month-state';

const T = 'bajaj';
const CUR = istMonthKey(new Date());
const m = (delta: number) => shiftMonth(CUR, delta);
/** 12:00 IST on `day` of `month`. */
const at = (month: string, day: number) => {
  const [y, mm] = month.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1, day, 6, 30));
};
/** Test options: day data "started" long ago, the default 4-month window. */
const OPTS: BillingComparisonOptions = { dayDataStartMonth: m(-60), retentionMonths: 4 };

interface DayRow { clientId?: string; outletId?: string; outletCode: string; month: string; day: number; mtdValues: Record<string, unknown> }
interface SetRow { clientId?: string; month: string; lastDay: number; sourceImportId: string }
interface ImportRow { clientId?: string; id: string; createdAt: Date; monthSummaries: Array<{ month: string }> | null }
interface World {
  kpis: Array<Record<string, unknown>>;
  outlets: Array<{ code: string; program?: string | null; type?: string; reps?: string[]; clientId?: string }>;
  targets: Array<{ clientId?: string; outletCode: string; month: string; targetValues: Record<string, unknown> }>;
  salesUsers: Array<{ id: string; reportingToId: string | null; level: number; code: string; name: string; clientId?: string }>;
  features: Record<string, Record<string, unknown> | null>;
  sets: SetRow[];
  imports: ImportRow[];
  days: DayRow[];
}

function world(p: Partial<World> = {}): World {
  return {
    kpis: [{ clientId: T, code: 'TOTAL', label: 'Total sales', unit: 'INR', isPrimary: true, enabled: true, order: 0 }],
    outlets: [],
    targets: [],
    salesUsers: [],
    features: { [T]: { salesImport: true } },
    sets: [],
    imports: [],
    days: [],
    ...p,
  };
}

/** A month whose applied file was taken AFTER it ended (uploaded the next month) → complete. */
function fullSet(w: World, month: string, lastDay = daysInMonthOf(month), clientId?: string) {
  const id = `imp-${month}-${clientId ?? T}`;
  w.sets.push({ month, lastDay, sourceImportId: id, ...(clientId ? { clientId } : {}) });
  w.imports.push({ id, createdAt: at(shiftMonth(month, 1), 2), monthSummaries: [{ month }], ...(clientId ? { clientId } : {}) });
}
/** A month whose applied file was taken DURING the month (covers only to `lastDay`). */
function partialSet(w: World, month: string, lastDay: number) {
  const id = `imp-${month}-partial`;
  w.sets.push({ month, lastDay, sourceImportId: id });
  w.imports.push({ id, createdAt: at(month, Math.min(lastDay + 1, daysInMonthOf(month))), monthSummaries: [{ month }] });
}

function makePrisma(w: World) {
  const tenantOf = (r: { clientId?: string }) => r.clientId ?? T;
  return {
    kpiDef: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string } }) =>
        w.kpis
          .filter((k) => k.clientId === where.clientId && k.enabled !== false)
          .map((k) => ({ outletType: null, outletTypes: [], programs: [], subPrograms: [], unit: '', isPrimary: false, ...k })),
      ),
    },
    outlet: {
      findMany: jest.fn(async ({ where, distinct }: { where: { clientId: string }; distinct?: string[] }) => {
        const mine = w.outlets.filter((o) => tenantOf(o) === where.clientId);
        if (distinct) return [...new Set(mine.map((o) => o.program).filter((x): x is string => !!x))].sort().map((programName) => ({ programName }));
        return mine.map((o) => ({
          outletCode: o.code,
          name: `Outlet ${o.code}`,
          programName: o.program ?? null,
          programCategory: null,
          outletType: { code: o.type ?? 'RETAIL' },
          salesAssignments: (o.reps ?? []).map((salesUserId) => ({ salesUserId })),
        }));
      }),
    },
    salesUser: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string } }) =>
        w.salesUsers.filter((u) => (u.clientId ?? T) === where.clientId).map((u) => ({
          id: u.id, reportingToId: u.reportingToId, isActive: true, employeeCode: u.id, user: { name: u.name },
          hierarchyLevel: { code: u.code, name: u.code, level: u.level },
        })),
      ),
    },
    salesHierarchyLevel: { findMany: jest.fn(async () => []) },
    outletTarget: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string; month: string } }) =>
        w.targets.filter((r) => tenantOf(r) === where.clientId && r.month === where.month),
      ),
    },
    outletSalesRecord: { findMany: jest.fn(async () => []) },
    salesImportApply: { findFirst: jest.fn(async () => null) },
    salesImport: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async ({ where }: { where: { clientId: string; id: { in: string[] } } }) =>
        w.imports.filter((i) => tenantOf(i) === where.clientId && where.id.in.includes(i.id)),
      ),
    },
    client: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id in w.features ? { features: w.features[where.id], status: 'ACTIVE' } : null,
      ),
    },
    salesDaySet: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string; month: { gte: string } } }) =>
        w.sets
          .filter((s) => tenantOf(s) === where.clientId && s.month >= where.month.gte)
          .map((s) => ({ month: s.month, lastDay: s.lastDay, sourceImportId: s.sourceImportId })),
      ),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      expect(sql).toContain('FROM "outlet_sales_days"'); // OutletSalesDay's @@map
      if (sql.includes('jsonb_exists')) {
        // KPI probe: [clientId, month, clientId, month, kpiCode]
        const [clientId, month, , , code] = values as [string, string, string, string, string];
        const inMonth = w.days.filter((r) => tenantOf(r) === clientId && r.month === month);
        return [{ anyRow: inMonth.length > 0, withKey: inMonth.some((r) => code in r.mtdValues) }];
      }
      expect(sql).toContain('DISTINCT ON');
      expect(sql).toContain('"clientId" =');
      const [code, clientId, month, day] = values as [string, string, string, number];
      const latest = new Map<string, DayRow>();
      for (const r of w.days) {
        if (tenantOf(r) !== clientId || r.month !== month || r.day > day) continue;
        const id = r.outletId ?? r.outletCode;
        const cur = latest.get(id);
        if (!cur || r.day > cur.day) latest.set(id, r);
      }
      return [...latest.values()].map((r) => ({
        outletCode: r.outletCode,
        v: code in r.mtdValues && r.mtdValues[code] !== null ? String(r.mtdValues[code]) : null,
      }));
    }),
  };
}

const F: { program: string | null; outletType: string | null; managerId: string | null } = { program: null, outletType: null, managerId: null };
async function load(w: World, month: string, over: Partial<typeof F> = {}, now = at(month, 28), opts: BillingComparisonOptions = OPTS, clientId = T) {
  const prisma = makePrisma(w);
  const d = await loadBillingComparison(prisma as unknown as PrismaService, clientId, { month, ...F, ...over }, now, opts);
  return { d, prisma };
}
const distinctCalls = (prisma: ReturnType<typeof makePrisma>) =>
  prisma.$queryRaw.mock.calls.filter((c) => (c[0] as TemplateStringsArray).join('?').includes('DISTINCT ON'));

const target = (code: string, month: string, v = 1000) => ({ outletCode: code, month, targetValues: { TOTAL: v } });
const day = (code: string, month: string, d: number, v: number, extra: Record<string, unknown> = {}): DayRow => ({
  outletCode: code, month, day: d, mtdValues: { TOTAL: v, ...extra },
});
const ctxFor = (currentMonth: string, startMonth = m(-60)): MonthContext => ({
  currentMonth, cutoff: shiftMonth(currentMonth, -3), startMonth, retentionMonths: 4,
});

// ─── Pure helpers ───────────────────────────────────────────────────────────────────────────────

describe('day alignment + coverage', () => {
  it('31 → 30-day month; Feb 28; leap-year Feb 29; shorter D unchanged', () => {
    expect(alignedDay(31, '2025-04')).toBe(30);
    expect(alignedDay(31, '2025-02')).toBe(28);
    expect(alignedDay(30, '2024-02')).toBe(29); // leap year
    expect(alignedDay(17, '2025-02')).toBe(17);
    expect(alignedDay(31, '2025-03')).toBe(31);
  });

  it('shiftMonth crosses years both ways', () => {
    expect(shiftMonth('2025-01', -1)).toBe('2024-12');
    expect(shiftMonth('2024-12', 1)).toBe('2025-01');
    expect(shiftMonth('2025-03', -3)).toBe('2024-12');
  });

  it('C1: a complete month is covered to its last day (a non-billing last Sunday stays usable); else to lastDay', () => {
    expect(coveredTo({ lastDay: 30, complete: true }, '2025-08')).toBe(31);
    expect(coveredTo({ lastDay: 30, complete: false }, '2025-08')).toBe(30);
  });

  it('C1: monthCompleteIn — later-month invoices or an upload in a later IST month; never on the month itself', () => {
    expect(monthCompleteIn({ id: 'i', createdAt: '2025-08-20T00:00:00Z', monthSummaries: [{ month: '2025-08' }, { month: '2025-09' }] }, '2025-08')).toBe(true);
    // 31 Aug 19:00 UTC = 1 Sep 00:30 IST → taken after August ended.
    expect(monthCompleteIn({ id: 'i', createdAt: '2025-08-31T19:00:00Z', monthSummaries: [{ month: '2025-08' }] }, '2025-08')).toBe(true);
    // 31 Aug 18:00 UTC = 31 Aug 23:30 IST → still August.
    expect(monthCompleteIn({ id: 'i', createdAt: '2025-08-31T18:00:00Z', monthSummaries: [{ month: '2025-08' }] }, '2025-08')).toBe(false);
    expect(monthCompleteIn({ id: 'i', createdAt: null, monthSummaries: null }, '2025-08')).toBe(false);
    expect(monthCompleteIn(undefined, '2025-08')).toBe(false);
  });

  it('priorStatus: reasons in order — before day data, deleted, no data, not yet, incomplete; complete months reach month end', () => {
    const cur = '2025-11';
    const sets = new Map<string, DaySetInfo>([
      ['2025-10', { lastDay: 30, complete: true }],
      ['2025-09', { lastDay: 20, complete: false }],
    ]);
    const ctx = ctxFor(cur, '2025-07');
    expect(priorStatus(sets, '2025-10', 31, ctx)).toEqual({ available: true, day: 31, reason: null, coveredTo: 31 });
    expect(priorStatus(sets, '2025-09', 30, ctx)).toEqual({ available: false, day: 30, reason: 'DAY_DATA_INCOMPLETE', coveredTo: 20 });
    expect(priorStatus(sets, '2025-09', 20, ctx).available).toBe(true);
    expect(priorStatus(sets, '2025-08', 5, ctx).reason).toBe('NO_DAY_DATA'); // in window, past, no set
    expect(priorStatus(sets, '2025-07', 5, ctx).reason).toBe('DELETED_BY_RETENTION'); // cutoff = 2025-08
    expect(priorStatus(sets, '2025-06', 5, ctx).reason).toBe('BEFORE_DAY_DATA'); // before start beats retention
    expect(priorStatus(sets, '2025-11', 5, ctx).reason).toBe('NOT_YET');
  });
});

describe('availableFromMonth', () => {
  it('first day-data month = current month → last month from next month, 3-month avg three months on', () => {
    const sets = new Map<string, DaySetInfo>([[CUR, { lastDay: 17, complete: false }]]);
    const ctx = ctxFor(CUR, CUR);
    expect(availableFromMonth(sets, CUR, 1, ctx)).toBe(m(1));
    expect(availableFromMonth(sets, CUR, 3, ctx)).toBe(m(3));
  });

  it('C1/C3: never ≤ the selected month, never in the past', () => {
    const sets = new Map<string, DaySetInfo>([[m(-3), { lastDay: 30, complete: true }], [m(-1), { lastDay: 30, complete: true }], [CUR, { lastDay: 5, complete: false }]]);
    const ctx = ctxFor(CUR);
    // Viewing m(-3): its follower m(-2) would compare with m(-3) (has data) — but m(-2) is PAST → null, not a past date.
    expect(availableFromMonth(sets, m(-3), 1, ctx)).toBeNull();
    // Viewing m(-2): m(-1) compares with m(-2), which has no set → first is CUR (its prior m(-1) has data).
    expect(availableFromMonth(sets, m(-2), 1, ctx)).toBe(CUR);
    for (const sel of [m(-3), m(-2), m(-1), CUR]) {
      for (const k of [1, 3]) {
        const x = availableFromMonth(sets, sel, k, ctx);
        if (x !== null) {
          expect(x > sel).toBe(true);
          expect(x >= CUR).toBe(true);
        }
      }
    }
  });

  it('C3: months before day data started and deleted months never count as "will have"', () => {
    const ctx = ctxFor(CUR, m(-1));
    const sets = new Map<string, DaySetInfo>([[m(-1), { lastDay: 30, complete: true }]]);
    // 3-month avg for CUR needs m(-1..-3); m(-2) / m(-3) are before the start → first possible = m(2) (priors m(1), CUR, m(-1)).
    expect(availableFromMonth(sets, CUR, 3, ctx)).toBe(m(2));
  });
});

describe('deltaPct / ratioPct', () => {
  it('rounds to 1 dp; null when prior is 0 (or negative); zero change is 0', () => {
    expect(deltaPct(112.4, 100)).toBe(12.4);
    expect(deltaPct(96.9, 100)).toBe(-3.1);
    expect(deltaPct(100, 100)).toBe(0);
    expect(deltaPct(50, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
    expect(deltaPct(50, -10)).toBeNull();
    expect(deltaPct(0, 100)).toBe(-100);
  });

  it('C8: symmetric — half rounds AWAY from zero both ways', () => {
    expect(deltaPct(112.25, 100)).toBe(12.3);
    expect(deltaPct(87.75, 100)).toBe(-12.3);
    expect(deltaPct(100.05, 100)).toBe(0.1);
    expect(deltaPct(99.95, 100)).toBe(-0.1);
    expect(deltaPct(99.96, 100)).toBe(0); // -0.04 → 0, never -0
  });

  it('ratio floors (79.96 never shows as 80.0)', () => {
    expect(ratioPct(79.96, 100)).toBe(79.9);
    expect(ratioPct(0, 100)).toBe(0);
  });
});

// ─── Loader ─────────────────────────────────────────────────────────────────────────────────────

describe('loadBillingComparison', () => {
  // "Today" = the 28th of SEL (= the real current month), so every prior month is inside the retention window.
  const SEL = CUR;
  const [P1, P2, P3] = [m(-1), m(-2), m(-3)];

  const base = (): World => {
    const w = world({
      outlets: [{ code: 'A', program: 'Gold' }, { code: 'B', program: 'Gold' }, { code: 'C', program: 'Silver', type: 'WHOLESALE' }, { code: 'N' }],
      targets: [target('A', SEL), target('B', SEL), target('C', SEL)], // N: no target → not in the comparison
      days: [
        // Selected month (sparse cumulative): A billed on day 3 and 10; B on day 18 only (after D=17); C on day 17.
        day('A', SEL, 3, 100), day('A', SEL, 10, 300), day('A', SEL, 20, 999),
        day('B', SEL, 18, 50),
        day('C', SEL, 17, 400),
        day('N', SEL, 5, 7777), // no target → never summed
        // Last month: A 200 by day 17; B 100 by day 12; C 300 by day 17.
        day('A', P1, 17, 200), day('A', P1, 25, 900),
        day('B', P1, 12, 100),
        day('C', P1, 1, 300),
        day('A', P2, 2, 150), day('C', P2, 17, 150),
        day('A', P3, 16, 300),
      ],
    });
    partialSet(w, SEL, 17);
    for (const p of [P1, P2, P3]) fullSet(w, p);
    return w;
  };

  it('cumulative sparse lookup: latest row ≤ D, outlet with no row ≤ D = 0; same outlets in every month', async () => {
    const { d } = await load(base(), SEL);
    expect(d.reason).toBeNull();
    expect(d.message).toBeNull();
    expect(d.compareDay).toBe(17);
    // A 300 (day 10) + B 0 (only day 18) + C 400 = 700
    expect(d.current).toEqual({ mtd: 700, outlets: 3 });
    // Last month to day 17: A 200 + B 100 + C 300 = 600
    expect(d.lastMonth).toMatchObject({ available: true, availableFrom: null, message: null, month: P1, compareDay: 17, mtd: 600, deltaPct: 16.7 });
    // 3 months: 600, 300, 300 → avg 400 → +75%
    expect(d.threeMonthAvg).toMatchObject({ available: true, months: [P1, P2, P3], monthMtds: [600, 300, 300], avgMtd: 400, deltaPct: 75 });
  });

  it('slower than usual: below 80% of own last-month MTD; last-month 0 excluded; sorted by ratio asc', async () => {
    const w = base();
    w.outlets.push({ code: 'D' }, { code: 'E' }, { code: 'Z' });
    w.targets.push(target('D', SEL), target('E', SEL), target('Z', SEL));
    w.days.push(
      day('D', SEL, 17, 80), day('D', P1, 17, 100), // exactly 80% → NOT slower
      day('E', SEL, 17, 79.99), day('E', P1, 17, 100), // 79.99% → slower, shows 79.9
      day('Z', SEL, 17, 10), // nothing last month → excluded (no base)
    );
    const { d } = await load(w, SEL);
    expect(d.slowerRows.map((r) => r.outletCode)).toEqual(['B', 'E']);
    expect(d.slowerRows[1]).toMatchObject({ currentMtd: 79.99, lastMonthMtd: 100, ratioPct: 79.9 });
    expect(d.slowerThanUsual).toEqual({ count: 2, thresholdPct: SLOWER_THRESHOLD_PCT });
  });

  it('day alignment: D=31 reads a 30-day prior month at 30', async () => {
    let sel = m(-1);
    for (let i = 1; i < 40; i++) {
      sel = m(-i);
      if (alignedDay(31, sel) === 31 && alignedDay(31, shiftMonth(sel, -1)) < 31) break;
    }
    const prev = shiftMonth(sel, -1);
    const prevLen = alignedDay(31, prev);
    const w = world({ outlets: [{ code: 'A' }], targets: [target('A', sel)], days: [day('A', sel, 31, 200), day('A', prev, prevLen, 100)] });
    partialSet(w, sel, 31);
    fullSet(w, prev);
    const { d, prisma } = await load(w, sel, {}, at(sel, 31));
    expect(d.compareDay).toBe(31);
    expect(d.lastMonth).toMatchObject({ available: true, compareDay: prevLen, mtd: 100, deltaPct: 100 });
    const priorCall = distinctCalls(prisma).find((c) => c[3] === prev)!;
    expect(priorCall[4]).toBe(prevLen);
  });

  describe('C1: month completeness is not the last invoice day', () => {
    // A 31-day month X whose previous month is also 31 days (Jul/Aug or Dec/Jan) — found relative to now.
    let X = CUR;
    for (let i = 0; i < 24; i++) {
      X = m(-i);
      if (daysInMonthOf(X) === 31 && daysInMonthOf(shiftMonth(X, -1)) === 31) break;
    }
    const PX = shiftMonth(X, -1);
    const w0 = () => {
      const w = world({ outlets: [{ code: 'A' }], targets: [target('A', X)], days: [day('A', X, 31, 300), day('A', PX, 30, 100)] });
      partialSet(w, X, 31);
      return w;
    };

    it('last month ended on a non-billing day (lastDay 30) but its file was taken after it ended → usable at day 31', async () => {
      const w = w0();
      fullSet(w, PX, 30); // uploaded in X
      const { d } = await load(w, X, {}, at(X, 31));
      expect(d.compareDay).toBe(31);
      expect(d.lastMonth).toMatchObject({ available: true, compareDay: 31, mtd: 100, deltaPct: 200 });
    });

    it('…also when the file carries a later month’s invoices (even if processed the same day)', async () => {
      const w = w0();
      w.sets.push({ month: PX, lastDay: 30, sourceImportId: 'multi' });
      w.imports.push({ id: 'multi', createdAt: at(PX, 30), monthSummaries: [{ month: PX }, { month: X }] });
      expect((await load(w, X, {}, at(X, 31))).d.lastMonth.available).toBe(true);
    });

    it('a file taken DURING the month only covers it to lastDay → DAY_DATA_INCOMPLETE with an honest line', async () => {
      const w = w0();
      partialSet(w, PX, 30);
      const { d } = await load(w, X, {}, at(X, 31));
      expect(d.lastMonth).toMatchObject({ available: false, reason: 'DAY_DATA_INCOMPLETE', mtd: null });
      expect(d.lastMonth.message).toBe(
        `Comparison with last month not available: ${monthLabel(PX)}'s day-by-day sales only go up to day 30.${
          d.lastMonth.availableFrom ? ` Available from ${monthLabel(d.lastMonth.availableFrom)}.` : ''}`,
      );
      expect(d.slowerThanUsual.count).toBe(0);
    });

    it('a PAST selected month that is complete is compared to its last day, not its last invoice day', async () => {
      const w = world({ outlets: [{ code: 'A' }], targets: [target('A', X)], days: [day('A', X, 30, 300), day('A', PX, 31, 100)] });
      fullSet(w, X, 30); // X's last invoice day 30, file taken after X ended
      fullSet(w, PX);
      const { d } = await load(w, X, {}, at(shiftMonth(X, 1), 5));
      expect(d.compareDay).toBe(31);
      expect(d.lastMonth).toMatchObject({ available: true, compareDay: 31, mtd: 100 });
    });
  });

  it('current month: D capped at today (IST) even if the set says later', async () => {
    const w = world({ outlets: [{ code: 'A' }], targets: [target('A', CUR)] });
    fullSet(w, CUR, 14);
    expect((await load(w, CUR, {}, at(CUR, 10))).d.compareDay).toBe(10);
  });

  describe('C2: prior months without the KPI are UNAVAILABLE, never zero', () => {
    it('last month’s day rows lack the KPI → KPI_NOT_IN_DAY_DATA for both comparisons, no slower list', async () => {
      const w = base();
      w.days = w.days.map((r) => (r.month === P1 ? { ...r, mtdValues: { OTHER: 5 } } : r));
      const { d } = await load(w, SEL);
      expect(d.reason).toBeNull();
      expect(d.current.mtd).toBe(700);
      expect(d.lastMonth).toMatchObject({ available: false, reason: 'KPI_NOT_IN_DAY_DATA', mtd: null, deltaPct: null });
      expect(d.lastMonth.message).toContain(`${monthLabel(P1)}'s day-by-day sales don't include Total sales`);
      expect(d.threeMonthAvg).toMatchObject({ available: false, reason: 'KPI_NOT_IN_DAY_DATA', avgMtd: null });
      expect(d.threeMonthAvg.monthMtds[0]).toBeNull();
      expect(d.slowerRows).toEqual([]);
      expect(d.slowerThanUsual.count).toBe(0);
    });

    it('a prior month with no row ≤ D: probed — lacks the KPI → unavailable; carries it → a real 0', async () => {
      const w = base();
      w.days = w.days.filter((r) => r.month !== P3).concat([{ outletCode: 'A', month: P3, day: 25, mtdValues: { OTHER: 1 } }]);
      const { d } = await load(w, SEL);
      expect(d.threeMonthAvg).toMatchObject({ available: false, reason: 'KPI_NOT_IN_DAY_DATA' });
      expect(d.lastMonth.available).toBe(true);

      const w2 = base();
      w2.days = w2.days.filter((r) => r.month !== P3).concat([day('A', P3, 25, 1)]);
      const d2 = (await load(w2, SEL)).d;
      expect(d2.threeMonthAvg).toMatchObject({ available: true, monthMtds: [600, 300, 0] });
    });

    it('selected month rows lack the KPI → KPI_NOT_IN_DAY_DATA overall', async () => {
      const w = base();
      w.days = w.days.map((r) => ({ ...r, mtdValues: { OTHER: 5 } }));
      const { d } = await load(w, SEL);
      expect(d.reason).toBe('KPI_NOT_IN_DAY_DATA');
      expect(d.message).toBe(`The day-by-day sales data for ${monthLabel(SEL)} doesn't include Total sales, so it can't be compared with earlier months.`);
      expect(d.lastMonth.available).toBe(false);
    });
  });

  describe('C3: honest text for never-existing / deleted / not-yet months', () => {
    it('(a) priors before day-by-day sales started → "start from <month>", available from a FUTURE month', async () => {
      const w = base();
      const { d } = await load(w, SEL, {}, at(SEL, 28), { ...OPTS, dayDataStartMonth: SEL });
      expect(d.lastMonth).toMatchObject({ available: false, reason: 'BEFORE_DAY_DATA', availableFrom: m(1) });
      expect(d.lastMonth.message).toBe(
        `Comparison with last month not available: day-by-day sales start from ${monthLabel(SEL)}. Available from ${monthLabel(m(1))}.`,
      );
      expect(d.threeMonthAvg).toMatchObject({ reason: 'BEFORE_DAY_DATA', availableFrom: m(3) });
      expect(d.lastMonth.message).not.toMatch(/yet/);
    });

    it('(b) a prior month deleted by the 4-month retention → "kept for 4 months"; its stale set is ignored', async () => {
      // Viewing last month: its 3rd prior month (m(-4)) is older than the window (cutoff m(-3)).
      const w = base();
      w.targets.push(target('A', P1));
      fullSet(w, m(-4)); // stale set still present (sweep not run yet) — must be ignored
      w.days.push(day('A', m(-4), 1, 50));
      const { d, prisma } = await load(w, P1, {}, at(SEL, 28));
      expect(prisma.salesDaySet.findMany.mock.calls[0][0].where.month).toEqual({ gte: m(-3) });
      expect(d.threeMonthAvg).toMatchObject({ available: false, reason: 'DELETED_BY_RETENTION' });
      expect(d.threeMonthAvg.message).toContain(`day-by-day sales are kept for 4 months, and ${monthLabel(m(-4))} is older than that`);
      expect(d.threeMonthAvg.message).not.toMatch(/yet/);
      // Available from = the current month (its priors will all be kept), never a past month.
      expect(d.threeMonthAvg.availableFrom).toBe(CUR);
    });

    it('(c) the current month has no day data yet → "yet"; a past month without data never says "yet"', async () => {
      const w = base();
      w.sets = w.sets.filter((s) => s.month !== SEL);
      const cur = (await load(w, SEL)).d;
      expect(cur).toMatchObject({ reason: 'NO_DAY_DATA_FOR_MONTH', monthDataReason: 'NOT_YET', compareDay: null });
      expect(cur.current.mtd).toBeNull();
      expect(cur.message).toBe(`There are no day-by-day sales for ${monthLabel(SEL)} yet, so ${monthLabel(SEL)} can't be compared with earlier months.`);

      const past = world({ outlets: [{ code: 'A' }], targets: [target('A', P2)] });
      fullSet(past, P1);
      const p = (await load(past, P2, {}, at(SEL, 28))).d;
      expect(p).toMatchObject({ reason: 'NO_DAY_DATA_FOR_MONTH', monthDataReason: 'NO_DAY_DATA' });
      expect(p.message).toBe(`There are no day-by-day sales for ${monthLabel(P2)}, so ${monthLabel(P2)} can't be compared with earlier months.`);
      expect(p.message).not.toMatch(/yet/);
    });

    it('selected month before day data started / deleted → (a) / (b) wording', async () => {
      const w = base();
      w.targets.push(target('A', m(-5)));
      const del = (await load(w, m(-5), {}, at(SEL, 28))).d;
      expect(del).toMatchObject({ reason: 'NO_DAY_DATA_FOR_MONTH', monthDataReason: 'DELETED_BY_RETENTION' });
      expect(del.message).toBe(`Day-by-day sales are kept for 4 months, and ${monthLabel(m(-5))} is older than that, so ${monthLabel(m(-5))} can't be compared with earlier months.`);
      const before = (await load(w, m(-5), {}, at(SEL, 28), { ...OPTS, dayDataStartMonth: SEL })).d;
      expect(before.monthDataReason).toBe('BEFORE_DAY_DATA');
      expect(before.message).toBe(`Day-by-day sales start from ${monthLabel(SEL)}, so ${monthLabel(m(-5))} can't be compared with earlier months.`);
      // Never an "available from" in the past.
      for (const c of [del.lastMonth, del.threeMonthAvg, before.lastMonth, before.threeMonthAvg]) {
        if (c.availableFrom) expect(c.availableFrom >= CUR).toBe(true);
      }
    });
  });

  it('C4: no outlet with a target for the filters → NO_TARGETED_OUTLETS, never "nothing billed last month"', async () => {
    const w = base();
    const { d, prisma } = await load(w, SEL, { program: 'Nobody' });
    expect(d).toMatchObject({ reason: 'NO_TARGETED_OUTLETS', message: 'No outlets have a target for these filters.', current: { mtd: null, outlets: 0 } });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  describe('C6: cheap check first, cached billing reuse', () => {
    it('non-salesImport tenant with no kept day data → NO_DAY_LEVEL_DATA WITHOUT loading the billing universe', async () => {
      const w = base();
      w.features[T] = { salesImport: false };
      w.sets = [];
      const { d, prisma } = await load(w, SEL);
      expect(d.reason).toBe('NO_DAY_LEVEL_DATA');
      expect(d.lastMonth).toMatchObject({ available: false, availableFrom: null });
      expect(prisma.outlet.findMany).not.toHaveBeenCalled();
      expect(prisma.kpiDef.findMany).not.toHaveBeenCalled();
      expect(prisma.outletTarget.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.salesImport.findMany).not.toHaveBeenCalled(); // no sets → no import read either
    });

    it('flag off and only sets older than the window → NO_DAY_LEVEL_DATA', async () => {
      const w = world({ features: { [T]: {} } });
      fullSet(w, m(-6));
      expect((await load(w, SEL)).d.reason).toBe('NO_DAY_LEVEL_DATA');
    });

    it('flag off but kept day data from an earlier on-period → still compared (data is real)', async () => {
      const w = base();
      w.features[T] = {};
      expect((await load(w, SEL)).d.reason).toBeNull();
    });

    it('opts.loadBilling replaces the billing load (no outlet / target reads of its own)', async () => {
      const w = base();
      const real = makePrisma(w);
      const { loadBillingProgress } = await import('./billing-progress');
      const cached = loadBillingProgress(real as unknown as PrismaService, T, { month: SEL, ...F }, at(SEL, 28));
      const { d, prisma } = await load(w, SEL, {}, at(SEL, 28), { ...OPTS, loadBilling: () => cached });
      expect(d.current.mtd).toBe(700);
      expect(prisma.outlet.findMany).not.toHaveBeenCalled();
      expect(prisma.outletTarget.findMany).not.toHaveBeenCalled();
    });
  });

  it('no enabled KPI → NO_KPI', async () => {
    const w = base();
    w.kpis = [];
    expect((await load(w, SEL)).d).toMatchObject({ reason: 'NO_KPI', kpi: null });
  });

  it('deltaPct null when last month MTD is 0', async () => {
    const w = world({ outlets: [{ code: 'A' }], targets: [target('A', SEL)], days: [day('A', SEL, 5, 50), day('A', P1, 20, 7)] });
    partialSet(w, SEL, 10);
    fullSet(w, P1);
    const { d } = await load(w, SEL);
    expect(d.lastMonth).toMatchObject({ available: true, mtd: 0, deltaPct: null });
  });

  it('filters reuse the billing universe (program / outlet type / manager)', async () => {
    const w = base();
    w.salesUsers = [
      { id: 'asm1', reportingToId: null, level: 3, code: 'ASM', name: 'Asha' },
      { id: 'so1', reportingToId: 'asm1', level: 2, code: 'SO', name: 'Sonu' },
    ];
    w.outlets[2].reps = ['so1']; // C
    expect((await load(w, SEL, { program: 'Gold' })).d.current).toEqual({ mtd: 300, outlets: 2 });
    expect((await load(w, SEL, { outletType: 'WHOLESALE' })).d.current).toEqual({ mtd: 400, outlets: 1 });
    const mgr = (await load(w, SEL, { managerId: 'asm1' })).d;
    expect(mgr.current).toEqual({ mtd: 400, outlets: 1 });
    expect(mgr.lastMonth.mtd).toBe(300);
    expect(mgr.managerName).toBe('Asha');
  });

  it('tenant isolation: another tenant’s day rows / sets / imports never count; reads are tenant-parameterised', async () => {
    const w = base();
    w.days.push({ ...day('A', SEL, 1, 1_000_000), clientId: 'deoleo' });
    fullSet(w, P1, 31, 'deoleo');
    const { d, prisma } = await load(w, SEL);
    expect(d.current.mtd).toBe(700);
    for (const c of distinctCalls(prisma)) expect(c[2]).toBe(T);
    for (const c of prisma.salesImport.findMany.mock.calls) expect(c[0].where.clientId).toBe(T);
    // Deoleo: no flag, one kept set of its own, no KPI in this world → NO_KPI, never Bajaj's numbers.
    expect((await load(w, SEL, {}, at(SEL, 28), OPTS, 'deoleo')).d.reason).toBe('NO_KPI');
  });

  it('summary drops the internal row list', async () => {
    const s = summarizeBillingComparison((await load(base(), SEL)).d);
    expect(s).not.toHaveProperty('slowerRows');
    expect(s).not.toHaveProperty('managerName');
    expect(s.slowerThanUsual.count).toBe(1); // B
  });
});

// ─── Service ────────────────────────────────────────────────────────────────────────────────────

describe('BillingComparisonDashboardService', () => {
  // The service reads the real clock: SEL = the real current month (D ≤ today ≥ 1), P1 its prior.
  const SEL = CUR;
  const P1 = m(-1);
  const w = () => {
    const x = world({
      outlets: ['A', 'B', 'C', 'D'].map((code) => ({ code })),
      targets: ['A', 'B', 'C', 'D'].map((c) => target(c, SEL)),
      days: [
        day('A', SEL, 1, 10), day('A', P1, 1, 100), // 10%
        day('B', SEL, 1, 5), day('B', P1, 1, 100), // 5%
        day('C', SEL, 1, 50), day('C', P1, 1, 100), // 50%
        day('D', SEL, 1, 90), day('D', P1, 1, 100), // 90% → not slower
      ],
    });
    partialSet(x, SEL, 1);
    fullSet(x, P1);
    return x;
  };
  const user = { sub: 'u', role: 'CLIENT_ADMIN', clientId: T, phone: '', name: '' } as JwtPayload;
  const make = (prisma: ReturnType<typeof makePrisma>) => {
    const p = prisma as unknown as PrismaService;
    const billing = new BillingProgressDashboardService(p);
    const svc = new BillingComparisonDashboardService(p, billing);
    svc.options = OPTS;
    return { svc, billing };
  };

  it('pages the slower list (sorted), caps pageSize, validates params', async () => {
    const { svc } = make(makePrisma(w()));
    const p1 = await svc.slowerOutlets(user, { month: SEL, page: '1', pageSize: '2' });
    expect(p1).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(p1.rows.map((r) => r.outletCode)).toEqual(['B', 'A']);
    expect(p1.rows[0]).toEqual({
      outletCode: 'B', outletName: 'Outlet B', program: null, soName: null, asmName: null,
      currentMtd: 5, lastMonthMtd: 100, ratioPct: 5,
    });
    expect((await svc.slowerOutlets(user, { month: SEL, page: '2', pageSize: '2' })).rows.map((r) => r.outletCode)).toEqual(['C']);
    expect((await svc.slowerOutlets(user, { month: SEL, pageSize: '999' })).pageSize).toBe(200);
    await expect(svc.slowerOutlets(user, { month: SEL, page: '0' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.summary(user, { month: '2026-13' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cache is tenant-keyed and reused while paging', async () => {
    const prisma = makePrisma(w());
    const { svc } = make(prisma);
    const a = await svc.summary(user, { month: SEL });
    await svc.slowerOutlets(user, { month: SEL, page: '2', pageSize: '1' });
    expect(prisma.salesDaySet.findMany).toHaveBeenCalledTimes(1);
    const b = await svc.summary({ ...user, clientId: 'deoleo' }, { month: SEL });
    expect(a.current.mtd).toBe(155);
    expect(b.reason).toBe('NO_DAY_LEVEL_DATA'); // Deoleo: no flag, no day data → cheap stop
    expect(svc.cacheSize).toBe(2);
  });

  it('C6: reuses the billing-progress service’s cached month (the card’s own request) — no second universe load', async () => {
    const prisma = makePrisma(w());
    const { svc, billing } = make(prisma);
    await billing.summary(user, { month: SEL }); // the card's request
    expect(prisma.outlet.findMany).toHaveBeenCalled();
    const before = prisma.outlet.findMany.mock.calls.length;
    const s = await svc.summary(user, { month: SEL });
    expect(s.current.mtd).toBe(155);
    expect(prisma.outlet.findMany.mock.calls.length).toBe(before);
    expect(prisma.outletTarget.findMany).toHaveBeenCalledTimes(1);
  });

  it('C6: a tenant without day data never touches the billing universe', async () => {
    const prisma = makePrisma(world({ features: { [T]: {} } }));
    const { svc, billing } = make(prisma);
    const spy = jest.spyOn(billing, 'load');
    expect((await svc.summary(user, { month: SEL })).reason).toBe('NO_DAY_LEVEL_DATA');
    expect(spy).not.toHaveBeenCalled();
    expect(prisma.outlet.findMany).not.toHaveBeenCalled();
  });
});

// ─── Export kind ────────────────────────────────────────────────────────────────────────────────

describe('billing-comparison-slower export kind', () => {
  // The kind uses the production defaults (first day-data month + 4-month window): test inside that reality —
  // the selected month is the later of now and 3 months after day data started, "today" its 28th.
  const KSEL = CUR > shiftMonth(DAY_DATA_START_MONTH, 3) ? CUR : shiftMonth(DAY_DATA_START_MONTH, 3);
  const KP1 = shiftMonth(KSEL, -1);

  it('is registered with the dashboard’s access', () => {
    expect(EXPORT_KINDS.get('billing-comparison-slower')).toBe(BILLING_COMPARISON_SLOWER_KIND);
    expect(BILLING_COMPARISON_SLOWER_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'], permission: 'reports:read' });
    const p = BILLING_COMPARISON_SLOWER_KIND.parseParams({ month: '2026-10', program: ' Gold ' }, {} as JwtPayload);
    expect(p).toEqual({ month: '2026-10', program: 'Gold', outletType: null, managerId: null });
    expect(BILLING_COMPARISON_SLOWER_KIND.isHeavy(p)).toBe(false);
    expect(BILLING_COMPARISON_SLOWER_KIND.describeParams(p)).toBe('Billing slower than usual — Oct 2026 · Program: Gold');
    expect(BILLING_COMPARISON_SLOWER_KIND.fileName(p, new Date())).toBe('billing-slower-than-usual-2026-10.xlsx');
    expect(() => BILLING_COMPARISON_SLOWER_KIND.parseParams({ month: 'x' }, {} as JwtPayload)).toThrow(BadRequestException);
  });

  function sink() {
    const sheets: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [];
    const out = {
      addSheet: async (name: string, h: string[]) => {
        const sh = { name, headers: h, rows: [] as unknown[][] };
        sheets.push(sh);
        return { addRow: async (r: unknown[]) => void sh.rows.push(r), rowCount: 0 };
      },
    };
    return { sheets, out };
  }
  const run = async (w: World, month: string) => {
    const { sheets, out } = sink();
    const params = BILLING_COMPARISON_SLOWER_KIND.parseParams({ month }, {} as JwtPayload);
    const res = await BILLING_COMPARISON_SLOWER_KIND.run(
      { prisma: makePrisma(w), clientId: T, now: at(KSEL, 28), user: {} as JwtPayload, moduleRef: {} } as never, params, out as never,
    );
    return { res, sheets, about: Object.fromEntries(sheets[0].rows.map((r) => [r[0], r[1]])) };
  };

  it('writes exactly the on-screen list', async () => {
    const w = world({
      outlets: [{ code: 'A' }, { code: 'B' }],
      targets: [target('A', KSEL), target('B', KSEL)],
      days: [day('A', KSEL, 10, 10), day('A', KP1, 10, 100), day('B', KSEL, 10, 100), day('B', KP1, 10, 100)],
    });
    partialSet(w, KSEL, 10);
    fullSet(w, KP1);
    const { res, sheets, about } = await run(w, KSEL);
    expect(res.rowCount).toBe(1);
    expect(sheets.map((s) => s.name)).toEqual(['About', 'Slower than usual']);
    expect(sheets[1].headers).toEqual([
      'Outlet Code', 'Outlet Name', 'Program', 'SO', 'ASM',
      'Billed this month to day 10 (₹)', 'Billed last month to day 10 (₹)', '% of last month',
    ]);
    expect(sheets[1].rows[0]).toEqual(['A', 'Outlet A', '', '', '', 10, 100, 10]);
    expect(about.Status).toBe('Compared');
  });

  it('C1/C3: About Status = the SAME message the card shows', async () => {
    const w = world({ outlets: [{ code: 'A' }], targets: [target('A', KSEL)], days: [day('A', KSEL, 20, 10), day('A', KP1, 10, 100)] });
    partialSet(w, KSEL, 20);
    partialSet(w, KP1, 10);
    const { res, about } = await run(w, KSEL);
    expect(res.rowCount).toBe(0);
    const data = await loadBillingComparison(makePrisma(w) as unknown as PrismaService, T, { month: KSEL, ...F }, at(KSEL, 28));
    expect(data.lastMonth.reason).toBe('DAY_DATA_INCOMPLETE');
    expect(about.Status).toBe(data.lastMonth.message);
    expect(about['3-month average']).toBe(data.threeMonthAvg.message);
  });

  it('unavailable comparison → About says why, no rows', async () => {
    const { res, about } = await run(world({ outlets: [{ code: 'A' }], targets: [target('A', KSEL)], features: { [T]: {} } }), KSEL);
    expect(res.rowCount).toBe(0);
    expect(String(about.Status)).toContain('no day-by-day sales data');
  });
});
