// Billing comparison (MTD vs last month / 3-month average to the same day) — loader, day alignment,
// availability, slower-than-usual list, service paging/cache, export kind.
// Run: npx jest src/admin-core/dashboards/billing-comparison.spec.ts
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { istMonthKey } from '../../common/ist-date';
import {
  alignedDay,
  availableFromMonth,
  deltaPct,
  loadBillingComparison,
  priorStatus,
  ratioPct,
  shiftMonth,
  SLOWER_THRESHOLD_PCT,
  summarizeBillingComparison,
} from './billing-comparison';
import { BillingComparisonDashboardService } from './billing-comparison-dashboard.service';
import { EXPORT_KINDS } from '../../exports/kinds';
import { BILLING_COMPARISON_SLOWER_KIND } from '../../exports/kinds/batch2/billing-comparison.kind';

const T = 'bajaj';
const CUR = istMonthKey(new Date());
const m = (delta: number) => shiftMonth(CUR, delta);

interface DayRow { clientId?: string; outletId?: string; outletCode: string; month: string; day: number; mtdValues: Record<string, unknown> }
interface World {
  kpis: Array<Record<string, unknown>>;
  outlets: Array<{ code: string; program?: string | null; type?: string; reps?: string[]; clientId?: string }>;
  targets: Array<{ clientId?: string; outletCode: string; month: string; targetValues: Record<string, unknown> }>;
  salesUsers: Array<{ id: string; reportingToId: string | null; level: number; code: string; name: string; clientId?: string }>;
  features: Record<string, Record<string, unknown> | null>;
  sets: Array<{ clientId?: string; month: string; lastDay: number }>;
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
    days: [],
    ...p,
  };
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
    salesImport: { findFirst: jest.fn(async () => null) },
    client: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id in w.features ? { features: w.features[where.id], status: 'ACTIVE' } : null,
      ),
    },
    salesDaySet: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string } }) =>
        w.sets.filter((s) => tenantOf(s) === where.clientId).map((s) => ({ month: s.month, lastDay: s.lastDay })),
      ),
    },
    // Emulates the DISTINCT ON statement: values are [kpiCode, clientId, month, day] in template order.
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      expect(sql).toContain('DISTINCT ON');
      expect(sql).toContain('FROM "outlet_sales_days"'); // OutletSalesDay's @@map
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
async function load(w: World, month: string, over: Partial<typeof F> = {}, now = new Date(), clientId = T) {
  const prisma = makePrisma(w);
  const d = await loadBillingComparison(prisma as unknown as PrismaService, clientId, { month, ...F, ...over }, now);
  return { d, prisma };
}

const target = (code: string, month: string, v = 1000) => ({ outletCode: code, month, targetValues: { TOTAL: v } });
const day = (code: string, month: string, d: number, v: number, extra: Record<string, unknown> = {}): DayRow => ({
  outletCode: code, month, day: d, mtdValues: { TOTAL: v, ...extra },
});

// ─── Pure helpers ───────────────────────────────────────────────────────────────────────────────

describe('day alignment', () => {
  it('31 → 30-day month; Feb 28; leap-year Feb 29; shorter D unchanged', () => {
    expect(alignedDay(31, '2025-04')).toBe(30);
    expect(alignedDay(31, '2025-02')).toBe(28);
    expect(alignedDay(30, '2024-02')).toBe(29); // leap year
    expect(alignedDay(29, '2023-02')).toBe(28);
    expect(alignedDay(17, '2025-02')).toBe(17);
    expect(alignedDay(31, '2025-03')).toBe(31);
  });

  it('shiftMonth crosses years both ways', () => {
    expect(shiftMonth('2025-01', -1)).toBe('2024-12');
    expect(shiftMonth('2024-12', 1)).toBe('2025-01');
    expect(shiftMonth('2025-03', -3)).toBe('2024-12');
  });

  it('priorStatus: needs a set whose lastDay reaches the ALIGNED day', () => {
    const sets = new Map([['2024-02', 29], ['2025-02', 27], ['2025-04', 30]]);
    expect(priorStatus(sets, '2024-02', 31)).toEqual({ available: true, day: 29, reason: null });
    expect(priorStatus(sets, '2025-02', 31)).toEqual({ available: false, day: 28, reason: 'DAY_DATA_INCOMPLETE' });
    expect(priorStatus(sets, '2025-02', 27)).toEqual({ available: true, day: 27, reason: null });
    expect(priorStatus(sets, '2025-04', 31)).toEqual({ available: true, day: 30, reason: null });
    expect(priorStatus(sets, '2025-05', 3)).toEqual({ available: false, day: 3, reason: 'NO_DAY_DATA' });
  });
});

