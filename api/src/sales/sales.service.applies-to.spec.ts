// APPLIES-TO (KPI + visibility scope by outlet type / program / sub-program) — sales consumers.
// platform/docs/plans/APPLIES-TO-TARGETING-PLAN.md D3/D6/D7/D12. Every scoped assertion is paired
// with an UNSCOPED (Deoleo-shaped) case proving the pre-scope output is unchanged.
// Run: npx jest --no-coverage src/sales/sales.service.applies-to.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { SalesService } from './sales.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { currentMonthKey } from '../targets/targets.helpers';
import { visibilityOutOfScopeReason } from '../visibility/visibility-scope.helper';

const mockPrisma = {
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  outletTarget: { findFirst: jest.fn(), findMany: jest.fn() },
  outletSalesRecord: { findFirst: jest.fn(), findMany: jest.fn() },
  kpiDef: { findMany: jest.fn() },
  salesHierarchyLevel: { findFirst: jest.fn(), findMany: jest.fn() },
  outlet: { findFirst: jest.fn(), findMany: jest.fn() },
  visibilityCapture: { findMany: jest.fn() },
};
const mockTenant = { resolveClient: jest.fn(), resolveVisibilityEnabled: jest.fn() };
const mockTenantSettings = { getEffectiveSettings: jest.fn() };
const VIS = { outletScope: ['SSS'], frequencyPerMonth: 1, allowedSalesLevels: ['ISR'], geoFence: { enabled: false, radiusMeters: 50 } };
const caller: JwtPayload = { sub: 'user-mgr', role: 'SALES', clientId: 'bajaj', phone: '', name: '' };

const unscoped = { outletType: null, outletTypes: [], programs: [], subPrograms: [] };
const kpi = (code: string, extra: Record<string, unknown> = {}) => ({
  code, label: `KPI ${code}`, unit: '', isPrimary: false, order: 1, rollup: 'SUM', ...unscoped, ...extra,
});

