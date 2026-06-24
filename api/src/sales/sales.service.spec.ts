// Unit tests for SalesService — ported sales-org domain.
// Covers the hierarchy ownership / cross-tenant IDOR guard (isSelfOrDescendant)
// and tenant scoping (clientId from the JWT) on the ported real routes.
// Run: npx jest src/sales/sales.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isSelfOrDescendant } from './sales-hierarchy-access.helper';
import { currentMonthKey } from '../targets/targets.helpers';

const mockPrisma = {
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  outletTarget: { findFirst: jest.fn(), findMany: jest.fn() },
  outletSalesRecord: { findFirst: jest.fn(), findMany: jest.fn() },
  kpiDef: { findMany: jest.fn() },
};

const caller: JwtPayload = { sub: 'user-mgr', role: 'SALES', clientId: 'deoleo', phone: '', name: '' };

describe('SalesService', () => {
  let service: SalesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SalesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(SalesService);
  });

  describe('getTeam', () => {
    it('scopes the lookup to the caller and their tenant', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getTeam(caller);
      const where = mockPrisma.salesUser.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({
        userId: 'user-mgr',
        user: { clientId: 'deoleo' },
        deletedAt: null,
      });
      // No SalesUser → empty team, not an error.
      expect(res).toEqual({ salesUser: null, members: [] });
    });

    it('maps subordinates into member rows', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'mgr1',
        employeeCode: 'E1',
        region: 'North',
        zone: null,
        hierarchyLevel: { code: 'ASM', name: 'Area Sales Manager', level: 2 },
        subordinates: [
          {
            id: 'sub1',
            employeeCode: 'E2',
            region: 'NCR',
            zone: null,
            joinedAt: new Date('2024-01-01T00:00:00.000Z'),
            user: { name: 'Sub One' },
            hierarchyLevel: { code: 'SO', name: 'Sales Officer', level: 1 },
            _count: { subordinates: 3 },
          },
        ],
      });
      const res = await service.getTeam(caller);
      expect(res.members).toEqual([
        {
          id: 'sub1',
          employeeCode: 'E2',
          name: 'Sub One',
          role: 'SO',
          roleLabel: 'Sales Officer',
          territory: 'NCR',
          teamSize: 3,
          joinedAt: '2024-01-01T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('hierarchy ownership / IDOR guard (getMember)', () => {
    it('throws Forbidden when the caller has no SalesUser record', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // caller lookup
      await expect(service.getMember(caller, 'target1')).rejects.toBeInstanceOf(ForbiddenException);
      // Never reaches the edge-list load.
      expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the target is not in the caller subtree (incl. cross-tenant)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce({ id: 'caller-su' }); // caller lookup
      // Edge list is tenant-scoped; target is absent → outside the subtree.
      mockPrisma.salesUser.findMany.mockResolvedValueOnce([
        { id: 'caller-su', reportingToId: null },
        { id: 'other', reportingToId: 'caller-su' },
      ]);
      await expect(service.getMember(caller, 'target-out-of-tenant')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // The edge query is tenant-scoped.
      const where = mockPrisma.salesUser.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' }, deletedAt: null });
    });

    it('passes the guard for a descendant, then 404s when the member is missing', async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'caller-su' }) // caller lookup
        .mockResolvedValueOnce(null); // member detail lookup
      mockPrisma.salesUser.findMany.mockResolvedValueOnce([
        { id: 'caller-su', reportingToId: null },
        { id: 'target1', reportingToId: 'caller-su' },
      ]);
      await expect(service.getMember(caller, 'target1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it("INCLUDES partner-less (un-KYC'd) outlets in outlets[] and COUNTS them in kycPending", async () => {
      mockPrisma.salesUser.findFirst
        .mockResolvedValueOnce({ id: 'caller-su' }) // caller lookup (guard)
        .mockResolvedValueOnce({
          // member-detail lookup
          id: 'target1',
          employeeCode: 'E9',
          region: 'NCR',
          zone: null,
          user: { name: 'Rep Nine', phone: '555' },
          hierarchyLevel: { code: 'SO', name: 'Sales Officer', level: 1 },
          _count: { subordinates: 0 },
          assignments: [
            {
              // KYC'd / partnered outlet → APPROVED
              outlet: {
                id: 'o1',
                name: 'Outlet 1',
                city: 'Delhi',
                outletCode: 'OC1',
                phone: '999',
                partner: {
                  id: 'cp1',
                  kycSubmissions: [{ id: 'k1', status: 'APPROVED' }],
                },
              },
            },
            {
              // partner-less outlet (uploaded, not yet KYC'd) → NOT_STARTED.
              // MUST be included AND counted in kycPending (the bug being fixed).
              outlet: {
                id: 'o2',
                name: 'Outlet 2',
                city: 'Mumbai',
                outletCode: 'OC2',
                phone: '777',
                partner: null,
              },
            },
          ],
        });
      mockPrisma.salesUser.findMany.mockResolvedValueOnce([
        { id: 'caller-su', reportingToId: null },
        { id: 'target1', reportingToId: 'caller-su' },
      ]);

      const res = await service.getMember(caller, 'target1');

      // The detail query selects partner.id so the projection works for both.
      const include = mockPrisma.salesUser.findFirst.mock.calls[1][0].include;
      expect(include.assignments.include.outlet.include.partner.select.id).toBe(true);

      expect(res.member.kycDone).toBe(1);
      expect(res.member.kycPending).toBe(1); // the partner-less NOT_STARTED outlet
      expect(res.member.outlets).toHaveLength(2);

      const o2 = res.member.outlets.find((o) => o.id === 'o2')!;
      expect(o2).toMatchObject({
        id: 'o2',
        partnerId: null,
        name: 'Outlet 2',
        location: 'Mumbai',
        outletCode: 'OC2',
        mobile: '777',
        kycId: '',
        kycStatus: 'NOT_STARTED',
        targetPct: 0,
      });
    });
  });

  describe('getMemberOutlets', () => {
    it('enforces the guard before loading outlets', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValueOnce(null); // caller lookup → Forbidden
      await expect(service.getMemberOutlets(caller, 'target1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.salesUserAssignment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getMyOutlets', () => {
    it('returns an empty list when the caller is not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getMyOutlets(caller);
      expect(res).toEqual({ outlets: [] });
    });

    it('scopes to the caller + downline and INCLUDES partner-less (un-KYC\'d) outlets as NOT_STARTED so the rep can enrol them', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      // No subordinates → subtree is just the caller.
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'caller-su', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        {
          outlet: {
            id: 'o1',
            outletCode: 'OC1',
            name: 'Outlet 1',
            phone: '999',
            city: 'Delhi',
            district: 'Central',
            state: 'DL',
            outletType: { code: 'RETAIL' },
            partner: {
              id: 'cp1',
              phone: '888',
              wallets: [{ redeemablePoints: 1500 }],
              kycSubmissions: [
                { id: 'k1', status: 'APPROVED', createdAt: new Date('2024-05-01T00:00:00.000Z') },
              ],
            },
          },
        },
        // partner-less outlet (uploaded via master file, not yet KYC'd) → MUST be
        // surfaced (this was the bug: a rep whose outlets were all un-KYC'd saw none).
        {
          outlet: {
            id: 'o2',
            outletCode: 'OC2',
            name: 'Outlet 2',
            phone: '777',
            city: 'Mumbai',
            district: 'West',
            state: 'MH',
            outletType: { code: 'RETAIL' },
            partner: null,
          },
        },
      ]);
      const res = await service.getMyOutlets(caller);
      const where = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ salesUserId: { in: ['caller-su'] }, outletId: { not: null }, unassignedAt: null });

      expect(res.outlets).toHaveLength(2);
      expect(res.outlets[0]).toMatchObject({
        id: 'o1', partnerId: 'cp1', balance: 1500, kycId: 'k1', kycStatus: 'APPROVED', kycSubmittedAt: '2024-05-01',
      });
      // the un-KYC'd outlet: surfaced, partner-derived fields null/0, NOT_STARTED.
      expect(res.outlets[1]).toMatchObject({
        id: 'o2', partnerId: null, balance: 0, kycId: '',
        outletCode: 'OC2', name: 'Outlet 2', mobile: '777', location: 'Mumbai',
        type: 'RETAIL', kycStatus: 'NOT_STARTED', targetPct: 0,
      });
      expect(res.outlets[1].kycSubmittedAt).toBeUndefined();
    });
  });

  // ─── getMe (real sales identity for the header employee ID + profile) ──────────
  describe('getMe', () => {
    it('returns the real employeeCode + role from the SalesUser, scoped to the caller', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        employeeCode: 'XSR-M001', region: 'West', zone: 'Z1',
        user: { name: 'Anita Rep', phone: '9900000041' },
        hierarchyLevel: { code: 'SALES_ISR', name: 'Executive Sales Representative', level: 5 },
      });
      const res = await service.getMe(caller);
      const where = mockPrisma.salesUser.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({ userId: 'user-mgr', user: { clientId: 'deoleo' }, deletedAt: null });
      expect(res).toEqual({
        employeeCode: 'XSR-M001', role: 'SALES_ISR', roleLabel: 'Executive Sales Representative',
        level: 5, region: 'West', zone: 'Z1', name: 'Anita Rep', phone: '9900000041',
      });
    });

    it('falls back to JWT name/phone + null employeeCode when not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getMe({ ...caller, name: 'JWT Name', phone: '99' });
      expect(res.employeeCode).toBeNull();
      expect(res.role).toBeNull();
      expect(res.name).toBe('JWT Name');
      expect(res.phone).toBe('99');
    });
  });

  // ─── getTargets (real target vs achievement, summed across the rep's outlets) ──
  describe('getTargets', () => {
    it('returns empty when the caller is not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getTargets(caller);
      expect(res).toEqual({ period: null, outletCount: 0, kpis: [], trend: [] });
    });

    it('returns empty when the rep has no assigned outlets', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
      const res = await service.getTargets(caller);
      expect(res).toEqual({ period: null, outletCount: 0, kpis: [], trend: [] });
    });

    it('sums target + achieved per KPI across the rep\'s outlets, primary first, with pace', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outlet: { outletCode: 'O1' } }, { outlet: { outletCode: 'O2' } },
      ]);
      mockPrisma.outletTarget.findFirst.mockResolvedValue({ month: '2026-05' });
      // current-month targets: two outlets
      mockPrisma.outletTarget.findMany
        .mockResolvedValueOnce([
          { targetValues: { CONSISTENCY: 500, FOCUS: 100 } },
          { targetValues: { CONSISTENCY: 400 } },
        ])
        // trend query (6 months) — return nothing extra
        .mockResolvedValueOnce([]);
      mockPrisma.outletSalesRecord.findMany
        .mockResolvedValueOnce([
          { kpiValues: { CONSISTENCY: 450, FOCUS: 0 } },
          { kpiValues: { CONSISTENCY: 200 } },
        ])
        .mockResolvedValueOnce([]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'FOCUS', label: 'Focus Pack', unit: 'units', isPrimary: false },
        { code: 'CONSISTENCY', label: 'Consistency', unit: 'Litre', isPrimary: true },
      ]);

      const res = await service.getTargets(caller, '2026-05');
      expect(res.period).toBe('2026-05');
      expect(res.outletCount).toBe(2);
      // primary KPI first
      expect(res.kpis[0]).toMatchObject({
        code: 'CONSISTENCY', isPrimary: true, unit: 'Litre',
        target: 900, achieved: 650, // 500+400 vs 450+200
      });
      expect(res.kpis[0].pace).toBeCloseTo(650 / 900);
      const focus = res.kpis.find((k: { code: string }) => k.code === 'FOCUS')!;
      expect(focus).toMatchObject({ target: 100, achieved: 0, pace: 0 });
      // trend has 6 month buckets on the primary KPI
      expect(res.trend).toHaveLength(6);
      expect(res.trend[5].month).toBe('2026-05');
    });

    it('with NO period, defaults to the CURRENT calendar month — not a future target month', async () => {
      // Regression: targets existed for a future month (2026-08) but achievements only
      // for the current month; picking the latest TARGET month showed 0 achievement.
      const cm = currentMonthKey();
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outlet: { outletCode: 'O1' } }]);
      mockPrisma.outletTarget.findMany
        .mockResolvedValueOnce([{ targetValues: { MONTH: 100 } }]) // target for the current month
        .mockResolvedValueOnce([]);                                // trend
      mockPrisma.outletSalesRecord.findMany
        .mockResolvedValueOnce([{ kpiValues: { MONTH: 40 } }])     // achievement for the current month
        .mockResolvedValueOnce([]);                                // trend
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'MONTH', label: 'Monthly', unit: 'Litre', isPrimary: true },
      ]);

      const res = await service.getTargets(caller); // no period
      expect(res.period).toBe(cm);
      expect(res.kpis[0]).toMatchObject({ code: 'MONTH', target: 100, achieved: 40 });
      // Anchored on the calendar month — no "latest target/achievement month" DB lookup.
      expect(mockPrisma.outletTarget.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.outletSalesRecord.findFirst).not.toHaveBeenCalled();
      // The month-scoped queries used the current month.
      expect(mockPrisma.outletTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ month: cm }) }),
      );
    });
  });

  // ─── getOutletTargets (real PER-OUTLET KPIs for the Outlets list page) ─────────
  describe('getOutletTargets', () => {
    it('returns empty when not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getOutletTargets(caller);
      expect(res).toEqual({ period: null, kpiColumns: [], rows: [] });
    });

    it('returns per-outlet KPI columns (primary first) + per-outlet target/achieved/pace', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outlet: { outletCode: 'O1' } }, { outlet: { outletCode: 'O2' } },
      ]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'O1', targetValues: { CONSISTENCY: 500, FOCUS: 100 } },
        { outletCode: 'O2', targetValues: { CONSISTENCY: 400 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O1', kpiValues: { CONSISTENCY: 250, FOCUS: 0 } },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'FOCUS', label: 'Focus Pack', unit: 'units', isPrimary: false },
        { code: 'CONSISTENCY', label: 'Consistency', unit: 'Litre', isPrimary: true },
      ]);

      const res = await service.getOutletTargets(caller, '2026-05');
      expect(res.period).toBe('2026-05');
      // primary KPI column first
      expect(res.kpiColumns.map((c: { code: string }) => c.code)).toEqual(['CONSISTENCY', 'FOCUS']);

      const o1 = res.rows.find((r: { outletCode: string }) => r.outletCode === 'O1')!;
      expect(o1.kpis.CONSISTENCY).toEqual({ target: 500, achieved: 250, pace: 0.5 });
      expect(o1.kpis.FOCUS).toEqual({ target: 100, achieved: 0, pace: 0 });

      const o2 = res.rows.find((r: { outletCode: string }) => r.outletCode === 'O2')!;
      // O2 has a target but NO achievement row → achieved null, pace null
      expect(o2.kpis.CONSISTENCY).toEqual({ target: 400, achieved: null, pace: null });
    });

    it('tenant- + caller-scopes the target/achievement reads to the rep clientId + outlet codes', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outlet: { outletCode: 'O1' } }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);

      await service.getOutletTargets(caller, '2026-05');
      expect(mockPrisma.outletTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'deoleo', outletCode: { in: ['O1'] }, month: '2026-05' } }),
      );
    });

    it('a MANAGER sees the DOWNLINE\'s outlet targets (Q4) — not just their own assignments', async () => {
      // caller su1 manages su2; su2 is assigned outlet OX. The manager must see OX's targets.
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su1', reportingToId: null },
        { id: 'su2', reportingToId: 'su1' },
      ]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outlet: { outletCode: 'OX' } }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'OX', targetValues: { CONSISTENCY: 300 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'OX', kpiValues: { CONSISTENCY: 120 } },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'CONSISTENCY', label: 'Consistency', unit: 'Litre', isPrimary: true },
      ]);

      const res = await service.getOutletTargets(caller, '2026-05');
      // The assignment query must span the whole subtree [su1, su2].
      expect(mockPrisma.salesUserAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ salesUserId: { in: ['su1', 'su2'] } }) }),
      );
      const ox = res.rows.find((r: { outletCode: string }) => r.outletCode === 'OX')!;
      expect(ox.kpis.CONSISTENCY).toEqual({ target: 300, achieved: 120, pace: 0.4 });
    });
  });

  // ─── getMemberOutletTargets (team-member drill-down: real per-outlet targets) ──
  describe('getMemberOutletTargets', () => {
    it('returns the MEMBER\'s outlet targets for a viewable descendant', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' }); // assertCanViewMember caller
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'caller-su', reportingToId: null },
        { id: 'member-su', reportingToId: 'caller-su' }, // member reports to caller → viewable
      ]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outlet: { outletCode: 'OM' } }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'OM', targetValues: { CONSISTENCY: 200 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'OM', kpiValues: { CONSISTENCY: 50 } },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'CONSISTENCY', label: 'Consistency', unit: 'Litre', isPrimary: true },
      ]);

      const res = await service.getMemberOutletTargets(caller, 'member-su', '2026-05');
      // The read targets exactly the member's outlets.
      expect(mockPrisma.salesUserAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ salesUserId: 'member-su' }) }),
      );
      const om = res.rows.find((r: { outletCode: string }) => r.outletCode === 'OM')!;
      expect(om.kpis.CONSISTENCY).toEqual({ target: 200, achieved: 50, pace: 0.25 });
    });

    it('forbids viewing an out-of-subtree member (IDOR guard)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'caller-su', reportingToId: null },
        { id: 'stranger-su', reportingToId: null }, // NOT under the caller
      ]);
      await expect(
        service.getMemberOutletTargets(caller, 'stranger-su', '2026-05'),
      ).rejects.toThrow();
      // The guard must fire BEFORE any target/assignment read.
      expect(mockPrisma.salesUserAssignment.findMany).not.toHaveBeenCalled();
    });
  });
});

// Direct coverage of the ported pure access helper (cross-tenant IDOR fix).
describe('isSelfOrDescendant', () => {
  const edges = [
    { id: 'rsm', reportingToId: null },
    { id: 'asm', reportingToId: 'rsm' },
    { id: 'so', reportingToId: 'asm' },
    { id: 'other', reportingToId: null },
  ];

  it('returns true for self', () => {
    expect(isSelfOrDescendant('asm', 'asm', edges)).toBe(true);
  });

  it('returns true for a descendant (transitively)', () => {
    expect(isSelfOrDescendant('so', 'rsm', edges)).toBe(true);
  });

  it('returns false for a non-descendant in the same tenant', () => {
    expect(isSelfOrDescendant('other', 'asm', edges)).toBe(false);
  });

  it('returns false when the target is absent from the edge list (cross-tenant)', () => {
    expect(isSelfOrDescendant('foreign-id', 'rsm', edges)).toBe(false);
  });

  it('guards against cycles', () => {
    const cyclic = [
      { id: 'a', reportingToId: 'b' },
      { id: 'b', reportingToId: 'a' },
    ];
    expect(isSelfOrDescendant('a', 'caller', cyclic)).toBe(false);
  });
});
