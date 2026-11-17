// Billing progress (admin dashboard) — loader, buckets, pace, filters, outlets list + export kind.
// Run: npx jest src/admin-core/dashboards/billing-progress.spec.ts
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { istDateTimeCell, istMonthKey } from '../../common/ist-date';
import {
  BILLING_BUCKETS,
  NOT_COVERED_NOTE,
  bucketOf,
  clampAsOf,
  displayPct,
  loadBillingProgress,
  paceFor,
  parseBillingListKey,
  parseBillingProgressFilters,
  selectBillingRows,
  summarizeBillingProgress,
} from './billing-progress';
import {
  BILLING_CACHE_MAX_ENTRIES,
  BILLING_CACHE_TTL_MS,
  BillingProgressDashboardService,
} from './billing-progress-dashboard.service';
import { EXPORT_KINDS } from '../../exports/kinds';
import { BILLING_PROGRESS_OUTLETS_KIND, describeBillingExport } from '../../exports/kinds/batch2/billing-progress.kind';

/** A month key `delta` months from the current IST month — never a hard-coded date. */
function monthOffset(delta: number, from = new Date()): string {
  const [y, m] = istMonthKey(from).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

type OutletSeed = {
  code: string;
  program?: string | null;
  type?: string;
  sub?: string | null;
  reps?: string[];
  clientId?: string;
};

interface World {
  kpis: Array<Record<string, unknown> & { clientId: string }>;
  outlets: OutletSeed[];
  targets: Array<{ clientId?: string; outletCode: string; month: string; targetValues: Record<string, unknown> }>;
  sales: Array<{ clientId?: string; outletCode: string; month: string; kpiValues: Record<string, unknown>; updatedAt?: Date }>;
  salesUsers: Array<{ id: string; reportingToId: string | null; level: number; code: string; name: string; clientId?: string; isActive?: boolean }>;
  lastApply?: { importId: string; createdAt: Date; appliedById: string; definitionsSnapshot: unknown; clientId?: string; month: string } | null;
  monthSummaries?: unknown;
}

const T = 'bajaj';

function makePrisma(w: World) {
  const tenantOf = (r: { clientId?: string }) => r.clientId ?? T;
  return {
    kpiDef: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        w.kpis
          .filter((k) => k.clientId === where.clientId && (where.enabled === undefined || (k.enabled !== false) === where.enabled))
          .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || String(a.code).localeCompare(String(b.code)))
          .map((k) => ({ outletType: null, outletTypes: [], programs: [], subPrograms: [], unit: '', isPrimary: false, ...k })),
      ),
    },
    outlet: {
      findMany: jest.fn(async ({ where, distinct }: { where: { clientId: string }; distinct?: string[] }) => {
        const mine = w.outlets.filter((o) => tenantOf(o) === where.clientId);
        if (distinct) {
          // Raw distinct values (whitespace variants are distinct rows, exactly like Postgres DISTINCT).
          return [...new Set(mine.map((o) => o.program).filter((p): p is string => p !== null && p !== undefined))].sort().map((programName) => ({ programName }));
        }
        return mine.map((o) => ({
          outletCode: o.code,
          name: `Outlet ${o.code}`,
          programName: o.program ?? null,
          programCategory: o.sub ?? null,
          outletType: { code: o.type ?? 'RETAIL' },
          salesAssignments: (o.reps ?? []).map((salesUserId) => ({ salesUserId })),
        }));
      }),
    },
    salesUser: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string } }) =>
        w.salesUsers
          .filter((u) => (u.clientId ?? T) === where.clientId)
          .map((u) => ({
            id: u.id,
            reportingToId: u.reportingToId,
            isActive: u.isActive ?? true,
            employeeCode: u.id.toUpperCase(),
            user: { name: u.name },
            hierarchyLevel: { code: u.code, name: u.code === 'RSM' ? 'SM' : u.code, level: u.level },
          })),
      ),
    },
    salesHierarchyLevel: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string } }) =>
        [...new Set(w.salesUsers.filter((u) => (u.clientId ?? T) === where.clientId).map((u) => u.level))].map((level) => ({ level })),
      ),
    },
    outletTarget: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string; month: string } }) =>
        w.targets.filter((r) => tenantOf(r) === where.clientId && r.month === where.month),
      ),
    },
    outletSalesRecord: {
      findMany: jest.fn(async ({ where }: { where: { clientId: string; month: string } }) =>
        w.sales
          .filter((r) => tenantOf(r) === where.clientId && r.month === where.month)
          .map((r) => ({ ...r, updatedAt: r.updatedAt ?? new Date() })), // uploaded "now" unless a test says otherwise
      ),
    },
    salesImportApply: {
      findFirst: jest.fn(async ({ where }: { where: { clientId: string; month: string } }) =>
        w.lastApply && (w.lastApply.clientId ?? T) === where.clientId && w.lastApply.month === where.month ? w.lastApply : null,
      ),
    },
    salesImport: { findFirst: jest.fn(async () => ({ monthSummaries: w.monthSummaries ?? null })) },
  };
}

function world(partial: Partial<World> = {}): World {
  return {
    kpis: [{ clientId: T, code: 'TOTAL', label: 'Total sales', unit: 'INR', isPrimary: true, enabled: true, order: 0 }],
    outlets: [],
    targets: [],
    sales: [],
    salesUsers: [],
    lastApply: null,
    ...partial,
  };
}

const PAST = monthOffset(-2);

