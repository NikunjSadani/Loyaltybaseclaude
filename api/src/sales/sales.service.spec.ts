// Unit tests for SalesService — ported sales-org domain.
// Covers the hierarchy ownership / cross-tenant IDOR guard (isSelfOrDescendant)
// and tenant scoping (clientId from the JWT) on the ported real routes.
// Run: npx jest src/sales/sales.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
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
  // Used by resolveGroupPan (owner-group PAN resolution) for the KYC pre-fill in buildOutlets.
  channelPartner: { findUnique: jest.fn(), findFirst: jest.fn() },
  outlet: { findFirst: jest.fn() },
  // Used by resolveGroupCarryForwardDocs (group GST-cert/cheque inheritability booleans).
  kycSubmission: { findFirst: jest.fn() },
};

// TenantService.resolveClient feeds the DB-backed feature blob into /sales/me
// (§A-DOMAIN "P5").
const TENANT_FEATURES = { salesTeamApp: true, walletModule: true };
const mockTenant = { resolveClient: jest.fn() };

const caller: JwtPayload = { sub: 'user-mgr', role: 'SALES', clientId: 'deoleo', phone: '', name: '' };

describe('SalesService', () => {
  let service: SalesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveClient.mockResolvedValue({ features: TENANT_FEATURES });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
      ],
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

    it('maps subordinates into member rows (incl. the whole-subtree rollup fields)', async () => {
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
      // buildTeamRollups: edges → assignments → kpiDef → primary maps.
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'mgr1', reportingToId: null, userId: 'u-mgr1' },
        { id: 'sub1', reportingToId: 'mgr1', userId: 'u-sub1' },
      ]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]); // no outlets
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);              // no KPIs
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

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
          // sub1 has no downline of its own → its branch is just itself.
          submitterUserIds: ['u-sub1'],
          joinedAt: '2024-01-01T00:00:00.000Z',
          // No outlets/targets → rollup is all-zero (but the FIELDS are present).
          outlets: 0,
          kycDone: 0,
          kycPending: 0,
          targetValue: 0,
          targetPct: 0,
        },
      ]);
    });

    it("rolls up each direct member's WHOLE SUBTREE (outlets/kyc/target) for the summary tiles", async () => {
      // Viewer mgr1 has one direct subordinate sub1; sub1 in turn manages sub2.
      // sub1 is assigned outlet O1 (APPROVED KYC); sub2 is assigned outlet O2
      // (NOT_STARTED, partner-less). The rollup on sub1 must roll up its WHOLE
      // subtree {sub1, sub2}: 2 outlets, 1 KYC done, 1 pending, and the primary-KPI
      // target/achieved summed over O1+O2.
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
            _count: { subordinates: 1 },
          },
        ],
      });
      // edges: mgr1 → sub1 → sub2 (sub2 is sub1's downline, NOT a direct member).
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'mgr1', reportingToId: null, userId: 'u-mgr1' },
        { id: 'sub1', reportingToId: 'mgr1', userId: 'u-sub1' },
        { id: 'sub2', reportingToId: 'sub1', userId: 'u-sub2' },
      ]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        {
          salesUserId: 'sub1',
          outlet: {
            id: 'o1', outletCode: 'O1',
            isActive: true, // APPROVED → active → in the target-% set
            partner: { kycSubmissions: [{ status: 'APPROVED' }] },
          },
        },
        {
          salesUserId: 'sub2',
          outlet: {
            id: 'o2', outletCode: 'O2',
            isActive: false, // PENDING/partner-less → NOT active → EXCLUDED from target-%
            partner: null, // partner-less → NOT_STARTED → pending
          },
        },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'SALES', isPrimary: true }]);
      // primaryMapsForMonth: target then achievement reads. Both O1 AND O2 carry
      // target/achievement rows (sibling upload-relaxation now uploads non-approved
      // outlets too) — but only the ACTIVE outlet (O1) may count toward the target %.
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'O1', targetValues: { SALES: 100 } },
        { outletCode: 'O2', targetValues: { SALES: 100 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O1', kpiValues: { SALES: 80 } },
        { outletCode: 'O2', kpiValues: { SALES: 40 } },
      ]);

      const res = await service.getTeam(caller);
      const sub1 = res.members.find((m: { id: string }) => m.id === 'sub1')!;
      expect(sub1).toMatchObject({
        // Branch submitter set = the member + its WHOLE downline (sub1 + sub2) — drives
        // the KYC-list "pick a manager → see their whole branch" filter.
        submitterUserIds: expect.arrayContaining(['u-sub1', 'u-sub2']),
        // COUNTS stay all-inclusive (approved + pending outlets both count).
        outlets: 2,        // O1 + O2 across the subtree {sub1, sub2}
        kycDone: 1,        // O1 APPROVED
        kycPending: 1,     // O2 NOT_STARTED (partner-less)
        // Target % is APPROVED+ACTIVE only → O1 alone (O2's target/ach are dropped).
        targetValue: 100,  // O1 only (O2 inactive → excluded)
        targetPct: 80,     // round(100 * 80 / 100)
      });

      // The assignment query is bounded by the viewer's whole subtree (no N+1
      // per-member queries) and only loads active outlets.
      const aWhere = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where;
      expect(aWhere.salesUserId.in.sort()).toEqual(['mgr1', 'sub1', 'sub2']);
      expect(aWhere.unassignedAt).toBeNull();
      // Regression guard: must NOT add an `outlet:{isActive:true}` filter — outlets are
      // created isActive:false (PENDING) until KYC approval, so filtering it out would
      // under-count "Outlets" vs /sales/outlets and zero out "KYC Pending". Match
      // buildOutlets/getMember exactly (assignment-only scoping). O2 above is a
      // partner-less/NOT_STARTED outlet and STILL counts toward outlets(2)+kycPending(1).
      // The ONLY outlet filter permitted is the PARKED-exclusion OR-wrap (never isActive).
      expect(aWhere.outlet).toEqual({ OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' } }] });
      expect(JSON.stringify(aWhere.outlet)).not.toContain('isActive');
      // Exactly ONE assignment query (in-memory rollup, not per-member).
      expect(mockPrisma.salesUserAssignment.findMany).toHaveBeenCalledTimes(1);
    });

    it('rollup assignment query excludes admin-PARKED outlets (null-safe OR-wrap) so KYC-Pending counts skip them', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'mgr1', employeeCode: 'E1', region: 'North', zone: null,
        hierarchyLevel: { code: 'ASM', name: 'Area Sales Manager', level: 2 },
        subordinates: [
          {
            id: 'sub1', employeeCode: 'E2', region: 'NCR', zone: null,
            joinedAt: new Date('2024-01-01T00:00:00.000Z'),
            user: { name: 'Sub One', phone: '9900000041' },
            hierarchyLevel: { code: 'SO', name: 'Sales Officer', level: 1 },
            _count: { subordinates: 0 },
          },
        ],
      });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'mgr1', reportingToId: null },
        { id: 'sub1', reportingToId: 'mgr1' },
      ]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([]);
      await service.getTeam(caller);

      const aWhere = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where;
      // The DB drops PARKED via this null-safe wrap → they never reach the in-memory
      // outlets/kycPending tally. Keeps null + NOT_INTERESTED (only PARKED is named).
      expect(aWhere.outlet).toEqual({ OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' } }] });
      expect(JSON.stringify(aWhere.outlet)).not.toContain('NOT_INTERESTED');
    });

    it('tenant-scopes the rollup edge + target reads to the caller clientId', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'mgr1', employeeCode: 'E1', region: 'North', zone: null,
        hierarchyLevel: { code: 'ASM', name: 'Area Sales Manager', level: 2 },
        subordinates: [
          {
            id: 'sub1', employeeCode: 'E2', region: 'NCR', zone: null,
            joinedAt: new Date('2024-01-01T00:00:00.000Z'),
            user: { name: 'Sub One', phone: '9900000041' },
            hierarchyLevel: { code: 'SO', name: 'Sales Officer', level: 1 },
            _count: { subordinates: 0 },
          },
        ],
      });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'mgr1', reportingToId: null },
        { id: 'sub1', reportingToId: 'mgr1' },
      ]);
      // A primary KPI + one assigned outlet so the primary target/achievement reads
      // actually run (they short-circuit when there is no primary KPI / no outlet).
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUserId: 'sub1', outlet: { id: 'o1', outletCode: 'O1', partner: { kycSubmissions: [{ status: 'APPROVED' }] } } },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'SALES', isPrimary: true }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      await service.getTeam(caller);
      // edge list tenant-scoped
      expect(mockPrisma.salesUser.findMany.mock.calls[0][0].where).toEqual({
        user: { clientId: 'deoleo' }, deletedAt: null,
      });
      // primary target/achievement reads tenant-scoped
      expect(mockPrisma.outletTarget.findMany.mock.calls[0][0].where).toMatchObject({ clientId: 'deoleo' });
      expect(mockPrisma.outletSalesRecord.findMany.mock.calls[0][0].where).toMatchObject({ clientId: 'deoleo' });
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
        // outlet a rep marked NOT_INTERESTED (kycIntent set, no KYC submission) →
        // kycStatus must derive NOT_INTERESTED (so the sales KYC list shows it distinctly).
        {
          outlet: {
            id: 'o3',
            outletCode: 'OC3',
            name: 'Outlet 3',
            phone: '666',
            city: 'Pune',
            district: 'West',
            state: 'MH',
            outletType: { code: 'RETAIL' },
            kycIntent: 'NOT_INTERESTED',
            partner: null,
          },
        },
      ]);
      const res = await service.getMyOutlets(caller);
      const where = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where;
      expect(where).toEqual({
        salesUserId: { in: ['caller-su'] },
        outletId: { not: null },
        unassignedAt: null,
        // PARKED outlets are FULLY hidden from reps via a null-safe OR-wrap (keeps null +
        // NOT_INTERESTED, drops only PARKED).
        outlet: { OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' } }] },
      });

      expect(res.outlets).toHaveLength(3);
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
      // the not-interested outlet: kycIntent overrides the (absent) KYC status.
      expect(res.outlets[2]).toMatchObject({
        id: 'o3', outletCode: 'OC3', name: 'Outlet 3', kycStatus: 'NOT_INTERESTED',
      });
    });

    it('an APPROVED outlet flagged for re-KYC (reKycFlags set) derives RE_KYC_REQUIRED, not APPROVED', async () => {
      // Admin re-KYC upload sets Outlet.reKycFlags but leaves the submission APPROVED —
      // the rep must see the outlet under Re-KYC (mirrors admin deriveKycStatus).
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'caller-su', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        {
          outlet: {
            id: 'o1', outletCode: 'OC1', name: 'Outlet 1', phone: '999',
            city: 'Delhi', district: 'Central', state: 'DL',
            outletType: { code: 'RETAIL' },
            reKycFlags: { mobileNumber: true, remarks: '' }, // flagged for re-KYC
            partner: {
              id: 'cp1', phone: '888', wallets: [{ redeemablePoints: 0 }],
              kycSubmissions: [{ id: 'k1', status: 'APPROVED', createdAt: new Date('2024-05-01T00:00:00.000Z') }],
            },
          },
        },
      ]);
      const res = await service.getMyOutlets(caller);
      expect(res.outlets[0]).toMatchObject({ id: 'o1', kycId: 'k1', kycStatus: 'RE_KYC_REQUIRED' });
      // reKycFlags surfaced so the wizard can pre-fill the fields to re-capture.
      expect(res.outlets[0].reKycFlags).toEqual({ mobileNumber: true, remarks: '' });
    });

    it('a flagged outlet whose resubmission is UNDER REVIEW shows the in-flight status, not RE_KYC_REQUIRED', async () => {
      // After the rep resubmits, the new submission is routed (PENDING_SO_APPROVAL) but the
      // flags STAY SET until approval. The list must show the under-review status, not keep
      // reading as "Re-KYC Required" — while still surfacing the flags for the approver.
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'caller-su', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        {
          outlet: {
            id: 'o1', outletCode: 'OC1', name: 'Outlet 1', phone: '999',
            city: 'Delhi', district: 'Central', state: 'DL',
            outletType: { code: 'RETAIL' },
            reKycFlags: { mobileNumber: true, remarks: '' }, // still flagged
            partner: {
              id: 'cp1', phone: '888', wallets: [{ redeemablePoints: 0 }],
              // latest submission = the resubmit, now under review
              kycSubmissions: [{ id: 'k2', status: 'PENDING_SO_APPROVAL', createdAt: new Date('2024-06-01T00:00:00.000Z') }],
            },
          },
        },
      ]);
      const res = await service.getMyOutlets(caller);
      expect(res.outlets[0]).toMatchObject({ id: 'o1', kycId: 'k2', kycStatus: 'PENDING_SO_APPROVAL' });
      // Flags still surfaced (the approver highlight persists through review).
      expect(res.outlets[0].reKycFlags).toEqual({ mobileNumber: true, remarks: '' });
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

    it('FULLY hides admin-PARKED outlets via a null-safe OR-wrap (drops PARKED, keeps null + NOT_INTERESTED)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'caller-su', reportingToId: null }]);
      // The DB applies the where — assert the query carries the exact null-safe exclusion so
      // a PARKED outlet is dropped while a null-kycIntent (normal) and a NOT_INTERESTED outlet
      // are KEPT (the OR-null-wrap that the Prisma `{not:'PARKED'}` NULL-drop trap requires).
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
      await service.getMyOutlets(caller);

      const where = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0].where;
      expect(where.outlet).toEqual({ OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' } }] });
      // The wrap keeps null-kycIntent rows: the `{ kycIntent: null }` OR branch is present.
      expect(where.outlet.OR).toContainEqual({ kycIntent: null });
      // NOT_INTERESTED is NOT excluded — only PARKED is named in the `not`.
      expect(JSON.stringify(where.outlet)).not.toContain('NOT_INTERESTED');
      expect(JSON.stringify(where.outlet)).toContain('PARKED');
    });

    // ── Stream C: owner-group KYC pre-fill (parentPrefill) ──────────────────────
    // A child outlet grouped-before-KYC (Outlet.parentId set) whose parent is APPROVED.
    const groupedOutlet = (parent: Record<string, unknown> | null) => ({
      outlet: {
        id: 'o-child',
        outletCode: 'OC-CHILD',
        name: 'Child Outlet',
        phone: '999',
        city: 'Delhi',
        district: 'Central',
        state: 'DL',
        outletType: { code: 'RETAIL' },
        parentId: parent ? 'parent-1' : null,
        parent,
        partner: null, // not KYC'd yet — grouped before KYC
      },
    });
    const primeCaller = () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'caller-su' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'caller-su', reportingToId: null }]);
    };

    it('emits parentPrefill (with groupPan) when the outlet is grouped under an APPROVED parent', async () => {
      primeCaller();
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        groupedOutlet({ onboardedAt: new Date('2024-01-01T00:00:00.000Z') }),
      ]);
      // resolveGroupIdentity reads the parent via findFirst (where.id); an APPROVED parent carrying
      // details IS the source. resolveGroupPan reads the parent's PAN via findUnique.
      mockPrisma.channelPartner.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.id
          ? {
              onboardedAt: new Date('2024-01-01T00:00:00.000Z'),
              businessName: 'Group Owner Co', ownerName: 'Group Owner',
              gstNumber: '07AAACT9811F1Z9', panNumber: 'AAACT9811F',
              bankName: 'HDFC', bankAccountNumber: '123456789', bankAccountHolder: 'Group Owner',
              ifscCode: 'HDFC0000001', upiId: 'owner@upi',
            }
          : null),
      );
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'AAACT9811F' });

      const res = await service.getMyOutlets(caller);
      const prefill = res.outlets[0].parentPrefill!;
      expect(prefill).toBeDefined();
      expect(prefill).toMatchObject({
        businessName: 'Group Owner Co',
        ownerName: 'Group Owner',
        gstNumber: '07AAACT9811F1Z9',
        panNumber: 'AAACT9811F',
        bankName: 'HDFC',
        bankAccountNumber: '123456789',
        bankAccountHolder: 'Group Owner',
        ifscCode: 'HDFC0000001',
        upiId: 'owner@upi',
        groupPan: 'AAACT9811F',
      });
    });

    it('emits parentPrefill from an APPROVED SIBLING when the parent carries no details', async () => {
      primeCaller();
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([groupedOutlet({ onboardedAt: null })]);
      // Parent unapproved/no details → resolveGroupIdentity's 2nd findFirst (the sibling, no where.id).
      mockPrisma.channelPartner.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.id
          ? { onboardedAt: null, panNumber: null }
          : {
              businessName: 'Sibling Store', ownerName: 'Sib Owner',
              gstNumber: null, panNumber: 'AAACT9811F',
              bankName: 'ICICI', bankAccountNumber: '999', bankAccountHolder: 'Sib Owner',
              ifscCode: 'ICIC0000001', upiId: 'sib@upi',
            }),
      );
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: null }); // parent has no PAN
      // resolveGroupPan → parent PAN null → sibling PAN (findFirst on outlet returns the sibling PAN).
      mockPrisma.outlet.findFirst.mockResolvedValue({ partner: { panNumber: 'AAACT9811F' } });

      const res = await service.getMyOutlets(caller);
      const prefill = res.outlets[0].parentPrefill!;
      expect(prefill).toMatchObject({
        businessName: 'Sibling Store', ownerName: 'Sib Owner', upiId: 'sib@upi',
        panNumber: 'AAACT9811F', groupPan: 'AAACT9811F',
      });
    });

    it('OMITS parentPrefill when the group has nothing verified (unapproved parent, no approved sibling)', async () => {
      primeCaller();
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([groupedOutlet({ onboardedAt: null })]);
      mockPrisma.channelPartner.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.id ? { onboardedAt: null, panNumber: null } : null),
      );
      const res = await service.getMyOutlets(caller);
      expect(res.outlets[0].parentPrefill).toBeUndefined();
    });

    it('OMITS parentPrefill when the outlet has no parent (ungrouped)', async () => {
      primeCaller();
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([groupedOutlet(null)]);
      const res = await service.getMyOutlets(caller);
      expect(res.outlets[0].parentPrefill).toBeUndefined();
      expect(mockPrisma.channelPartner.findUnique).not.toHaveBeenCalled();
    });

    it('sets gstCertInheritable/chequeInheritable TRUE when the group source has both approved docs', async () => {
      primeCaller();
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        groupedOutlet({ onboardedAt: new Date('2024-01-01T00:00:00.000Z') }),
      ]);
      mockPrisma.channelPartner.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.id
          ? {
              onboardedAt: new Date('2024-01-01T00:00:00.000Z'),
              businessName: 'Group Owner Co', ownerName: 'Group Owner',
              gstNumber: '07AAACT9811F1Z9', panNumber: 'AAACT9811F',
              bankName: 'HDFC', bankAccountNumber: '123456789', bankAccountHolder: 'Group Owner',
              ifscCode: 'HDFC0000001', upiId: 'owner@upi',
            }
          : null),
      );
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'AAACT9811F' });
      // resolveGroupCarryForwardDocs: the source's approved submission carries BOTH docs.
      mockPrisma.kycSubmission.findFirst.mockResolvedValue({
        documents: [
          { documentType: 'GST_CERTIFICATE', fileUrl: 'u1', fileKey: 'k1', fileName: 'g.pdf', mimeType: 'application/pdf', fileSizeBytes: 10 },
          { documentType: 'CANCELLED_CHEQUE', fileUrl: 'u2', fileKey: 'k2', fileName: 'c.pdf', mimeType: 'application/pdf', fileSizeBytes: 20 },
        ],
      });

      const res = await service.getMyOutlets(caller);
      const prefill = res.outlets[0].parentPrefill!;
      expect(prefill.gstCertInheritable).toBe(true);
      expect(prefill.chequeInheritable).toBe(true);
    });

    it('sets both inheritability booleans FALSE when the group source has no approved docs', async () => {
      primeCaller();
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        groupedOutlet({ onboardedAt: new Date('2024-01-01T00:00:00.000Z') }),
      ]);
      mockPrisma.channelPartner.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(where.id
          ? {
              onboardedAt: new Date('2024-01-01T00:00:00.000Z'),
              businessName: 'Group Owner Co', ownerName: 'Group Owner',
              gstNumber: '07AAACT9811F1Z9', panNumber: 'AAACT9811F',
              bankName: 'HDFC', bankAccountNumber: '123456789', bankAccountHolder: 'Group Owner',
              ifscCode: 'HDFC0000001', upiId: 'owner@upi',
            }
          : null),
      );
      mockPrisma.channelPartner.findUnique.mockResolvedValue({ panNumber: 'AAACT9811F' });
      // No approved submission → resolveGroupCarryForwardDocs returns both null.
      mockPrisma.kycSubmission.findFirst.mockResolvedValue(null);

      const res = await service.getMyOutlets(caller);
      const prefill = res.outlets[0].parentPrefill!;
      expect(prefill.gstCertInheritable).toBe(false);
      expect(prefill.chequeInheritable).toBe(false);
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
        features: TENANT_FEATURES,
      });
    });

    it('includes the DB-backed tenant feature blob (resolveClient) on /sales/me', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);
      const res = await service.getMe(caller);
      expect(mockTenant.resolveClient).toHaveBeenCalledWith('deoleo');
      expect(res.features).toEqual(TENANT_FEATURES);
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
        { outlet: { outletCode: 'O1', isActive: true } }, { outlet: { outletCode: 'O2', isActive: true } },
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
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([{ outlet: { outletCode: 'O1', isActive: true } }]);
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

  // ─── WS3: KPI surfaces count APPROVED+ACTIVE outlets only; DETAIL views keep all ──
  // The sibling upload-relaxation now creates OutletTarget/OutletSalesRecord rows for
  // NON-approved outlets (isActive:false). The primary-performance KPI of a sales member
  // must exclude those; the per-outlet detail list must still show them.
  describe('WS3 approved+active KPI vs all-assigned detail', () => {
    // One APPROVED (isActive:true) outlet OA and one PENDING (isActive:false) outlet OP,
    // each with a target + achievement row for the current month.
    const APPROVED_AND_PENDING_ASSIGNMENTS = [
      { outlet: { outletCode: 'OA', isActive: true } },  // approved + active
      { outlet: { outletCode: 'OP', isActive: false } }, // pending → excluded from KPI
    ];
    const KPIS = [{ code: 'SALES', label: 'Sales', unit: 'Litre', isPrimary: true }];
    const PRIMARY = [{ code: 'SALES', isPrimary: true }];
    const TARGETS = [
      { outletCode: 'OA', targetValues: { SALES: 100 } },
      { outletCode: 'OP', targetValues: { SALES: 100 } },
    ];
    const ACH = [
      { outletCode: 'OA', kpiValues: { SALES: 70 } },
      { outletCode: 'OP', kpiValues: { SALES: 10 } },
    ];

    it('(a) getTargets hero card counts ONLY the approved+active outlet', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue(APPROVED_AND_PENDING_ASSIGNMENTS);
      mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);
      // getTargets sums whatever findMany returns; the DB honours the `outletCode in
      // [active]` scope, so a faithful mock returns ONLY the active outlet's row (OA).
      // (The scoping itself is asserted below via toHaveBeenCalledWith.)
      mockPrisma.outletTarget.findMany
        .mockResolvedValueOnce([{ outletCode: 'OA', targetValues: { SALES: 100 } }]) // hero-card aggregation (active-scoped)
        .mockResolvedValueOnce([]);     // trend
      mockPrisma.outletSalesRecord.findMany
        .mockResolvedValueOnce([{ outletCode: 'OA', kpiValues: { SALES: 70 } }])
        .mockResolvedValueOnce([]);

      const res = await service.getTargets(caller, '2026-05');

      // outletCount + the SALES target/achieved must reflect OA ALONE (OP excluded).
      expect(res.outletCount).toBe(1);
      expect(res.kpis[0]).toMatchObject({ code: 'SALES', target: 100, achieved: 70 });
      // The aggregation query is scoped to the ACTIVE code set only (OA, not OP).
      expect(mockPrisma.outletTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ outletCode: { in: ['OA'] } }) }),
      );
    });

    it('(a) getLeaderboard achievementPct/activeOutlets count ONLY the approved+active outlet', async () => {
      // Inline wiring (the getLeaderboard describe's `wire` helper is out of scope here):
      // caller lookup → population/edges → ZNM level → assignments → kpiDef → curr/prev reads.
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North' });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-me', userId: 'user-mgr', reportingToId: 'rm1', hierarchyLevelId: 'L1', region: 'North', zone: null, isActive: true, user: { name: 'Me' } },
      ]);
      mockPrisma.salesHierarchyLevel.findFirst.mockResolvedValue(null);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUserId: 'su-me', outlet: { outletCode: 'OA', isActive: true } },
        { salesUserId: 'su-me', outlet: { outletCode: 'OP', isActive: false } },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue(PRIMARY);
      mockPrisma.outletTarget.findMany
        .mockResolvedValueOnce(TARGETS) // current month
        .mockResolvedValueOnce([]);     // previous month
      mockPrisma.outletSalesRecord.findMany
        .mockResolvedValueOnce(ACH)
        .mockResolvedValueOnce([]);
      const res = await service.getLeaderboard(caller, 'rm', '2026-06');
      expect(res.entries).toHaveLength(1);
      // pct = 70/100 (OA only); OP's 100 target + 10 ach are excluded.
      expect(res.entries[0].achievementPct).toBe(70);
      // activeOutlets counts distinct APPROVED+ACTIVE codes only → 1.
      expect(res.entries[0].activeOutlets).toBe(1);
    });

    it('(a) getTeam per-member target % counts ONLY the approved+active outlet (counts stay all)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'mgr1', employeeCode: 'E1', region: 'North', zone: null,
        hierarchyLevel: { code: 'ASM', name: 'Area Sales Manager', level: 2 },
        subordinates: [
          {
            id: 'sub1', employeeCode: 'E2', region: 'NCR', zone: null,
            joinedAt: new Date('2024-01-01T00:00:00.000Z'),
            user: { name: 'Sub One', phone: '9900000041' },
            hierarchyLevel: { code: 'SO', name: 'Sales Officer', level: 1 },
            _count: { subordinates: 0 },
          },
        ],
      });
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'mgr1', reportingToId: null },
        { id: 'sub1', reportingToId: 'mgr1' },
      ]);
      // sub1 assigned OA (APPROVED/active) + OP (PENDING/inactive), both with rows.
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { salesUserId: 'sub1', outlet: { id: 'oa', outletCode: 'OA', isActive: true, partner: { kycSubmissions: [{ status: 'APPROVED' }] } } },
        { salesUserId: 'sub1', outlet: { id: 'op', outletCode: 'OP', isActive: false, partner: null } },
      ]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'SALES', isPrimary: true }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue(TARGETS);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue(ACH);

      const res = await service.getTeam(caller);
      const sub1 = res.members.find((m: { id: string }) => m.id === 'sub1')!;
      // COUNTS include BOTH outlets (all-assigned); the target % is OA only.
      expect(sub1.outlets).toBe(2);       // OA + OP
      expect(sub1.kycDone).toBe(1);       // OA APPROVED
      expect(sub1.kycPending).toBe(1);    // OP NOT_STARTED (partner-less)
      expect(sub1.targetValue).toBe(100); // OA only (OP inactive → excluded)
      expect(sub1.targetPct).toBe(70);    // round(100 * 70 / 100)
    });

    it('(b) getOutletTargets DETAIL list returns BOTH the approved AND the pending outlet', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.salesUser.findMany.mockResolvedValue([{ id: 'su1', reportingToId: null }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue(APPROVED_AND_PENDING_ASSIGNMENTS);
      mockPrisma.outletTarget.findMany.mockResolvedValue(TARGETS);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue(ACH);
      mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);

      const res = await service.getOutletTargets(caller, '2026-05');
      // BOTH outlets appear (detail view is all-assigned, incl. the pending one).
      expect(res.rows.map((r: { outletCode: string }) => r.outletCode).sort()).toEqual(['OA', 'OP']);
      // The per-outlet read is scoped to the ALL code set (both OA and OP).
      const call = mockPrisma.outletTarget.findMany.mock.calls[0][0];
      expect(call.where.outletCode.in.sort()).toEqual(['OA', 'OP']);
      const op = res.rows.find((r: { outletCode: string }) => r.outletCode === 'OP')!;
      expect(op.kpis.SALES).toEqual({ target: 100, achieved: 10, pace: 0.1 });
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
          { salesUserId: 'su-me', outlet: { outletCode: 'OM', isActive: true } },
          { salesUserId: 'su-b',  outlet: { outletCode: 'OB', isActive: true } },
          { salesUserId: 'su-c',  outlet: { outletCode: 'OC', isActive: true } },
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
        assignments: [{ salesUserId: 'su-me', outlet: { outletCode: 'OM', isActive: true } }],
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
          { salesUserId: 'su-me',   outlet: { outletCode: 'OM', isActive: true } },
          { salesUserId: 'su-peer', outlet: { outletCode: 'OP', isActive: true } },
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
        assignments: [{ salesUserId: 'su-me', outlet: { outletCode: 'OM', isActive: true } }],
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
          { salesUserId: 'su-me',  outlet: { outletCode: 'OM', isActive: true } },
          { salesUserId: 'su-sub', outlet: { outletCode: 'OS', isActive: true } },
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
