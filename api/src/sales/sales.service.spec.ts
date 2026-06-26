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
  salesHierarchyLevel: { findFirst: jest.fn() },
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
            user: { name: 'Sub One', phone: '9900000041' },
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
          mobile: '9900000041', // employee phone — shown under the name in the team list
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

    it("re-KYC prefill (REJECTED): existingKyc carries address/pincode from the outlet columns AND the NEW accountHolderName from partner.bankAccountHolder", async () => {
      // Re-KYC bug fix (Task E): Street Address, Pincode and Account Holder Name must
      // prefill from the last-submitted values. KycSubmission stores no address/bank
      // snapshot, so the canonical source IS the Outlet columns (addressLine1/pincode,
      // written on each submit) + ChannelPartner.bankAccountHolder. accountHolderName was
      // previously DROPPED (never selected, never set) → it came back blank.
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'caller-su', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        {
          outlet: {
            id: 'o1',
            outletCode: 'OC1',
            name: 'Outlet 1',
            phone: '999',
            addressLine1: '12 MG Road',
            addressLine2: 'Near Park',
            city: 'Delhi',
            district: 'Central',
            state: 'DL',
            pincode: '110001',
            outletType: { code: 'RETAIL' },
            partner: {
              id: 'cp1',
              phone: '888',
              businessName: 'Acme Stores',
              gstNumber: '07AAACT9811F1Z9',
              panNumber: 'AAACT9811F',
              bankName: 'HDFC',
              bankAccountNumber: '123456789',
              bankAccountHolder: 'Ramesh Kumar',
              ifscCode: 'HDFC0000001',
              upiId: 'ramesh@upi',
              wallets: [{ redeemablePoints: 0 }],
              // Latest submission is REJECTED → re-entry → existingKyc is built.
              kycSubmissions: [
                {
                  id: 'k1',
                  status: 'REJECTED',
                  createdAt: new Date('2024-06-01T00:00:00.000Z'),
                  rejectionReason: 'Bank proof unclear',
                },
              ],
            },
          },
        },
      ]);

      const res = await service.getMyOutlets(caller);

      // The partner select must now include bankAccountHolder (fallback source).
      const include = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].include;
      expect(include.outlet.include.partner.select.bankAccountHolder).toBe(true);

      const existingKyc = res.outlets[0].existingKyc!;
      expect(existingKyc).not.toBeNull();
      // address/pincode prefill from the outlet columns (last-submitted snapshot).
      expect(existingKyc.address).toBe('12 MG Road, Near Park');
      expect(existingKyc.pincode).toBe('110001');
      // NEW key — account holder name now prefills from partner.bankAccountHolder.
      expect(existingKyc.accountHolderName).toBe('Ramesh Kumar');
      // city/state behaviour unchanged.
      expect(existingKyc.city).toBe('Delhi');
      expect(existingKyc.state).toBe('DL');
    });

    it("re-KYC prefill: accountHolderName defaults to '' (never undefined) when partner.bankAccountHolder is null", async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'caller-su', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        {
          outlet: {
            id: 'o1',
            outletCode: 'OC1',
            name: 'Outlet 1',
            phone: '999',
            addressLine1: null,
            addressLine2: null,
            city: 'Delhi',
            district: 'Central',
            state: 'DL',
            pincode: null,
            outletType: { code: 'RETAIL' },
            partner: {
              id: 'cp1',
              phone: '888',
              businessName: 'Acme Stores',
              gstNumber: null,
              panNumber: null,
              bankName: null,
              bankAccountNumber: null,
              bankAccountHolder: null,
              ifscCode: null,
              upiId: null,
              wallets: [],
              kycSubmissions: [
                { id: 'k1', status: 'REJECTED', createdAt: new Date('2024-06-01T00:00:00.000Z'), rejectionReason: null },
              ],
            },
          },
        },
      ]);

      const res = await service.getMyOutlets(caller);
      const existingKyc = res.outlets[0].existingKyc!;
      expect(existingKyc.accountHolderName).toBe('');
      expect(existingKyc.address).toBe('');
      expect(existingKyc.pincode).toBe('');
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

  // ─── getLeaderboard (same-level peer ranking by subtree primary-KPI %) ─────────
  describe('getLeaderboard', () => {
    // Helper: wire the standard call sequence the method makes, in order:
    //   1. salesUser.findFirst  → the caller
    //   2. salesUser.findMany   → the tenant's sales users (population + edges)
    //   3. salesUserAssignment.findMany → active assignments
    //   4. kpiDef.findMany      → KPI defs
    //   5. outletTarget.findMany / outletSalesRecord.findMany → curr then prev month
    const wire = (opts: {
      caller: unknown;
      users?: unknown[];
      assignments?: unknown[];
      kpis?: unknown[];
      currTargets?: unknown[];
      currAch?: unknown[];
      prevTargets?: unknown[];
      prevAch?: unknown[];
      znmLevel?: unknown;
    }) => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(opts.caller);
      mockPrisma.salesUser.findMany.mockResolvedValue(opts.users ?? []);
      // ZNM hierarchy level (territory proxy); default null = no ZNM level → region/zone fallback.
      mockPrisma.salesHierarchyLevel.findFirst.mockResolvedValue(opts.znmLevel ?? null);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue(opts.assignments ?? []);
      mockPrisma.kpiDef.findMany.mockResolvedValue(opts.kpis ?? []);
      // curr month read first, then prev month read.
      mockPrisma.outletTarget.findMany
        .mockResolvedValueOnce(opts.currTargets ?? [])
        .mockResolvedValueOnce(opts.prevTargets ?? []);
      mockPrisma.outletSalesRecord.findMany
        .mockResolvedValueOnce(opts.currAch ?? [])
        .mockResolvedValueOnce(opts.prevAch ?? []);
    };

    const PRIMARY = [{ code: 'SALES', isPrimary: true }];

    it('territory = the ZNM ancestor name (zone proxy); falls back to region when no ZNM', async () => {
      const usersWithZnm = [
        { id: 'su-me', userId: 'user-mgr', reportingToId: 'znm-1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
        // The ZNM ancestor (different level — NOT in the population, but used for the walk-up).
        { id: 'znm-1', userId: 'user-znm', reportingToId: null, hierarchyLevelId: 'LZ', region: null, zone: null, isActive: true, user: { name: 'North Zone Mgr' } },
      ];
      const callerSu = { id: 'su-me', userId: 'user-mgr', reportingToId: 'znm-1', hierarchyLevelId: 'L1', region: 'North' };

      // With a ZNM level configured → territory walks up to the ZNM's name.
      wire({ caller: callerSu, users: usersWithZnm, znmLevel: { id: 'LZ' }, kpis: PRIMARY });
      const withZnm = await service.getLeaderboard(caller, 'national', '2026-06');
      expect(withZnm.entries.find((e) => e.name === 'Me')!.territory).toBe('North Zone Mgr');

      // No ZNM level → falls back to the rep's own region.
      wire({ caller: callerSu, users: usersWithZnm, znmLevel: null, kpis: PRIMARY });
      const noZnm = await service.getLeaderboard(caller, 'national', '2026-06');
      expect(noZnm.entries.find((e) => e.name === 'Me')!.territory).toBe('North');
    });

    it('(g) returns {entries:[]} when the caller is not a sales user', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getLeaderboard(caller, 'rm');
      expect(res).toEqual({ entries: [] });
      // Never loads the population.
      expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
    });

    it('(a) ranks by achievementPct desc; (e) isMe set on the caller', async () => {
      // Three same-level peers under the same RM. su-me 50%, su-b 90%, su-c 0%.
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
          { id: 'su-b',  userId: 'user-b',   reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Bravo' } },
          { id: 'su-c',  userId: 'user-c',   reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Charlie' } },
        ],
        assignments: [
          { salesUserId: 'su-me', outlet: { outletCode: 'OM' } },
          { salesUserId: 'su-b',  outlet: { outletCode: 'OB' } },
          { salesUserId: 'su-c',  outlet: { outletCode: 'OC' } },
        ],
        kpis: PRIMARY,
        currTargets: [
          { outletCode: 'OM', targetValues: { SALES: 100 } },
          { outletCode: 'OB', targetValues: { SALES: 100 } },
          { outletCode: 'OC', targetValues: { SALES: 100 } },
        ],
        currAch: [
          { outletCode: 'OM', kpiValues: { SALES: 50 } },
          { outletCode: 'OB', kpiValues: { SALES: 90 } },
          { outletCode: 'OC', kpiValues: { SALES: 0 } },
        ],
      });

      const res = await service.getLeaderboard(caller, 'rm', '2026-06');
      expect(res.entries.map((e) => [e.name, e.achievementPct])).toEqual([
        ['Bravo', 90],
        ['Me', 50],
        ['Charlie', 0],
      ]);
      expect(res.entries.find((e) => e.name === 'Me')!.isMe).toBe(true);
      expect(res.entries.find((e) => e.name === 'Bravo')!.isMe).toBe(false);
    });

    it('(b) rm scope returns only same-reportingTo peers incl. the caller', async () => {
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me',    userId: 'user-mgr', reportingToId: 'rm1',   hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
          { id: 'su-peer',  userId: 'user-p',   reportingToId: 'rm1',   hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Peer' } },
          // different RM → excluded for rm scope even though same level
          { id: 'su-other', userId: 'user-o',   reportingToId: 'rm2',   hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Other' } },
        ],
        kpis: PRIMARY,
      });

      const res = await service.getLeaderboard(caller, 'rm', '2026-06');
      const names = res.entries.map((e) => e.name).sort();
      expect(names).toEqual(['Me', 'Peer']);
    });

    it('(c) state filters by region+level; national by level only', async () => {
      const users = [
        { id: 'su-me',  userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
        { id: 'su-n',   userId: 'user-n',   reportingToId: 'rm2', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'NorthPeer' } },
        { id: 'su-s',   userId: 'user-s',   reportingToId: 'rm3', hierarchyLevelId: 'L1', region: 'South', zone: null, isActive: true, user: { name: 'SouthPeer' } },
        // different level → never in any scope
        { id: 'su-lvl', userId: 'user-l',   reportingToId: 'rm2', hierarchyLevelId: 'L2', region: 'North', zone: null, isActive: true, user: { name: 'OtherLevel' } },
      ];
      const callerSu = { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' };

      wire({ caller: callerSu, users, kpis: PRIMARY });
      const stateRes = await service.getLeaderboard(caller, 'state', '2026-06');
      expect(stateRes.entries.map((e) => e.name).sort()).toEqual(['Me', 'NorthPeer']);

      wire({ caller: callerSu, users, kpis: PRIMARY });
      const natRes = await service.getLeaderboard(caller, 'national', '2026-06');
      expect(natRes.entries.map((e) => e.name).sort()).toEqual(['Me', 'NorthPeer', 'SouthPeer']);
    });

    it('(d) achievementPct = 0 when the subtree target sum is 0 (no div-by-zero)', async () => {
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
        ],
        assignments: [{ salesUserId: 'su-me', outlet: { outletCode: 'OM' } }],
        kpis: PRIMARY,
        currTargets: [], // no target rows → target sum 0
        currAch: [{ outletCode: 'OM', kpiValues: { SALES: 500 } }],
      });
      const res = await service.getLeaderboard(caller, 'rm', '2026-06');
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0].achievementPct).toBe(0);
      expect(Number.isFinite(res.entries[0].achievementPct)).toBe(true);
    });

    it('(f) change = prevRank − currRank; change = 0 when no prior-month target', async () => {
      // Two peers. Current month: Me 90% (#1), Peer 50% (#2).
      // Previous month: Me 10%, Peer 80% → prev ranks Peer #1, Me #2.
      // So Me change = prevRank(2) − currRank(1) = +1 (moved up);
      //    Peer change = prevRank(1) − currRank(2) = −1 (moved down).
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me',   userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
          { id: 'su-peer', userId: 'user-p',   reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Peer' } },
        ],
        assignments: [
          { salesUserId: 'su-me',   outlet: { outletCode: 'OM' } },
          { salesUserId: 'su-peer', outlet: { outletCode: 'OP' } },
        ],
        kpis: PRIMARY,
        currTargets: [
          { outletCode: 'OM', targetValues: { SALES: 100 } },
          { outletCode: 'OP', targetValues: { SALES: 100 } },
        ],
        currAch: [
          { outletCode: 'OM', kpiValues: { SALES: 90 } },
          { outletCode: 'OP', kpiValues: { SALES: 50 } },
        ],
        prevTargets: [
          { outletCode: 'OM', targetValues: { SALES: 100 } },
          { outletCode: 'OP', targetValues: { SALES: 100 } },
        ],
        prevAch: [
          { outletCode: 'OM', kpiValues: { SALES: 10 } },
          { outletCode: 'OP', kpiValues: { SALES: 80 } },
        ],
      });
      const res = await service.getLeaderboard(caller, 'rm', '2026-06');
      const me = res.entries.find((e) => e.name === 'Me')!;
      const peer = res.entries.find((e) => e.name === 'Peer')!;
      expect(me.change).toBe(1);
      expect(peer.change).toBe(-1);

      // Now no prior-month target at all → change = 0 for everyone.
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
        ],
        assignments: [{ salesUserId: 'su-me', outlet: { outletCode: 'OM' } }],
        kpis: PRIMARY,
        currTargets: [{ outletCode: 'OM', targetValues: { SALES: 100 } }],
        currAch: [{ outletCode: 'OM', kpiValues: { SALES: 50 } }],
        prevTargets: [], // no prior-month target data
        prevAch: [],
      });
      const res2 = await service.getLeaderboard(caller, 'rm', '2026-06');
      expect(res2.entries[0].change).toBe(0);
    });

    it('aggregates a candidate\'s SUBTREE and counts distinct subtree outlets', async () => {
      // Manager su-me has a subordinate su-sub; the manager's number rolls up both.
      // su-me assigned OM, su-sub assigned OS → activeOutlets = 2 for su-me.
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me',  userId: 'user-mgr', reportingToId: 'rm1',   hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
          // subordinate is a DIFFERENT level — not in the population, but rolls into su-me's subtree
          { id: 'su-sub', userId: 'user-s',   reportingToId: 'su-me', hierarchyLevelId: 'L2', region: 'North', zone: null, isActive: true, user: { name: 'Sub' } },
        ],
        assignments: [
          { salesUserId: 'su-me',  outlet: { outletCode: 'OM' } },
          { salesUserId: 'su-sub', outlet: { outletCode: 'OS' } },
        ],
        kpis: PRIMARY,
        currTargets: [
          { outletCode: 'OM', targetValues: { SALES: 100 } },
          { outletCode: 'OS', targetValues: { SALES: 100 } },
        ],
        currAch: [
          { outletCode: 'OM', kpiValues: { SALES: 80 } },
          { outletCode: 'OS', kpiValues: { SALES: 120 } },
        ],
      });
      const res = await service.getLeaderboard(caller, 'rm', '2026-06');
      // only su-me is at L1 → single entry, subtree-aggregated
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0].achievementPct).toBe(100); // (80+120)/(100+100)
      expect(res.entries[0].activeOutlets).toBe(2);
    });

    it('(h) cross-tenant: candidates from another clientId never appear (tenant-scoped queries)', async () => {
      // The population/target reads are tenant-scoped via the clientId filters;
      // assert every query carried the caller's clientId.
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
        ],
        kpis: PRIMARY,
      });
      await service.getLeaderboard(caller, 'national', '2026-06');

      // caller lookup tenant-scoped
      expect(mockPrisma.salesUser.findFirst.mock.calls[0][0].where).toMatchObject({
        user: { clientId: 'deoleo' },
      });
      // population/edges tenant-scoped
      expect(mockPrisma.salesUser.findMany.mock.calls[0][0].where).toEqual({
        user: { clientId: 'deoleo' }, deletedAt: null,
      });
      // both month target reads tenant-scoped
      for (const call of mockPrisma.outletTarget.findMany.mock.calls) {
        expect(call[0].where).toMatchObject({ clientId: 'deoleo' });
      }
      for (const call of mockPrisma.outletSalesRecord.findMany.mock.calls) {
        expect(call[0].where).toMatchObject({ clientId: 'deoleo' });
      }
    });

    it('excludes inactive sales users from the population', async () => {
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me',   userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true,  user: { name: 'Me' } },
          { id: 'su-dead', userId: 'user-d',   reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: false, user: { name: 'Inactive' } },
        ],
        kpis: PRIMARY,
      });
      const res = await service.getLeaderboard(caller, 'rm', '2026-06');
      expect(res.entries.map((e) => e.name)).toEqual(['Me']);
    });

    it('defaults an unknown scope to rm', async () => {
      wire({
        caller: { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' },
        users: [
          { id: 'su-me',    userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
          { id: 'su-other', userId: 'user-o',   reportingToId: 'rm2', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Other' } },
        ],
        kpis: PRIMARY,
      });
      const res = await service.getLeaderboard(caller, 'bogus' as string, '2026-06');
      // rm behaviour: only same-reportingTo peers
      expect(res.entries.map((e) => e.name)).toEqual(['Me']);
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