async function load(w: World, filters: Partial<Parameters<typeof loadBillingProgress>[2]> = {}, now = new Date(), clientId = T) {
  return loadBillingProgress(makePrisma(w) as unknown as PrismaService, clientId, {
    month: PAST, program: null, outletType: null, managerId: null, ...filters,
  }, now);
}

describe('bucketOf — edges (no rounding before bucketing)', () => {
  it.each([
    [100, 0, 'NOT_STARTED'],
    [100, -25, 'NOT_STARTED'], // net negative after returns
    [100, 0.01, 'P0_20'],
    [100, 19.99, 'P0_20'],
    [100, 20, 'P20_40'],
    [100, 39.999, 'P20_40'],
    [100, 40, 'P40_60'],
    [100, 60, 'P60_80'],
    [100, 80, 'P80_100'],
    [100, 99.99, 'P80_100'], // remaining 0.01 ≥ 0.005 → NOT met
    [100, 99.996, 'ACHIEVED'], // remaining 0.004 < 0.005 → snapped met
    [100, 100, 'ACHIEVED'],
    [100, 250, 'ACHIEVED'],
    [0.3, 0.1 + 0.2, 'ACHIEVED'], // float noise (0.30000000000000004)
  ])('target %p achieved %p → %s', (t, a, key) => {
    expect(bucketOf(t, a)).toBe(key);
  });

  it('a ₹5 Cr target ₹49 short is NOT met (absolute snap, never relative)', () => {
    expect(bucketOf(50_000_000, 50_000_000 - 49)).toBe('P80_100');
  });
});

describe('paceFor (IST, to the data date)', () => {
  /** The current IST month's `day`th at 12:00 IST — relative to now, never a hard-coded date. */
  const istNoonOn = (day: number) => {
    const [y, m] = istMonthKey(new Date()).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day, 6, 30));
  };
  const dateKeyOf = (month: string, day: number) => `${month}-${String(day).padStart(2, '0')}`;

  it('N2 past month with data through its end → whole month, 100%, as of the month’s last day', () => {
    const p = paceFor(PAST, new Date(), istDateKeyNow());
    expect(p.monthStatus).toBe('PAST');
    expect(p.fullMonth).toBe(true);
    expect(p.daysElapsed).toBe(p.daysInMonth);
    expect(p.pacePct).toBe(100);
    expect(p.paceAsOf).toBe(dateKeyOf(PAST, p.daysInMonth));
  });

  it('D4 past month whose data stops early → paced to the data date, not "full month"', () => {
    const dim = daysInMonthOfKey(PAST);
    const p = paceFor(PAST, new Date(), dateKeyOf(PAST, 10));
    expect(p).toEqual({
      monthStatus: 'PAST', daysInMonth: dim, daysElapsed: 10,
      pacePct: Math.round((10 / dim) * 100), paceAsOf: dateKeyOf(PAST, 10), fullMonth: false,
    });
  });

  it('D4 a future-dated asOf is clamped to today', () => {
    expect(clampAsOf('2999-01-01', new Date())).toBe(istDateKeyNow());
    expect(clampAsOf('2000-01-01', new Date())).toBe('2000-01-01');
    expect(clampAsOf(null, new Date())).toBeNull();
  });

  it('N2 future month → no pace', () => {
    const p = paceFor(monthOffset(2), new Date(), dateKeyOf(monthOffset(2), 1));
    expect(p).toMatchObject({ monthStatus: 'FUTURE', daysElapsed: null, pacePct: null, paceAsOf: null });
  });

  it('N2 asOf null → no pace, whatever the month', () => {
    for (const m of [PAST, istMonthKey(new Date())]) {
      expect(paceFor(m, new Date(), null)).toMatchObject({ daysElapsed: null, pacePct: null, paceAsOf: null });
    }
  });

  it('N2 current month → IST day of min(asOf, today), not today', () => {
    const now = istNoonOn(20);
    const month = istMonthKey(now);
    const dim = daysInMonthOfKey(month);
    // Data stops at the 12th → pace to the 12th.
    expect(paceFor(month, now, dateKeyOf(month, 12))).toEqual({
      monthStatus: 'CURRENT', daysInMonth: dim, daysElapsed: 12,
      pacePct: Math.round((12 / dim) * 100), paceAsOf: dateKeyOf(month, 12), fullMonth: false,
    });
    // asOf after today (future-dated invoice) → capped at today.
    expect(paceFor(month, now, dateKeyOf(month, 25)).daysElapsed).toBe(20);
    // asOf before the month began → 0 days covered.
    expect(paceFor(month, now, '2000-01-01')).toMatchObject({ daysElapsed: 0, pacePct: 0 });
  });

  it('00:30 IST on the 1st is day 1 of the NEW month (not the UTC previous day)', () => {
    const [y, m] = istMonthKey(new Date()).split('-').map(Number);
    const now = new Date(Date.UTC(y, m - 1, 1, 0, 30) - 330 * 60_000); // 00:30 IST on the 1st
    const month = `${y}-${String(m).padStart(2, '0')}`;
    expect(istMonthKey(now)).toBe(month);
    expect(paceFor(month, now, dateKeyOf(month, 1)).daysElapsed).toBe(1);
  });
});