describe('availableFrom (relative to now)', () => {
  it('first day-data month = current month → last month from next month, 3-month avg three months on', () => {
    const sets = new Map([[CUR, 17]]);
    expect(availableFromMonth(sets, CUR, 1, CUR)).toBe(m(1));
    expect(availableFromMonth(sets, CUR, 3, CUR)).toBe(m(3));
  });

  it('day data since two months ago → 3-month average from next month', () => {
    const sets = new Map([[m(-2), 30], [m(-1), 31], [CUR, 10]]);
    expect(availableFromMonth(sets, CUR, 3, CUR)).toBe(m(1));
  });

  it('a past month without day data pushes the date beyond it', () => {
    // Viewing a past month whose data ends; the gap at m(-3) can never fill.
    const sets = new Map([[m(-5), 30], [m(-4), 30], [m(-2), 30], [m(-1), 30], [CUR, 5]]);
    expect(availableFromMonth(sets, m(-4), 3, CUR)).toBe(m(1)); // window m(-2..0) is the first without m(-3)
    expect(availableFromMonth(sets, m(-3), 1, CUR)).toBe(m(-1)); // m(-2)'s prior is the gap itself
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

  it('ratio floors (79.96 never shows as 80.0)', () => {
    expect(ratioPct(79.96, 100)).toBe(79.9);
    expect(ratioPct(0, 100)).toBe(0);
  });
});

// ─── Loader ─────────────────────────────────────────────────────────────────────────────────────

describe('loadBillingComparison', () => {
  // Selected month = 4 months ago (all priors are past months, fully under test control).
  const SEL = m(-4);
  const [P1, P2, P3] = [m(-5), m(-6), m(-7)];

  const base = (): World =>
    world({
      outlets: [{ code: 'A', program: 'Gold' }, { code: 'B', program: 'Gold' }, { code: 'C', program: 'Silver', type: 'WHOLESALE' }, { code: 'N' }],
      targets: [target('A', SEL), target('B', SEL), target('C', SEL)], // N: no target → not in the comparison
      sets: [{ month: SEL, lastDay: 17 }, { month: P1, lastDay: 31 }, { month: P2, lastDay: 31 }, { month: P3, lastDay: 31 }],
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

  it('cumulative sparse lookup: latest row ≤ D, outlet with no row ≤ D = 0; same outlets in every month', async () => {
    const { d } = await load(base(), SEL);
    expect(d.reason).toBeNull();
    expect(d.compareDay).toBe(17);
    // A 300 (day 10) + B 0 (only day 18) + C 400 = 700
    expect(d.current).toEqual({ mtd: 700, outlets: 3 });
    // Last month to day 17: A 200 + B 100 + C 300 = 600
    expect(d.lastMonth).toMatchObject({ available: true, availableFrom: null, month: P1, compareDay: alignedDay(17, P1), mtd: 600, deltaPct: 16.7 });
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
    // B 0/100 = 0%, E 79.99%; A 300/200 and C 400/300 are faster; D at 80% is not below.
    expect(d.slowerRows.map((r) => r.outletCode)).toEqual(['B', 'E']);
    expect(d.slowerRows[1]).toMatchObject({ currentMtd: 79.99, lastMonthMtd: 100, ratioPct: 79.9 });
    expect(d.slowerThanUsual).toEqual({ count: 2, thresholdPct: SLOWER_THRESHOLD_PCT });
  });

  it('day alignment in the loader: D=31 reads a 30-day prior month at 30 (and Feb at 28/29)', async () => {
    // Find a past month with 31 days whose previous month has fewer (relative to now).
    let sel = m(-2);
    for (let i = 2; i < 40; i++) {
      sel = m(-i);
      const prev = shiftMonth(sel, -1);
      if (alignedDay(31, sel) === 31 && alignedDay(31, prev) < 31) break;
    }
    const prev = shiftMonth(sel, -1);
    const prevLen = alignedDay(31, prev);
    const w = world({
      outlets: [{ code: 'A' }],
      targets: [target('A', sel)],
      sets: [{ month: sel, lastDay: 31 }, { month: prev, lastDay: prevLen }],
      days: [day('A', sel, 31, 200), day('A', prev, prevLen, 100)],
    });
    const { d, prisma } = await load(w, sel);
    expect(d.compareDay).toBe(31);
    expect(d.lastMonth).toMatchObject({ available: true, compareDay: prevLen, mtd: 100, deltaPct: 100 });
    const priorCall = prisma.$queryRaw.mock.calls.find((c) => c[3] === prev)!;
    expect(priorCall[4]).toBe(prevLen);
  });

  it('prior month data short of the aligned day → unavailable with availableFrom; 3-month avg needs all three', async () => {
    const w = base();
    w.sets = w.sets.map((s) => (s.month === P1 ? { ...s, lastDay: 15 } : s));
    const { d } = await load(w, SEL);
    expect(d.lastMonth).toMatchObject({ available: false, reason: 'DAY_DATA_INCOMPLETE', mtd: null, deltaPct: null });
    expect(d.lastMonth.availableFrom).toBe(m(-3)); // the month after SEL (its own prior has day data)
    expect(d.threeMonthAvg).toMatchObject({ available: false, reason: 'DAY_DATA_INCOMPLETE', avgMtd: null, deltaPct: null });
    expect(d.slowerThanUsual.count).toBe(0); // no last-month base → no slower list
    expect(d.current.mtd).toBe(700); // current still shown
  });

  it('day data started this month → both unavailable, availableFrom next month / three months on', async () => {
    const [y, mm] = CUR.split('-').map(Number);
    const now = new Date(Date.UTC(y, mm - 1, 17, 6, 30)); // 17th IST of the current month
    const w = world({
      outlets: [{ code: 'A' }],
      targets: [target('A', CUR)],
      sets: [{ month: CUR, lastDay: 17 }],
      days: [day('A', CUR, 5, 10)],
    });
    const { d } = await load(w, CUR, {}, now);
    expect(d.reason).toBeNull();
    expect(d.compareDay).toBe(17);
    expect(d.current.mtd).toBe(10);
    expect(d.lastMonth).toMatchObject({ available: false, reason: 'NO_DAY_DATA', availableFrom: m(1) });
    expect(d.threeMonthAvg).toMatchObject({ available: false, reason: 'NO_DAY_DATA', availableFrom: m(3) });
  });

  it('current month: D capped at today (IST) even if the set says later', async () => {
    const [y, mm] = CUR.split('-').map(Number);
    const now = new Date(Date.UTC(y, mm - 1, 10, 6, 30)); // 10th IST
    const w = world({ outlets: [{ code: 'A' }], targets: [target('A', CUR)], sets: [{ month: CUR, lastDay: 14 }] });
    expect((await load(w, CUR, {}, now)).d.compareDay).toBe(10);
  });

  it('selected month without day data → NO_DAY_DATA_FOR_MONTH, compareDay null, availableFrom given', async () => {
    const w = base();
    const { d } = await load(w, m(-8)); // before the first set
    expect(d.reason).toBe('NO_DAY_DATA_FOR_MONTH');
    expect(d.compareDay).toBeNull();
    expect(d.current.mtd).toBeNull();
    expect(d.lastMonth.available).toBe(false);
    expect(d.lastMonth.availableFrom).toBe(P2); // m(-6): its prior m(-7) has data
  });

  it('non-salesImport tenant with no day data → NO_DAY_LEVEL_DATA (kpi still returned), no day reads', async () => {
    const w = base();
    w.features[T] = { salesImport: false };
    w.sets = [];
    const { d, prisma } = await load(w, SEL);
    expect(d.reason).toBe('NO_DAY_LEVEL_DATA');
    expect(d.kpi).toEqual({ code: 'TOTAL', label: 'Total sales', unit: 'INR' });
    expect(d.lastMonth).toMatchObject({ available: false, availableFrom: null });
    expect(d.threeMonthAvg).toMatchObject({ available: false, availableFrom: null });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('flag off but day data left from an earlier on-period → still compared (data is real)', async () => {
    const w = base();
    w.features[T] = {};
    expect((await load(w, SEL)).d.reason).toBeNull();
  });

  it('no enabled KPI → NO_KPI', async () => {
    const w = base();
    w.kpis = [];
    const { d } = await load(w, SEL);
    expect(d).toMatchObject({ reason: 'NO_KPI', kpi: null });
  });

  it('day rows exist but none carries the report KPI → KPI_NOT_IN_DAY_DATA (never a fake 0 vs 0)', async () => {
    const w = base();
    w.days = w.days.map((r) => ({ ...r, mtdValues: { OTHER: 5 } }));
    const { d } = await load(w, SEL);
    expect(d.reason).toBe('KPI_NOT_IN_DAY_DATA');
    expect(d.lastMonth.available).toBe(false);
  });

  it('deltaPct null when last month MTD is 0', async () => {
    const w = world({
      outlets: [{ code: 'A' }],
      targets: [target('A', SEL)],
      sets: [{ month: SEL, lastDay: 10 }, { month: P1, lastDay: 30 }],
      days: [day('A', SEL, 5, 50)],
    });
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

  it('tenant isolation: another tenant’s day rows / sets never count; reads are tenant-parameterised', async () => {
    const w = base();
    w.days.push({ ...day('A', SEL, 1, 1_000_000), clientId: 'deoleo' });
    w.sets.push({ clientId: 'deoleo', month: m(-9), lastDay: 30 });
    const { d, prisma } = await load(w, SEL);
    expect(d.current.mtd).toBe(700);
    for (const c of prisma.$queryRaw.mock.calls) expect(c[2]).toBe(T);
    // Deoleo: no flag, its own (one) set only, no KPI in this world → NO_KPI, never Bajaj's numbers.
    const other = await load(w, SEL, {}, new Date(), 'deoleo');
    expect(other.d.reason).toBe('NO_KPI');
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
  const SEL = m(-4);
  const P1 = m(-5);
  const w = () =>
    world({
      outlets: ['A', 'B', 'C', 'D'].map((code) => ({ code })),
      targets: ['A', 'B', 'C', 'D'].map((c) => target(c, SEL)),
      sets: [{ month: SEL, lastDay: 10 }, { month: P1, lastDay: 30 }],
      days: [
        day('A', SEL, 10, 10), day('A', P1, 10, 100), // 10%
        day('B', SEL, 10, 5), day('B', P1, 10, 100), // 5%
        day('C', SEL, 10, 50), day('C', P1, 10, 100), // 50%
        day('D', SEL, 10, 90), day('D', P1, 10, 100), // 90% → not slower
      ],
    });
  const user = { sub: 'u', role: 'CLIENT_ADMIN', clientId: T, phone: '', name: '' } as JwtPayload;

  it('pages the slower list (sorted), caps pageSize, validates params', async () => {
    const svc = new BillingComparisonDashboardService(makePrisma(w()) as unknown as PrismaService);
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
    const svc = new BillingComparisonDashboardService(prisma as unknown as PrismaService);
    const a = await svc.summary(user, { month: SEL });
    await svc.slowerOutlets(user, { month: SEL, page: '2', pageSize: '1' });
    expect(prisma.salesDaySet.findMany).toHaveBeenCalledTimes(1);
    const b = await svc.summary({ ...user, clientId: 'deoleo' }, { month: SEL });
    expect(a.current.mtd).toBe(155);
    expect(b.reason).toBe('NO_KPI');
    expect(svc.cacheSize).toBe(2);
  });
});

// ─── Export kind ────────────────────────────────────────────────────────────────────────────────

describe('billing-comparison-slower export kind', () => {
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

  it('writes exactly the on-screen list', async () => {
    const SEL = m(-4);
    const P1 = m(-5);
    const prisma = makePrisma(
      world({
        outlets: [{ code: 'A' }, { code: 'B' }],
        targets: [target('A', SEL), target('B', SEL)],
        sets: [{ month: SEL, lastDay: 10 }, { month: P1, lastDay: 30 }],
        days: [day('A', SEL, 10, 10), day('A', P1, 10, 100), day('B', SEL, 10, 100), day('B', P1, 10, 100)],
      }),
    );
    const { sheets, out } = sink();
    const params = BILLING_COMPARISON_SLOWER_KIND.parseParams({ month: SEL }, {} as JwtPayload);
    const res = await BILLING_COMPARISON_SLOWER_KIND.run({ prisma, clientId: T, now: new Date(), user: {} as JwtPayload, moduleRef: {} } as never, params, out as never);
    expect(res.rowCount).toBe(1);
    expect(sheets.map((s) => s.name)).toEqual(['About', 'Slower than usual']);
    expect(sheets[1].headers).toEqual([
      'Outlet Code', 'Outlet Name', 'Program', 'SO', 'ASM',
      'Billed this month to day 10 (₹)', 'Billed last month to day 10 (₹)', '% of last month',
    ]);
    expect(sheets[1].rows[0]).toEqual(['A', 'Outlet A', '', '', '', 10, 100, 10]);
  });

  it('unavailable comparison → About says why, no rows', async () => {
    const prisma = makePrisma(world({ outlets: [{ code: 'A' }], targets: [target('A', m(-4))], features: { [T]: {} } }));
    const { sheets, out } = sink();
    const params = BILLING_COMPARISON_SLOWER_KIND.parseParams({ month: m(-4) }, {} as JwtPayload);
    const res = await BILLING_COMPARISON_SLOWER_KIND.run({ prisma, clientId: T, now: new Date(), user: {} as JwtPayload, moduleRef: {} } as never, params, out as never);
    expect(res.rowCount).toBe(0);
    const about = Object.fromEntries(sheets[0].rows.map((r) => [r[0], r[1]]));
    expect(String(about.Status)).toContain('no day-by-day sales data');
  });
});