describe('SalesService — APPLIES-TO scope', () => {
  let service: SalesService;
  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
    mockTenantSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: VIS });
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = module.get(SalesService);
  });

  // ── team-view (D7 incl. the type-filter fix) ─────────────────────────────────────────────
  describe('getTeamView KPI list', () => {
    const edges = [{ id: 'root', reportingToId: null }, { id: 'isr1', reportingToId: 'root' }];
    const approved = { partner: { kycSubmissions: [{ status: 'APPROVED' }] } };
    function prime(kpis: unknown[]) {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'root', user: { name: 'Root', phone: '' }, hierarchyLevel: { code: 'ASM', name: 'ASM', level: 3 },
        subordinates: [{ id: 'isr1', employeeCode: 'I1', user: { name: 'ISR', phone: '' }, hierarchyLevel: { code: 'ISR', name: 'ISR' }, _count: { subordinates: 0 } }],
      });
      mockPrisma.salesUser.findMany.mockResolvedValue(edges);
      mockPrisma.kpiDef.findMany.mockResolvedValue(kpis);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUserId: 'isr1', outlet: { id: 'o1', outletCode: 'O1', isActive: true, programName: 'RLP', programCategory: 'Urban', outletType: { code: 'SSS', name: 'Retailer' }, ...approved } },
        { salesUserId: 'isr1', outlet: { id: 'o2', outletCode: 'O2', isActive: true, programName: 'BSC', programCategory: null, outletType: { code: 'WHOLESALER', name: 'Wholesaler' }, ...approved } },
      ]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    }
    const scopedKpis = [
      kpi('SHARED', { isPrimary: true, order: 1 }),
      kpi('RLP_ONLY', { order: 2, programs: ['rlp'] }),
      kpi('BSC_TYPE', { order: 3, outletType: 'WHOLESALER' }), // legacy type tag
    ];

    it('the outletType filter now narrows the KPI list (pre-fix it was ignored)', async () => {
      prime(scopedKpis);
      const res: any = await service.getTeamView(caller, { outletType: 'SSS' });
      expect(res.kpis.map((k: { code: string }) => k.code)).toEqual(['SHARED', 'RLP_ONLY']);
      expect(res.filterOptions.kpis.map((k: { code: string }) => k.code)).toEqual(['SHARED', 'RLP_ONLY']);
    });

    it('the program filter narrows the KPI list (D7, ci)', async () => {
      prime(scopedKpis);
      const res: any = await service.getTeamView(caller, { program: 'BSC' });
      expect(res.kpis.map((k: { code: string }) => k.code)).toEqual(['SHARED', 'BSC_TYPE']);
    });

    it('an out-of-filter kpi request falls back to OVERVIEW (KPI hidden in the filtered view)', async () => {
      prime(scopedKpis);
      const res: any = await service.getTeamView(caller, { program: 'BSC', kpi: 'RLP_ONLY' });
      expect(res.mode).toBe('OVERVIEW');
    });

    it('UNSCOPED tenant: KPI list identical with and without filters (Deoleo byte-identical)', async () => {
      const deoleo = [kpi('A', { isPrimary: true, order: 1 }), kpi('B', { order: 2 })];
      prime(deoleo);
      const none: any = await service.getTeamView(caller, {});
      prime(deoleo);
      const filtered: any = await service.getTeamView(caller, { outletType: 'SSS', program: 'RLP' });
      expect(filtered.kpis).toEqual(none.kpis);
      expect(filtered.filterOptions.kpis).toEqual(none.filterOptions.kpis);
      expect(none.kpis).toEqual([{ code: 'A', label: 'KPI A' }, { code: 'B', label: 'KPI B' }]);
    });

    it('VISIBILITY pseudo-KPI honours visibility programs (den/num narrow together); empty = unchanged', async () => {
      prime([kpi('K', { isPrimary: true })]);
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
      // Both outlets SSS for this case.
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUserId: 'isr1', outlet: { id: 'o1', outletCode: 'O1', isActive: true, programName: 'RLP', programCategory: 'Urban', outletType: { code: 'SSS', name: 'Retailer' }, ...approved } },
        { salesUserId: 'isr1', outlet: { id: 'o2', outletCode: 'O2', isActive: true, programName: 'BSC', programCategory: null, outletType: { code: 'SSS', name: 'Retailer' }, ...approved } },
      ]);
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([{ outletId: 'o1' }]);
      // Emulates the DB for THE single in-scope query (visibilityUniverseWhere ∩ the subtree ids) — the explain
      // function is the oracle, evaluated on the fixture outlets under the CURRENT config.
      mockPrisma.outlet.findMany.mockImplementation(async ({ where }: any) => {
        const ids: string[] = where.AND[0].id.in;
        const cfg = (await mockTenantSettings.getEffectiveSettings()).visibilityConfig;
        const rows = ((await mockPrisma.salesUserAssignment.findMany()) as Array<{ outlet: any }>).map((a) => a.outlet);
        return rows
          .filter((o) => ids.includes(o.id) && !visibilityOutOfScopeReason({ deletedAt: null, deactivatedAt: null, kycIntent: null, ...o }, cfg))
          .map((o) => ({ id: o.id }));
      });
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...VIS, programs: [], subPrograms: [] } });
      const all: any = await service.getTeamView(caller, { kpi: 'VISIBILITY' });
      expect(all.members[0]).toMatchObject({ outletsWithTarget: 2, outletsAchieved: 1, achievedPct: 50 });
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...VIS, programs: ['rlp'], subPrograms: [] } });
      const scoped: any = await service.getTeamView(caller, { kpi: 'VISIBILITY' });
      expect(scoped.members[0]).toMatchObject({ outletsWithTarget: 1, outletsAchieved: 1, achievedPct: 100 });
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...VIS, programs: [], subPrograms: ['Rural'] } });
      const none: any = await service.getTeamView(caller, { kpi: 'VISIBILITY' });
      expect(none.members[0]).toMatchObject({ outletsWithTarget: 0, achievedPct: null });
    });
  });

  // ── trade-comparison (D7) ────────────────────────────────────────────────────────────────
  describe('getTradeComparison', () => {
    function prime(kpis: unknown[]) {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'root', user: { name: 'Root' }, hierarchyLevel: { code: 'ASM', name: 'ASM', level: 3 } });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'root', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
      mockPrisma.kpiDef.findMany.mockResolvedValue(kpis);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    }
    it('program filter narrows the selectable list; primary falls back to the first in-scope KPI', async () => {
      prime([kpi('PRI', { isPrimary: true, order: 1, programs: ['RLP'] }), kpi('BSCK', { order: 2, programs: ['BSC'] })]);
      const res: any = await service.getTradeComparison(caller, { program: 'BSC' });
      expect(res.kpis.map((k: { code: string }) => k.code)).toEqual(['BSCK']);
      expect(res.kpiCode).toBe('BSCK');
    });
    it('UNSCOPED: program filter leaves list + primary unchanged', async () => {
      const ks = [kpi('PRI', { isPrimary: true, order: 1 }), kpi('VOL', { order: 2 })];
      prime(ks);
      const a: any = await service.getTradeComparison(caller, {});
      prime(ks);
      const b: any = await service.getTradeComparison(caller, { program: 'BSC' });
      expect(b.kpis).toEqual(a.kpis);
      expect(b.kpiCode).toBe('PRI');
    });
  });

  // ── getTargets (type view) + getOutletTargets (multi-outlet table, D6 "—") ────────────────
  describe('getTargets / getOutletTargets', () => {
    function primeSubtree() {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outlet: { outletCode: 'O1', isActive: true, programName: 'RLP', programCategory: null, outletType: { code: 'SSS' } } },
        { outlet: { outletCode: 'O2', isActive: true, programName: 'BSC', programCategory: null, outletType: { code: 'SSS' } } },
      ]);
    }
    it('getTargets type view uses the new outletTypes arrays (KPI tagged WHOLESALER-only hidden for SSS)', async () => {
      primeSubtree();
      mockPrisma.outletTarget.findMany.mockResolvedValueOnce([{ outletCode: 'O1', targetValues: { A: 10, W: 10 } }]).mockResolvedValueOnce([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpi('A', { isPrimary: true }), kpi('W', { outletTypes: ['WHOLESALER', 'DIST'] })]);
      const res = await service.getTargets(caller, '2026-05', 'SSS');
      expect(res.kpis.map((k: { code: string }) => k.code)).toEqual(['A']);
    });

    it('multi-outlet table: an out-of-scope (outlet, KPI) cell is "—" (all null); in-scope cells untouched', async () => {
      primeSubtree();
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'O1', targetValues: { RK: 10 } },
        { outletCode: 'O2', targetValues: { RK: 10 } }, // stale value on a BSC outlet
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { RK: 5 } }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpi('RK', { programs: ['RLP'] })]);
      const res: any = await service.getOutletTargets(caller, '2026-05');
      const byCode = Object.fromEntries(res.rows.map((r: any) => [r.outletCode, r.kpis]));
      expect(byCode.O1.RK).toEqual({ target: 10, achieved: 5, pace: 0.5 });
      expect(byCode.O2.RK).toEqual({ target: null, achieved: null, pace: null });
    });

    it('UNSCOPED: the same data reads every cell as stored (Deoleo byte-identical)', async () => {
      primeSubtree();
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'O1', targetValues: { RK: 10 } },
        { outletCode: 'O2', targetValues: { RK: 10 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([{ outletCode: 'O1', kpiValues: { RK: 5 } }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpi('RK')]);
      const res: any = await service.getOutletTargets(caller, '2026-05');
      const byCode = Object.fromEntries(res.rows.map((r: any) => [r.outletCode, r.kpis]));
      expect(byCode.O2.RK).toEqual({ target: 10, achieved: null, pace: null });
    });
  });

  // ── target-trend single-outlet (D6 hide + primary fallback) ───────────────────────────────
  describe('getTargetTrend single-outlet', () => {
    beforeEach(() => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outlet: { outletCode: 'O2', isActive: true, programName: 'BSC', programCategory: null, outletType: { code: 'SSS' } } },
      ]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    });
    it('requested KPI out of the outlet scope → falls back to the outlet\'s first in-scope KPI', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        kpi('PRI', { isPrimary: true, order: 1, programs: ['RLP'] }),
        kpi('BSCK', { order: 2, programs: ['BSC'] }),
      ]);
      const res = await service.getTargetTrend(caller, 'PRI', undefined, 'O2');
      expect(res.kpiCode).toBe('BSCK');
    });
    it('UNSCOPED: the requested KPI is honoured as before', async () => {
      mockPrisma.kpiDef.findMany.mockResolvedValue([kpi('PRI', { isPrimary: true }), kpi('BSCK', { order: 2 })]);
      const res = await service.getTargetTrend(caller, 'PRI', undefined, 'O2');
      expect(res.kpiCode).toBe('PRI');
    });
    it('dashboard: the program filter narrows the KPI set (D7)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O2' }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        kpi('PRI', { isPrimary: true, order: 1, programs: ['RLP'] }),
        kpi('BSCK', { order: 2, programs: ['BSC'] }),
      ]);
      const res = await service.getTargetTrend(caller, undefined, 'BSC');
      expect(res.kpiCode).toBe('BSCK');
      const cur = currentMonthKey();
      expect(res.trend[5].month).toBe(cur);
    });
  });

  // ── Aggregate readers EXCLUDE out-of-scope (outlet, KPI) values (owner 2026-11-12) ────────
  // O1 = SSS (approved, target 100 / ach 100) · O2 = WHOLESALER (approved, stale target 100 / ach 0).
  // A legacy single-type KPI `S` (outletType 'SSS') is a REAL scope → O2's values never count.
  describe('aggregate readers exclude out-of-scope values (legacy single-type KPI = real scope)', () => {
    const approved = { partner: { kycSubmissions: [{ status: 'APPROVED' }] } };
    const assignments = [
      { salesUserId: 'isr1', outlet: { id: 'o1', outletCode: 'O1', isActive: true, programName: 'RLP', programCategory: null, outletType: { code: 'SSS', name: 'Retailer' }, ...approved } },
      { salesUserId: 'isr1', outlet: { id: 'o2', outletCode: 'O2', isActive: true, programName: 'BSC', programCategory: null, outletType: { code: 'WHOLESALER', name: 'Wholesaler' }, ...approved } },
    ];
    const cur = currentMonthKey();
    function primeData() {
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'O1', month: cur, targetValues: { S: 100 } },
        { outletCode: 'O2', month: cur, targetValues: { S: 100 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O1', month: cur, kpiValues: { S: 100 } },
        { outletCode: 'O2', month: cur, kpiValues: { S: 0 } },
      ]);
    }
    function primeTeam(kpis: unknown[]) {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'root', user: { name: 'Root', phone: '' }, hierarchyLevel: { code: 'ASM', name: 'ASM', level: 3 },
        subordinates: [{ id: 'isr1', employeeCode: 'I1', user: { name: 'ISR', phone: '' }, hierarchyLevel: { code: 'ISR', name: 'ISR' }, _count: { subordinates: 0 } }],
      });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'root', reportingToId: null }, { id: 'isr1', reportingToId: 'root' }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue(kpis);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue(assignments);
      primeData();
    }
    const legacy = [kpi('S', { isPrimary: true, outletType: 'SSS' })];
    const open = [kpi('S', { isPrimary: true })];

    it('team-view SINGLE: the WHOLESALER outlet is not "with target" for the SSS-only KPI', async () => {
      primeTeam(legacy);
      const res: any = await service.getTeamView(caller, { kpi: 'S' });
      expect(res.summary.avgTargetPct).toBe(100);
      expect(res.summary.outlets).toBe(2); // population counts stay KPI-independent
      expect(res.members[0]).toMatchObject({ outletsWithTarget: 1, outletsAchieved: 1, achievedPct: 100 });
    });
    it('team-view OVERVIEW: same exclusion per KPI', async () => {
      primeTeam(legacy);
      const res: any = await service.getTeamView(caller, {});
      expect(res.members[0].kpiPercents.S).toBe(100);
    });
    it('team-view UNSCOPED: both outlets scored (Deoleo byte-identical)', async () => {
      primeTeam(open);
      const res: any = await service.getTeamView(caller, { kpi: 'S' });
      expect(res.members[0]).toMatchObject({ outletsWithTarget: 2, outletsAchieved: 1, achievedPct: 50 });
    });

    it('trade-comparison: monthly sale / target / target-met exclude the out-of-scope outlet', async () => {
      primeTeam(legacy);
      const res: any = await service.getTradeComparison(caller, {});
      expect(res.buckets.current).toEqual({ monthlySale: 100, monthlyTarget: 100, targetMet: { achieved: 1, withTarget: 1, pct: 100 } });
      primeTeam(open);
      const un: any = await service.getTradeComparison(caller, {});
      expect(un.buckets.current).toEqual({ monthlySale: 100, monthlyTarget: 200, targetMet: { achieved: 1, withTarget: 2, pct: 50 } });
    });

    function primeHero(kpis: unknown[]) {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue(assignments.map((a) => ({ outlet: a.outlet })));
      mockPrisma.kpiDef.findMany.mockResolvedValue(kpis.map((k: any) => ({ ...k, rollup: 'SUM' })));
      primeData();
    }
    it('getTargets hero card + its trend exclude the out-of-scope outlet; unscoped sums both', async () => {
      primeHero(legacy);
      const res: any = await service.getTargets(caller, cur);
      expect(res.kpis[0]).toMatchObject({ code: 'S', target: 100, achieved: 100 });
      expect(res.trend[5]).toEqual({ month: cur, target: 100, achieved: 100 });
      primeHero(open);
      const un: any = await service.getTargets(caller, cur);
      expect(un.kpis[0]).toMatchObject({ code: 'S', target: 200, achieved: 100 });
      expect(un.trend[5]).toEqual({ month: cur, target: 200, achieved: 100 });
    });
    it('getTargetTrend dashboard view excludes the out-of-scope outlet; unscoped sums both', async () => {
      primeHero(legacy);
      const res = await service.getTargetTrend(caller, 'S');
      expect(res.trend[5]).toEqual({ month: cur, target: 100, achieved: 100 });
      primeHero(open);
      const un = await service.getTargetTrend(caller, 'S');
      expect(un.trend[5]).toEqual({ month: cur, target: 200, achieved: 100 });
    });
  });

  // ── leaderboard (D7) + team rollups (mirror) ─────────────────────────────────────────────
  describe('getLeaderboard skips outlets where the tenant primary is out of scope', () => {
    function wire(primary: Record<string, unknown>) {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'me', userId: 'user-mgr', reportingToId: 'mgr', hierarchyLevelId: 'L1', region: 'N' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'me', userId: 'user-mgr', reportingToId: 'mgr', hierarchyLevelId: 'L1', region: 'N', zone: null, isActive: true, user: { name: 'Me' } },
        { id: 'mgr', userId: 'user-boss', reportingToId: null, hierarchyLevelId: 'L2', region: 'N', zone: null, isActive: true, user: { name: 'Boss' } },
      ]);
      mockPrisma.salesHierarchyLevel.findFirst.mockResolvedValue(null);
      mockPrisma.salesHierarchyLevel.findMany.mockResolvedValue([]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUserId: 'me', outlet: { outletCode: 'O1', isActive: true, programName: 'RLP', programCategory: null, outletType: { code: 'SSS' } } },
        { salesUserId: 'me', outlet: { outletCode: 'O2', isActive: true, programName: 'BSC', programCategory: null, outletType: { code: 'SSS' } } },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'P', isPrimary: true, ...unscoped, ...primary }]);
      // O1: 50/100; O2 (stale): 100/100.
      mockPrisma.outletTarget.findMany.mockResolvedValueOnce([
        { outletCode: 'O1', targetValues: { P: 100 } }, { outletCode: 'O2', targetValues: { P: 100 } },
      ]).mockResolvedValueOnce([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValueOnce([
        { outletCode: 'O1', kpiValues: { P: 50 } }, { outletCode: 'O2', kpiValues: { P: 100 } },
      ]).mockResolvedValueOnce([]);
    }
    it('scoped primary (RLP) → O2 skipped from the score, still counted in activeOutlets', async () => {
      wire({ programs: ['RLP'] });
      const res = await service.getLeaderboard(caller, undefined, '2026-06');
      expect(res.entries[0]).toMatchObject({ achievementPct: 50, activeOutlets: 2 });
    });
    it('UNSCOPED primary → both outlets scored (Deoleo byte-identical)', async () => {
      wire({});
      const res = await service.getLeaderboard(caller, undefined, '2026-06');
      expect(res.entries[0]).toMatchObject({ achievementPct: 75, activeOutlets: 2 });
    });
  });
});
