// Billing progress (admin dashboard) — loader, buckets, pace, filters, outlets list + export kind.
// Run: npx jest src/admin-core/dashboards/billing-progress.spec.ts
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { istMonthKey } from '../../common/ist-date';
import {
  bucketOf,
  loadBillingProgress,
  paceFor,
  parseBillingListKey,
  parseBillingProgressFilters,
  selectBillingRows,
  summarizeBillingProgress,
} from './billing-progress';
import { BillingProgressDashboardService } from './billing-progress-dashboard.service';
import { EXPORT_KINDS } from '../../exports/kinds';
import { BILLING_PROGRESS_OUTLETS_KIND } from '../../exports/kinds/batch2/billing-progress.kind';

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
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rows = w.kpis
          .filter((k) => k.clientId === where.clientId && k.enabled !== false && k.isPrimary === true)
          .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || String(a.code).localeCompare(String(b.code)));
        const k = rows[0];
        return k
          ? { outletType: null, outletTypes: [], programs: [], subPrograms: [], unit: '', ...k }
          : null;
      }),
    },
    outlet: {
      findMany: jest.fn(async ({ where, distinct }: { where: { clientId: string }; distinct?: string[] }) => {
        const mine = w.outlets.filter((o) => tenantOf(o) === where.clientId);
        if (distinct) {
          return [...new Set(mine.map((o) => o.program).filter((p): p is string => !!p))].sort().map((programName) => ({ programName }));
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
          .map((r) => ({ ...r, updatedAt: r.updatedAt ?? new Date(0) })),
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

describe('paceFor (IST)', () => {
  it('past month → whole month, 100%', () => {
    const p = paceFor(PAST, new Date());
    expect(p.daysElapsed).toBe(p.daysInMonth);
    expect(p.pacePct).toBe(100);
  });

  it('future month → 0', () => {
    expect(paceFor(monthOffset(2), new Date()).pacePct).toBe(0);
  });

  it('current month → IST day-of-month / days in month (mocked clock, relative to now)', () => {
    const base = new Date();
    const [y, m] = istMonthKey(base).split('-').map(Number);
    // 10th of the current IST month, 12:00 IST (= 06:30 UTC).
    const now = new Date(Date.UTC(y, m - 1, 10, 6, 30));
    const p = paceFor(istMonthKey(now), now);
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    expect(p).toEqual({ daysElapsed: 10, daysInMonth: dim, pacePct: Math.round((10 / dim) * 100) });
  });

  it('00:30 IST on the 1st is day 1 of the NEW month (not the UTC previous day)', () => {
    const [y, m] = istMonthKey(new Date()).split('-').map(Number);
    const now = new Date(Date.UTC(y, m - 1, 1, 0, 30) - 330 * 60_000); // 00:30 IST on the 1st
    expect(istMonthKey(now)).toBe(`${y}-${String(m).padStart(2, '0')}`);
    expect(paceFor(istMonthKey(now), now).daysElapsed).toBe(1);
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

  it('applies-to: an outlet outside the primary KPI scope is excluded from scope AND from without-target', async () => {
    const w = base();
    w.kpis[0].programs = ['Gold'];
    const s = summarizeBillingProgress(await load(w));
    expect(s.outletsInScope).toBe(2); // A, B (C is Silver)
    expect(s.outletsWithoutTarget).toBe(1); // E only — D is Silver, out of scope
  });

  it('tenant with no primary KPI → kpi null, empty buckets, dropdowns still served', async () => {
    const w = base();
    w.kpis = [{ clientId: T, code: 'TOTAL', label: 'T', isPrimary: false, enabled: true }];
    const s = summarizeBillingProgress(await load(w));
    expect(s.kpi).toBeNull();
    expect(s.outletsInScope).toBe(0);
    expect(s.outletsWithoutTarget).toBe(0);
    expect(s.buckets.every((b) => b.count === 0)).toBe(true);
    expect(s.availablePrograms).toEqual(['Gold', 'Silver']);
  });

  it('a disabled primary is ignored', async () => {
    const w = base();
    w.kpis[0].enabled = false;
    expect((await load(w)).kpi).toBeNull();
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
    w.sales[0].updatedAt = new Date(Date.UTC(2020, 0, 5, 20, 0)); // 01:30 IST on the 6th
    expect((await load(w)).asOf).toBe('2020-01-06');
    w.lastApply = { importId: 'i1', createdAt: new Date(), appliedById: 'u', definitionsSnapshot: [{ kpiCode: 'TOTAL' }], month: PAST };
    w.monthSummaries = [{ month: PAST, lastDate: '2020-01-04' }];
    expect((await load(w)).asOf).toBe('2020-01-04');
    w.lastApply.definitionsSnapshot = [{ kpiCode: 'FOCUS' }]; // importer does not own the primary
    expect((await load(w)).asOf).toBe('2020-01-06');
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
        { outletCode: 'A', month, kpiValues: { TOTAL: 10 } },
        { outletCode: 'B', month, kpiValues: { TOTAL: 90 } },
      ],
    });
    const s = summarizeBillingProgress(await load(w, { month: null }, now));
    expect(s.month).toBe(month);
    expect(s.daysElapsed).toBe(15);
    expect(s.behindPace.count).toBe(1); // A (10% < ~50%)
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
      target: 300, achieved: 15, pct: 5,
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
    expect(BILLING_PROGRESS_OUTLETS_KIND.describeParams(p)).toBe('Billing progress — Behind pace — Oct 2026');
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
    const rows: unknown[][] = [];
    let headers: string[] = [];
    const out = {
      addSheet: async (_n: string, h: string[]) => {
        headers = h;
        return { addRow: async (r: unknown[]) => void rows.push(r), rowCount: 0 };
      },
    };
    const params = BILLING_PROGRESS_OUTLETS_KIND.parseParams({ bucket: 'NOT_STARTED', month: PAST }, {} as JwtPayload);
    const res = await BILLING_PROGRESS_OUTLETS_KIND.run(
      { prisma, clientId: T, now: new Date(), user: {} as JwtPayload, moduleRef: {} } as never,
      params,
      out as never,
    );
    expect(res.rowCount).toBe(1);
    expect(headers).toEqual([
      'Outlet Code', 'Outlet Name', 'Program', 'Outlet Type', 'SO', 'ASM',
      'Total sales Target (INR)', 'Total sales Achieved (INR)', 'Achievement %',
    ]);
    expect(rows[0]).toEqual(['B', 'Outlet B', '', 'RETAIL', '', '', 100, 0, 0]);
  });
});