function istDateKeyNow(): string {
  const d = new Date(Date.now() + 330 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function daysInMonthOfKey(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

describe('N3 displayPct + labels', () => {
  it('labels read as bands', () => {
    expect(BILLING_BUCKETS.map((b) => b.label)).toEqual([
      'Not started', 'Under 20%', '20–39%', '40–59%', '60–79%', '80–99%', 'Achieved (100%+)',
    ]);
  });

  it.each([
    [100, 99.96, 'P80_100', 99.9], // floored, never rounded up to 100.0
    [100, 99.99, 'P80_100', 99.9], // remaining 0.01 ≥ 0.005 → not met
    [100, 99.996, 'ACHIEVED', 100], // snapped met → shows 100
    [100, 250, 'ACHIEVED', 250],
    [100, 19.99, 'P0_20', 19.9],
    [100_000, 1, 'P0_20', 0.1], // a started outlet never reads 0.0%
    [100, 20, 'P20_40', 20],
    [100, 0, 'NOT_STARTED', 0],
    [100, -10, 'NOT_STARTED', -10],
  ])('target %p achieved %p → %s shows %p', (t, a, bucketKey, shown) => {
    const bucket = bucketOf(t, a);
    expect(bucket).toBe(bucketKey);
    expect(displayPct(t, a, bucket)).toBe(shown);
  });

  it('the shown pct never leaves its bucket’s band (sweep incl. float-noise edges)', () => {
    const targets = [3, 7, 100, 333.33, 12_345_678];
    for (const t of targets) {
      for (let i = -5; i <= 1100; i++) {
        const a = (t * i) / 1000;
        const bucket = bucketOf(t, a);
        const p = displayPct(t, a, bucket);
        const b = BILLING_BUCKETS.find((x) => x.key === bucket)!;
        expect(p).toBeGreaterThanOrEqual(b.lo);
        expect(p).toBeLessThanOrEqual(b.hi);
        if (bucket !== 'ACHIEVED') expect(p).toBeLessThan(100);
      }
    }
  });
});

describe('loadBillingProgress + summary', () => {
  const base = (): World =>
    world({
      outlets: [
        { code: 'A', program: 'Gold' },
        { code: 'B', program: 'Gold' },
        { code: 'C', program: 'Silver', type: 'WHOLESALE' },
        { code: 'D', program: 'Silver' }, // no target row
        { code: 'E', program: 'Gold' }, // zero target
      ],
      targets: [
        { outletCode: 'A', month: PAST, targetValues: { TOTAL: 1000 } },
        { outletCode: 'B', month: PAST, targetValues: { TOTAL: 500 } },
        { outletCode: 'C', month: PAST, targetValues: { TOTAL: 200, OTHER: 5 } },
        { outletCode: 'E', month: PAST, targetValues: { TOTAL: 0, OTHER: 9 } },
        { outletCode: 'GHOST', month: PAST, targetValues: { TOTAL: 999 } }, // not an addressable outlet
      ],
      sales: [
        { outletCode: 'A', month: PAST, kpiValues: { TOTAL: 1000 } },
        { outletCode: 'B', month: PAST, kpiValues: { TOTAL: 99 } },
        { outletCode: 'C', month: PAST, kpiValues: { TOTAL: -10 } },
      ],
    });

  it('buckets, totals, no-target separation and behind-pace on a past month (pace 100)', async () => {
    const s = summarizeBillingProgress(await load(base()));
    expect(s.kpi).toEqual({ code: 'TOTAL', label: 'Total sales', unit: 'INR' });
    expect(s.pacePct).toBe(100);
    expect(s.outletsInScope).toBe(3);
    expect(s.outletsWithoutTarget).toBe(2); // D (no row) + E (zero) — never in buckets
    expect(s.totals).toEqual({ targetSum: 1700, achievedSum: 1089 });
    const byKey = Object.fromEntries(s.buckets.map((b) => [b.key, b]));
    expect(s.buckets.map((b) => b.key)).toEqual(['NOT_STARTED', 'P0_20', 'P20_40', 'P40_60', 'P60_80', 'P80_100', 'ACHIEVED']);
    expect(byKey.ACHIEVED.count).toBe(1);
    expect(byKey.P0_20).toMatchObject({ count: 1, targetSum: 500, achievedSum: 99, pctOfOutlets: 33.3 });
    expect(byKey.NOT_STARTED).toMatchObject({ count: 1, achievedSum: -10 });
    expect(s.buckets.reduce((a, b) => a + b.count, 0)).toBe(s.outletsInScope);
    expect(s.behindPace).toEqual({ count: 2, targetSum: 700, achievedSum: 89 });
    expect(s.availablePrograms).toEqual(['Gold', 'Silver']);
    expect(s.availableOutletTypes).toEqual(['RETAIL', 'WHOLESALE']);
    expect(s.outletsNotCovered).toBe(0);
    expect(s.monthStatus).toBe('PAST');
    expect(s.paceAsOf).toBe(`${PAST}-${String(daysInMonthOfKey(PAST)).padStart(2, '0')}`);
  });

  it('N7 target rows for outlets outside the live roster are counted, never dropped silently', async () => {
    const s = summarizeBillingProgress(await load(base()));
    expect(s.targetsOutsideRoster).toBe(1); // GHOST (999)
    const w = base();
    w.targets.push({ outletCode: 'GONE', month: PAST, targetValues: { OTHER: 50 } }); // no target for THIS KPI
    w.targets.push({ outletCode: 'GONE2', month: PAST, targetValues: { TOTAL: 0 } }); // zero target
    expect(summarizeBillingProgress(await load(w)).targetsOutsideRoster).toBe(1);
    // A program filter doesn't hide them (they can't be attributed to a program) — tenant-wide.
    expect(summarizeBillingProgress(await load(base(), { program: 'Gold' })).targetsOutsideRoster).toBe(1);
  });

  it('N6 program whitespace: dropdown trimmed + distinct; filtering matches every raw variant', async () => {
    const w = base();
    w.outlets[1].program = 'Gold '; // B
    w.outlets.push({ code: 'F', program: '  Gold' }, { code: 'G', program: '   ' });
    w.targets.push({ outletCode: 'F', month: PAST, targetValues: { TOTAL: 10 } });
    const d = await load(w, { program: 'Gold' });
    const s = summarizeBillingProgress(d);
    expect(s.availablePrograms).toEqual(['Gold', 'Silver']);
    expect(s.outletsInScope).toBe(3); // A, B ("Gold "), F ("  Gold")
    expect(d.inScope.find((r) => r.outletCode === 'B')?.program).toBe('Gold'); // shown trimmed
  });

  it('program / outletType filters; unknown program → zeros (not an error); dropdowns stay full', async () => {
    const gold = summarizeBillingProgress(await load(base(), { program: 'Gold' }));
    expect(gold.outletsInScope).toBe(2);
    expect(gold.outletsWithoutTarget).toBe(1);
    const ws = summarizeBillingProgress(await load(base(), { outletType: 'WHOLESALE' }));
    expect(ws.outletsInScope).toBe(1);
    const none = summarizeBillingProgress(await load(base(), { program: 'Nope' }));
    expect(none.outletsInScope).toBe(0);
    expect(none.totals).toEqual({ targetSum: 0, achievedSum: 0 });
    expect(none.availablePrograms).toEqual(['Gold', 'Silver']);
  });

  it('manager filter = assigned rep is the manager or anywhere in their downline; foreign id → nothing', async () => {
    const w = base();
    w.salesUsers = [
      { id: 'rsm', reportingToId: null, level: 4, code: 'RSM', name: 'Rita' },
      { id: 'asm1', reportingToId: 'rsm', level: 3, code: 'ASM', name: 'Asha' },
      { id: 'asm2', reportingToId: 'rsm', level: 3, code: 'ASM', name: 'Bala' },
      { id: 'so1', reportingToId: 'asm1', level: 2, code: 'SO', name: 'Sonu' },
      { id: 'isr1', reportingToId: 'so1', level: 1, code: 'XSR', name: 'Ira' },
      { id: 'so2', reportingToId: 'asm2', level: 2, code: 'SO', name: 'Om' },
      { id: 'other', reportingToId: null, level: 3, code: 'ASM', name: 'Other tenant', clientId: 'deoleo' },
    ];
    w.outlets[0].reps = ['isr1']; // A under asm1
    w.outlets[1].reps = ['so2']; // B under asm2
    const a1 = await load(w, { managerId: 'asm1' });
    expect(a1.inScope.map((r) => r.outletCode)).toEqual(['A']);
    expect(a1.inScope[0]).toMatchObject({ soName: 'Sonu', asmName: 'Asha' });
    const r = await load(w, { managerId: 'rsm' });
    expect(r.inScope.map((x) => x.outletCode).sort()).toEqual(['A', 'B']);
    expect((await load(w, { managerId: 'other' })).inScope).toEqual([]);
    // availableManagers: above field level (ISR=1), this tenant only, senior first.
    expect(a1.availableManagers.map((m) => m.id)).toEqual(['rsm', 'asm1', 'asm2', 'so2', 'so1']);
    expect(a1.availableManagers[0]).toEqual({ id: 'rsm', name: 'Rita', levelCode: 'RSM', levelName: 'SM' });
  });

  it('N1 applies-to: outlets outside the KPI scope are NOT dropped — counted as not covered + listed', async () => {
    const w = base();
    w.kpis[0].programs = ['Gold'];
    const d = await load(w);
    const s = summarizeBillingProgress(d);
    expect(s.outletsInScope).toBe(2); // A, B (C is Silver)
    expect(s.outletsWithoutTarget).toBe(1); // E only — D is Silver, out of scope
    expect(s.outletsNotCovered).toBe(2); // C, D
    const nc = selectBillingRows(d, 'NOT_COVERED');
    expect(nc.map((r) => r.outletCode)).toEqual(['C', 'D']);
    // D7: C shows its REAL stored values with a "not counted" note — but they never enter a sum.
    expect(nc[0]).toMatchObject({ target: 200, achieved: -10, pct: null, note: NOT_COVERED_NOTE });
    expect(nc[1]).toMatchObject({ outletCode: 'D', target: 0, achieved: 0, note: NOT_COVERED_NOTE });
    expect(s.totals.targetSum).toBe(1500);
    expect(s.totals.achievedSum).toBe(1099); // A 1000 + B 99 — C's -10 not counted
    // Filters narrow the not-covered count too.
    expect(summarizeBillingProgress(await load(w, { outletType: 'WHOLESALE' })).outletsNotCovered).toBe(1);
  });

  it('N1 KPI choice: no primary flagged → first ENABLED by order, then code', async () => {
    const w = base();
    w.kpis = [
      { clientId: T, code: 'ZED', label: 'Zed', isPrimary: false, enabled: true, order: 1 },
      { clientId: T, code: 'TOTAL', label: 'Total sales', isPrimary: false, enabled: true, order: 0 },
      { clientId: T, code: 'AAA', label: 'Aaa', isPrimary: false, enabled: false, order: 0 },
    ];
    expect((await load(w)).kpi?.code).toBe('TOTAL');
    w.kpis[1].order = 1; // tie on order → code (TOTAL < ZED)
    expect((await load(w)).kpi?.code).toBe('TOTAL');
    w.kpis.push({ clientId: T, code: 'ABC', label: 'Abc', isPrimary: false, enabled: true, order: 1 });
    expect((await load(w)).kpi?.code).toBe('ABC');
  });

  it('N1 KPI choice: a DISABLED primary falls back to the first enabled KPI; the report stays on ONE KPI', async () => {
    const w = base();
    w.kpis[0].enabled = false; // TOTAL is flagged primary but disabled
    w.kpis.push({ clientId: T, code: 'OTHER', label: 'Other', unit: 'cases', isPrimary: false, enabled: true, order: 5 });
    const s = summarizeBillingProgress(await load(w));
    expect(s.kpi).toEqual({ code: 'OTHER', label: 'Other', unit: 'cases' });
    // Only OTHER targets are summed (C: 5, E: 9) — never TOTAL's.
    expect(s.totals.targetSum).toBe(14);
    expect(s.outletsInScope).toBe(2);
  });

  it('N1 an enabled primary wins over order', async () => {
    const w = base();
    w.kpis[0].order = 9;
    w.kpis.push({ clientId: T, code: 'AAA', label: 'A', isPrimary: false, enabled: true, order: 0 });
    expect((await load(w)).kpi?.code).toBe('TOTAL');
  });

  it('N1 no ENABLED KPI at all → kpi null, empty buckets, dropdowns still served', async () => {
    const w = base();
    w.kpis = [{ clientId: T, code: 'TOTAL', label: 'T', isPrimary: true, enabled: false }];
    const s = summarizeBillingProgress(await load(w));
    expect(s.kpi).toBeNull();
    expect(s.outletsInScope).toBe(0);
    expect(s.outletsWithoutTarget).toBe(0);
    expect(s.outletsNotCovered).toBe(0);
    expect(s.targetsOutsideRoster).toBe(0);
    expect(s.buckets.every((b) => b.count === 0)).toBe(true);
    expect(s.availablePrograms).toEqual(['Gold', 'Silver']);
  });

  it('tenant isolation: another tenant’s outlets / targets / KPIs never appear', async () => {
    const w = base();
    w.outlets.push({ code: 'X', program: 'Gold', clientId: 'deoleo' });
    w.targets.push({ clientId: 'deoleo', outletCode: 'A', month: PAST, targetValues: { TOTAL: 1 } });
    const s = summarizeBillingProgress(await load(w));
    expect(s.totals.targetSum).toBe(1700);
    const other = summarizeBillingProgress(await load(w, {}, new Date(), 'deoleo'));
    expect(other.kpi).toBeNull(); // deoleo has no KpiDef in this world
    expect(other.availablePrograms).toEqual(['Gold']);
  });

  it('asOf: importer-owned primary → last applied invoice date; otherwise latest sales updatedAt (IST date)', async () => {
    const w = base();
    for (const r of w.sales) r.updatedAt = new Date(Date.UTC(2020, 0, 1));
    w.sales[0].updatedAt = new Date(Date.UTC(2020, 0, 5, 20, 0)); // 01:30 IST on the 6th
    expect((await load(w)).asOf).toBe('2020-01-06');
    w.lastApply = { importId: 'i1', createdAt: new Date(), appliedById: 'u', definitionsSnapshot: [{ kpiCode: 'TOTAL' }], month: PAST };
    w.monthSummaries = [{ month: PAST, lastDate: '2020-01-04' }];
    expect((await load(w)).asOf).toBe('2020-01-04');
    w.lastApply.definitionsSnapshot = [{ kpiCode: 'FOCUS' }]; // importer does not own the primary
    expect((await load(w)).asOf).toBe('2020-01-06');
  });

  it('D3 asOf comes ONLY from sales records carrying the report KPI — another KPI’s upload → null', async () => {
    const w = base();
    w.sales = [{ outletCode: 'A', month: PAST, kpiValues: { OTHER: 5 }, updatedAt: new Date() }];
    const s = summarizeBillingProgress(await load(w));
    expect(s.asOf).toBeNull();
    expect(s.pacePct).toBeNull();
    // A record with the key (even a 0) counts.
    w.sales.push({ outletCode: 'B', month: PAST, kpiValues: { TOTAL: 0 }, updatedAt: new Date(Date.UTC(2020, 0, 5, 20, 0)) });
    expect((await load(w)).asOf).toBe('2020-01-06');
  });

  it('D4 a future-dated importer invoice date is clamped to today in the response', async () => {
    const w = base();
    w.lastApply = { importId: 'i1', createdAt: new Date(), appliedById: 'u', definitionsSnapshot: [{ kpiCode: 'TOTAL' }], month: PAST };
    w.monthSummaries = [{ month: PAST, lastDate: '2999-12-31' }];
    expect((await load(w)).asOf).toBe(istDateKeyNow());
  });

  it('D4 past month with partial data → paced to the data date, behind pace (not missed target)', async () => {
    const w = base();
    const tenth = new Date(Date.UTC(Number(PAST.slice(0, 4)), Number(PAST.slice(5, 7)) - 1, 10, 6, 30));
    for (const r of w.sales) r.updatedAt = tenth;
    const s = summarizeBillingProgress(await load(w));
    expect(s).toMatchObject({ monthStatus: 'PAST', fullMonth: false, daysElapsed: 10, paceAsOf: `${PAST}-10` });
    expect(s.pacePct).toBe(Math.round((10 / daysInMonthOfKey(PAST)) * 100));
  });

  it('current-month pace drives behind-pace', async () => {
    const [y, m] = istMonthKey(new Date()).split('-').map(Number);
    const now = new Date(Date.UTC(y, m - 1, 15, 6, 30)); // 15th IST
    const month = istMonthKey(now);
    const w = world({
      outlets: [{ code: 'A' }, { code: 'B' }],
      targets: [
        { outletCode: 'A', month, targetValues: { TOTAL: 100 } },
        { outletCode: 'B', month, targetValues: { TOTAL: 100 } },
      ],
      sales: [
        { outletCode: 'A', month, kpiValues: { TOTAL: 10 }, updatedAt: now },
        { outletCode: 'B', month, kpiValues: { TOTAL: 90 }, updatedAt: now },
      ],
    });
    const s = summarizeBillingProgress(await load(w, { month: null }, now));
    expect(s.month).toBe(month);
    expect(s.daysElapsed).toBe(15);
    expect(s.paceAsOf).toBe(`${month}-15`);
    expect(s.behindPace.count).toBe(1); // A (10% < ~50%)
  });

  it('N2 current month: data uploaded up to the 3rd → paced to the 3rd, not today', async () => {
    const [y, m] = istMonthKey(new Date()).split('-').map(Number);
    const now = new Date(Date.UTC(y, m - 1, 20, 6, 30)); // 20th IST
    const dataAt = new Date(Date.UTC(y, m - 1, 3, 6, 30)); // last upload on the 3rd IST
    const month = istMonthKey(now);
    const w = world({
      outlets: [{ code: 'A' }],
      targets: [{ outletCode: 'A', month, targetValues: { TOTAL: 100 } }],
      sales: [{ outletCode: 'A', month, kpiValues: { TOTAL: 15 }, updatedAt: dataAt }], // 15% ≥ ~10% pace to the 3rd
    });
    const s = summarizeBillingProgress(await load(w, { month: null }, now));
    expect(s.daysElapsed).toBe(3);
    expect(s.paceAsOf).toBe(`${month}-03`);
    expect(s.behindPace.count).toBe(0); // paced to today (20th, ~65%) it would wrongly be behind
  });

  it('N2 / F2 no sales for the month → asOf null, no pace, nobody behind; target total kept', async () => {
    const [y, m] = istMonthKey(new Date()).split('-').map(Number);
    const now = new Date(Date.UTC(y, m - 1, 20, 6, 30));
    const month = istMonthKey(now);
    const w = world({ outlets: [{ code: 'A' }], targets: [{ outletCode: 'A', month, targetValues: { TOTAL: 100 } }] });
    const s = summarizeBillingProgress(await load(w, { month: null }, now));
    expect(s).toMatchObject({ asOf: null, daysElapsed: null, pacePct: null, paceAsOf: null, monthStatus: 'CURRENT' });
    expect(s.behindPace.count).toBe(0);
    expect(s.totals.targetSum).toBe(100);
  });
});

describe('outlets list + parsing', () => {
  const w = (): World =>
    world({
      outlets: ['A', 'B', 'C', 'D'].map((code) => ({ code })),
      targets: [
        { outletCode: 'A', month: PAST, targetValues: { TOTAL: 100 } },
        { outletCode: 'B', month: PAST, targetValues: { TOTAL: 300 } },
        { outletCode: 'C', month: PAST, targetValues: { TOTAL: 200 } },
        { outletCode: 'D', month: PAST, targetValues: { TOTAL: 50 } },
      ],
      sales: [
        { outletCode: 'A', month: PAST, kpiValues: { TOTAL: 10 } }, // 10%
        { outletCode: 'B', month: PAST, kpiValues: { TOTAL: 15 } }, // 5%
        { outletCode: 'C', month: PAST, kpiValues: { TOTAL: 20 } }, // 10%
        { outletCode: 'D', month: PAST, kpiValues: { TOTAL: 9 } }, // 18%
      ],
    });

  it('sorts by pct ascending then target descending', async () => {
    const rows = selectBillingRows(await load(w()), 'P0_20');
    expect(rows.map((r) => r.outletCode)).toEqual(['B', 'C', 'A', 'D']);
  });

  it('service pages the list (pageSize capped at 200) and validates the bucket', async () => {
    const svc = new BillingProgressDashboardService(makePrisma(w()) as unknown as PrismaService);
    const user = { sub: 'u', role: 'CLIENT_ADMIN', clientId: T, phone: '', name: '' } as JwtPayload;
    const p1 = await svc.outlets(user, { month: PAST, bucket: 'P0_20', page: '1', pageSize: '2' });
    expect(p1).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(p1.rows.map((r) => r.outletCode)).toEqual(['B', 'C']);
    expect(p1.rows[0]).toEqual({
      outletCode: 'B', outletName: 'Outlet B', program: null, outletType: 'RETAIL', soName: null, asmName: null,
      target: 300, achieved: 15, pct: 5, note: null,
    });
    const p2 = await svc.outlets(user, { month: PAST, bucket: 'P0_20', page: '2', pageSize: '2' });
    expect(p2.rows.map((r) => r.outletCode)).toEqual(['A', 'D']);
    expect((await svc.outlets(user, { month: PAST, bucket: 'BEHIND_PACE', pageSize: '999' })).pageSize).toBe(200);
    await expect(svc.outlets(user, { month: PAST, bucket: 'NOPE' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.outlets(user, { month: PAST })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.outlets(user, { month: PAST, bucket: 'P0_20', page: '0' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('service summary is tenant-keyed (cache never leaks across tenants)', async () => {
    const svc = new BillingProgressDashboardService(makePrisma(w()) as unknown as PrismaService);
    const a = await svc.summary({ sub: 'u', role: 'CLIENT_ADMIN', clientId: T } as JwtPayload, { month: PAST });
    const b = await svc.summary({ sub: 'u', role: 'CLIENT_ADMIN', clientId: 'deoleo' } as JwtPayload, { month: PAST });
    expect(a.outletsInScope).toBe(4);
    expect(b.outletsInScope).toBe(0);
  });

  it('N4 cache: hit within the TTL; expired entries evicted on every read/write; capped at 10', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const prisma = makePrisma(w());
      const svc = new BillingProgressDashboardService(prisma as unknown as PrismaService);
      const user = { sub: 'u', role: 'CLIENT_ADMIN', clientId: T } as JwtPayload;
      await svc.summary(user, { month: PAST });
      await svc.summary(user, { month: PAST });
      expect(prisma.outletTarget.findMany).toHaveBeenCalledTimes(1); // cached
      await svc.summary(user, { month: PAST, program: 'Gold' }); // different filters → different key
      expect(prisma.outletTarget.findMany).toHaveBeenCalledTimes(2);
      expect(svc.cacheSize).toBe(2);
      // Expire both; ANY read evicts them (not only the key being read).
      jest.setSystemTime(Date.now() + BILLING_CACHE_TTL_MS + 1);
      await svc.summary(user, { month: PAST, outletType: 'RETAIL' });
      expect(svc.cacheSize).toBe(1);
      // A re-read of an expired key reloads.
      await svc.summary(user, { month: PAST });
      expect(prisma.outletTarget.findMany).toHaveBeenCalledTimes(4);
      // Cap.
      for (let i = 0; i < BILLING_CACHE_MAX_ENTRIES + 5; i++) await svc.summary(user, { month: PAST, managerId: `m${i}` });
      expect(svc.cacheSize).toBe(BILLING_CACHE_MAX_ENTRIES);
    } finally {
      jest.useRealTimers();
    }
  });

  it('D7 export: NOT_COVERED rows carry real values + the "not counted" note', async () => {
    const wv = world({
      kpis: [{ clientId: T, code: 'TOTAL', label: 'Total sales', unit: 'INR', isPrimary: true, enabled: true, programs: ['Gold'] }],
      outlets: [{ code: 'S', program: 'Silver' }],
      targets: [{ outletCode: 'S', month: PAST, targetValues: { TOTAL: 300 } }],
      sales: [{ outletCode: 'S', month: PAST, kpiValues: { TOTAL: 120 } }],
    });
    const sheets: Array<{ name: string; rows: unknown[][] }> = [];
    const out = {
      addSheet: async (name: string) => {
        const sh = { name, rows: [] as unknown[][] };
        sheets.push(sh);
        return { addRow: async (r: unknown[]) => void sh.rows.push(r), rowCount: 0 };
      },
    };
    const params = BILLING_PROGRESS_OUTLETS_KIND.parseParams({ bucket: 'NOT_COVERED', month: PAST }, {} as JwtPayload);
    await BILLING_PROGRESS_OUTLETS_KIND.run(
      { prisma: makePrisma(wv), clientId: T, now: new Date(), user: {} as JwtPayload, moduleRef: {} } as never,
      params,
      out as never,
    );
    expect(sheets[1].rows).toEqual([['S', 'Outlet S', 'Silver', 'RETAIL', '', '', 300, 120, '', NOT_COVERED_NOTE]]);
  });

  it('NOT_COVERED is a valid list key', () => {
    expect(parseBillingListKey('NOT_COVERED')).toBe('NOT_COVERED');
  });

  it('parses / validates filters', () => {
    expect(parseBillingProgressFilters({ month: ' ', program: '  Gold ', outletType: '', requestOrigin: 'x' })).toEqual({
      month: null, program: 'Gold', outletType: null, managerId: null,
    });
    expect(() => parseBillingProgressFilters({ month: '2026-13' })).toThrow(BadRequestException);
    expect(() => parseBillingProgressFilters({ program: 'x'.repeat(201) })).toThrow(BadRequestException);
    expect(() => parseBillingProgressFilters({ program: ['a', 'b'] })).toThrow(BadRequestException);
    expect(parseBillingListKey('NO_TARGET')).toBe('NO_TARGET');
  });
});

describe('billing-progress-outlets export kind', () => {
  it('is registered with the dashboard’s access', () => {
    expect(EXPORT_KINDS.get('billing-progress-outlets')).toBe(BILLING_PROGRESS_OUTLETS_KIND);
    expect(BILLING_PROGRESS_OUTLETS_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'], permission: 'reports:read' });
    const p = BILLING_PROGRESS_OUTLETS_KIND.parseParams({ bucket: 'BEHIND_PACE', month: '2026-10' }, {} as JwtPayload);
    expect(BILLING_PROGRESS_OUTLETS_KIND.isHeavy(p)).toBe(false);
    // D8: past month → "Missed target" (same wording as the About sheet); current month → "Behind pace".
    expect(BILLING_PROGRESS_OUTLETS_KIND.describeParams(p)).toBe('Billing progress — Missed target — Oct 2026');
    const cur = istMonthKey(new Date());
    const pc = BILLING_PROGRESS_OUTLETS_KIND.parseParams({ bucket: 'BEHIND_PACE', month: cur }, {} as JwtPayload);
    expect(describeBillingExport(pc)).toMatch(/^Billing progress — Behind pace — /);
    const pn = BILLING_PROGRESS_OUTLETS_KIND.parseParams({ bucket: 'BEHIND_PACE' }, {} as JwtPayload);
    expect(describeBillingExport(pn)).toBe('Billing progress — Behind pace — current month');
    expect(BILLING_PROGRESS_OUTLETS_KIND.fileName(p, new Date())).toBe('billing-progress-behind-pace-2026-10.xlsx');
  });

  it('writes exactly the on-screen list for the bucket', async () => {
    const prisma = makePrisma(
      world({
        outlets: [{ code: 'A' }, { code: 'B' }],
        targets: [
          { outletCode: 'A', month: PAST, targetValues: { TOTAL: 100 } },
          { outletCode: 'B', month: PAST, targetValues: { TOTAL: 100 } },
        ],
        sales: [{ outletCode: 'A', month: PAST, kpiValues: { TOTAL: 100 } }],
      }),
    );
    const sheets: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [];
    const out = {
      addSheet: async (name: string, h: string[]) => {
        const sh = { name, headers: h, rows: [] as unknown[][] };
        sheets.push(sh);
        return { addRow: async (r: unknown[]) => void sh.rows.push(r), rowCount: 0 };
      },
    };
    const params = BILLING_PROGRESS_OUTLETS_KIND.parseParams({ bucket: 'NOT_STARTED', month: PAST }, {} as JwtPayload);
    const res = await BILLING_PROGRESS_OUTLETS_KIND.run(
      { prisma, clientId: T, now: new Date(), user: {} as JwtPayload, moduleRef: {} } as never,
      params,
      out as never,
    );
    expect(res.rowCount).toBe(1);
    expect(sheets.map((x) => x.name)).toEqual(['About', 'Billing progress']);
    // Same word as the screen ("Billed") + units in the headers.
    expect(sheets[1].headers).toEqual([
      'Outlet Code', 'Outlet Name', 'Program', 'Outlet Type', 'SO', 'ASM',
      'Target (₹)', 'Billed (₹)', 'Achievement %', 'Note',
    ]);
    expect(sheets[1].rows[0]).toEqual(['B', 'Outlet B', '', 'RETAIL', '', '', 100, 0, 0, '']);
  });

  it('N9 About sheet: month, KPI, filters (manager NAME), data as of, generated at (IST); non-INR units', async () => {
    const prisma = makePrisma(
      world({
        kpis: [{ clientId: T, code: 'CS', label: 'Cases', unit: 'cases', isPrimary: true, enabled: true }],
        outlets: [{ code: 'A', program: 'Gold', reps: ['so1'] }],
        targets: [{ outletCode: 'A', month: PAST, targetValues: { CS: 10 } }],
        sales: [{ outletCode: 'A', month: PAST, kpiValues: { CS: 2 }, updatedAt: new Date() }],
        salesUsers: [
          { id: 'asm1', reportingToId: null, level: 3, code: 'ASM', name: 'Asha' },
          { id: 'so1', reportingToId: 'asm1', level: 2, code: 'SO', name: 'Sonu' },
        ],
      }),
    );
    const sheets: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [];
    const out = {
      addSheet: async (name: string, h: string[]) => {
        const sh = { name, headers: h, rows: [] as unknown[][] };
        sheets.push(sh);
        return { addRow: async (r: unknown[]) => void sh.rows.push(r), rowCount: 0 };
      },
    };
    const now = new Date();
    const params = BILLING_PROGRESS_OUTLETS_KIND.parseParams(
      { bucket: 'BEHIND_PACE', month: PAST, program: 'Gold', outletType: 'RETAIL', managerId: 'asm1' },
      {} as JwtPayload,
    );
    const res = await BILLING_PROGRESS_OUTLETS_KIND.run(
      { prisma, clientId: T, now, user: {} as JwtPayload, moduleRef: {} } as never,
      params,
      out as never,
    );
    expect(res.rowCount).toBe(1); // About rows are not counted as data rows
    const about = Object.fromEntries(sheets[0].rows.map((r) => [r[0], r[1]]));
    const [py, pm] = PAST.split('-').map(Number);
    expect(about.Month).toBe(`${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][pm - 1]} ${py}`);
    expect(about.KPI).toBe('Cases (CS)');
    expect(about.List).toBe('Missed target'); // past-month wording
    expect(about.Program).toBe('Gold');
    expect(about['Outlet type']).toBe('RETAIL');
    expect(about.Manager).toBe('Asha (and their team)');
    expect(about['Data as of']).toBe(istDateKeyNow());
    expect(about['Generated at (IST)']).toBe(istDateTimeCell(now));
    expect(String(about.Note)).toContain('KYC is still pending');
    expect(String(about['Target rows not in the live roster (tenant-wide)'])).toMatch(/^0 — /);
    expect(sheets[1].headers.slice(6, 8)).toEqual(['Target (cases)', 'Billed (cases)']);
  });
});
