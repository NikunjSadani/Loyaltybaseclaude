// Unit tests for AdminOutletsService — ported from the admin/outlets Next routes.
// Covers tenant/clientId scoping (the ownerless-outlet hole the platform lifecycle
// test guards against) + the outlet-master upsert / re-KYC flag upload validation.
// Run: npx jest src/admin-outlets/admin-outlets.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminOutletsService, deriveKycStatus } from './admin-outlets.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  outlet: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  salesUserAssignment: { updateMany: jest.fn(), create: jest.fn() },
  // The add-to-parent uniqueness check now runs INSIDE the row transaction (advisory-locked),
  // so its reads (parent PAN via findUnique, sibling PAN via findFirst, clash search via
  // findMany) + the advisory lock ($executeRaw) resolve against the tx client, not prisma.
  channelPartner: { findMany: jest.fn(), findUnique: jest.fn() },
  // user.updateMany added for the stranded-owner sessionsInvalidBefore stamp (auth 1b).
  user: { updateMany: jest.fn() },
  userSession: { updateMany: jest.fn() },
  auditLog: { create: jest.fn() },
  $executeRaw: jest.fn(),
};

const mockPrisma = {
  outlet: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn() },
  salesUser: { findUnique: jest.fn() },
  salesUserAssignment: { updateMany: jest.fn() },
  kycSubmission: { findMany: jest.fn() },
  // Owner-group (Parent ID) paths read parents + run the uniqueness helper against this model.
  channelPartner: { findMany: jest.fn(), findUnique: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

// StorageService is the @Global foundation service available to the module; none of
// the JSON-only outlet routes exercise it, but it is mocked + provided per template.
const mockStorage = {
  uploadFile: jest.fn(),
  getSignedUrl: jest.fn(),
  deleteFile: jest.fn(),
  generateKey: jest.fn(),
};

// The upsert reads the tenant UPI gate (salesApp.upiEnabled) to validate the Payout Method
// column. Default OFF; the UPI-enabled cases override it per test.
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(),
};

const TENANT_A = 'tenant-a';
const admin: JwtPayload = { sub: 'actor1', role: 'CLIENT_ADMIN', clientId: TENANT_A, phone: '', name: '' };

describe('AdminOutletsService', () => {
  let service: AdminOutletsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // list() now also reads the tenant's enabled outlet types; default to none so the
    // pre-existing list tests don't have to mock it (upsert tests override as needed).
    mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);
    // list() now paginates: outlet.count runs in parallel with findMany. Default 0.
    mockPrisma.outlet.count.mockResolvedValue(0);
    // deactivate()'s session-revoke step queries these inside the tx; default to
    // "no partners stranded" so the pre-existing deactivate tests don't have to mock it.
    mockTx.outlet.findMany.mockResolvedValue([]);
    mockTx.outlet.findFirst.mockResolvedValue(null);
    mockTx.outlet.groupBy.mockResolvedValue([]);
    mockTx.channelPartner.findMany.mockResolvedValue([]);
    mockTx.channelPartner.findUnique.mockResolvedValue(null);
    // Default: UPI disabled for the tenant (matches the platform default). uniquenessPolicy
    // all-on so the owner-group grouping tests exercise every enforced field.
    mockTenantSettings.getEffectiveSettings.mockResolvedValue({
      salesApp: { upiEnabled: false },
      uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
    });
    // Owner-group preloads default to "nothing found" so pre-existing upsert tests (which
    // never send a Parent ID) never touch these.
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findUnique.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminOutletsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        {
          provide: SalesNotificationsService,
          useValue: {
            outletsAssigned: jest.fn(),
            kycSubmittedForApproval: jest.fn(),
            kycBounced: jest.fn(),
            targetsUploaded: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(AdminOutletsService);
  });

  describe('list', () => {
    it('scopes by the outlet OWN clientId + deletedAt null (never a partner join)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await service.list(admin);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ deletedAt: null, clientId: TENANT_A });
      expect(where.partner).toBeUndefined();
    });

    it('maps the active XSR and metro flag', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'OUT-1',
          name: 'Verma Traders',
          outletTypeId: 'type1',
          city: 'Mumbai',
          state: 'MH',
          isActive: true,
          createdAt: new Date('2026-05-01T09:00:00Z'),
          distributorCode: 'DIST-01',
          beat: 'Andheri',
          metro: 'Yes',
          programName: 'Trade Loyalty',
          programCategory: 'Standard',
          partnerId: null,
          reKycFlags: null,
          kycIntent: null,
          salesAssignments: [{ salesUser: { employeeCode: 'ISR-1', user: { name: 'Anil' } } }],
        },
      ]);
      const res = await service.list(admin);
      expect(res.outlets[0]).toMatchObject({
        outletId: 'OUT-1',
        xsrId: 'ISR-1',
        xsrName: 'Anil',
        metro: true,
        addedDate: '2026-05-01',
      });
    });

    it('returns the tenant enabled outlet-type codes (sorted) for FE validation', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { code: 'WHOLESALER' } },
        { outletType: { code: 'RETAILER' } },
      ]);
      const res = await service.list(admin);
      expect(res.outletTypes).toEqual(['RETAILER', 'WHOLESALER']);
      // tenant-scoped + only enabled + only active types
      const where = mockPrisma.outletTypeClientConfig.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ clientId: TENANT_A, isEnabled: true });
    });
  });

  describe('list — pagination + filtering (mirrors channel-partners)', () => {
    it('defaults page=1 limit=50 → skip 0 take 50, and returns the pagination envelope', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.outlet.count.mockResolvedValue(137);
      const res = await service.list(admin, {});
      const args = mockPrisma.outlet.findMany.mock.calls[0][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(50);
      // Envelope shape matches channel-partners { page, limit, total, pages }.
      expect(res.pagination).toEqual({ page: 1, limit: 50, total: 137, pages: 3 });
    });

    it('computes skip=(page-1)*limit and take=limit for a non-default page', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.outlet.count.mockResolvedValue(0);
      await service.list(admin, { page: 3, limit: 20 });
      const args = mockPrisma.outlet.findMany.mock.calls[0][0];
      expect(args.skip).toBe(40); // (3-1)*20
      expect(args.take).toBe(20);
    });

    it('counts over the SAME where used by findMany (so pagination is over the filtered set)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.outlet.count.mockResolvedValue(0);
      await service.list(admin, { search: 'Verma' });
      const findWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      const countWhere = mockPrisma.outlet.count.mock.calls[0][0].where;
      expect(countWhere).toEqual(findWhere);
    });

    it('builds a search OR across code/name/beat/city + ISR name, keeping tenant scope', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await service.list(admin, { search: 'Andheri' });
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      // tenant scope intact
      expect(where.clientId).toBe(TENANT_A);
      expect(where.deletedAt).toBeNull();
      // OR spans the searched fields
      const fields = where.OR.flatMap((c: Record<string, unknown>) => Object.keys(c));
      expect(fields).toEqual(
        expect.arrayContaining(['outletCode', 'name', 'beat', 'city', 'salesAssignments']),
      );
    });

    it('kycStatus=APPROVED filters on partnerIds whose LATEST submission is APPROVED (AND tenant scope)', async () => {
      // Two owned outlets; cp1's latest is APPROVED, cp2's latest is REJECTED.
      mockPrisma.outlet.findMany
        // (a) distinct partnerIds for the tenant's owned outlets (resolved FIRST now)
        .mockResolvedValueOnce([{ partnerId: 'cp1' }, { partnerId: 'cp2' }])
        // (b) reKycFlags candidates — none flagged
        .mockResolvedValueOnce([])
        // the paginated page fetch
        .mockResolvedValueOnce([]);
      mockPrisma.kycSubmission.findMany.mockResolvedValue([
        { partnerId: 'cp1', status: 'APPROVED' },
        { partnerId: 'cp2', status: 'REJECTED' },
      ]);
      await service.list(admin, { kycStatus: 'APPROVED' });

      // The paginated fetch is the THIRD outlet.findMany call.
      const where = mockPrisma.outlet.findMany.mock.calls[2][0].where;
      // AND[baseScope, kycBucket]
      expect(where.AND[0]).toMatchObject({ clientId: TENANT_A, deletedAt: null });
      expect(where.AND[1]).toMatchObject({ partnerId: { in: ['cp1'] } });
    });

    it('kycStatus=RE_KYC_REQUIRED includes outlets carrying a non-empty reKycFlags object', async () => {
      mockPrisma.outlet.findMany
        // (a) no owned partners (resolved FIRST now)
        .mockResolvedValueOnce([])
        // (b) reKycFlags candidates: one non-empty, one empty {} (must be excluded)
        .mockResolvedValueOnce([
          { id: 'o-flagged', partnerId: null, reKycFlags: { ownerPhoto: true } },
          { id: 'o-empty', partnerId: null, reKycFlags: {} },
        ])
        // paginated fetch
        .mockResolvedValueOnce([]);
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      await service.list(admin, { kycStatus: 'RE_KYC_REQUIRED' });

      const where = mockPrisma.outlet.findMany.mock.calls[2][0].where;
      // The bucket predicate ORs on the flagged id set — only the non-empty one.
      expect(JSON.stringify(where)).toContain('o-flagged');
      expect(JSON.stringify(where)).not.toContain('o-empty');
    });

    it('kycStatus=RE_KYC_REQUIRED EXCLUDES a flagged outlet whose resubmission is UNDER REVIEW', async () => {
      // The flags persist until approval, but once the rep resubmits (latest = PENDING_SO)
      // the outlet buckets by its in-flight status, NOT Re-KYC — so it must drop out of the
      // reKycOutletIds set that drives the RE_KYC_REQUIRED filter.
      mockPrisma.outlet.findMany
        .mockResolvedValueOnce([{ partnerId: 'cp1' }]) // (a) owned partners
        .mockResolvedValueOnce([{ id: 'o-review', partnerId: 'cp1', reKycFlags: { mobileNumber: true } }]) // (b) flagged
        .mockResolvedValueOnce([]); // paginated
      mockPrisma.kycSubmission.findMany.mockResolvedValue([{ partnerId: 'cp1', status: 'PENDING_SO_APPROVAL' }]);
      await service.list(admin, { kycStatus: 'RE_KYC_REQUIRED' });

      const where = mockPrisma.outlet.findMany.mock.calls[2][0].where;
      expect(JSON.stringify(where)).not.toContain('o-review');
    });

    it('kycStatus=APPROVED excludes NOT_INTERESTED outlets (priority 2) but keeps NULL kycIntent', async () => {
      // Regression: an outlet marked NOT_INTERESTED still carries its partner + submission.
      // deriveKycStatus priority 2 makes it NOT_STARTED (ahead of the APPROVED submission
      // bucket, priority 4), so the APPROVED filter must NOT include it — else it shows under
      // the wrong tab AND double-counts the paginated total. The guard must be NULL-safe.
      mockPrisma.outlet.findMany
        .mockResolvedValueOnce([{ partnerId: 'cp1' }]) // (a) owned partners (resolved FIRST now)
        .mockResolvedValueOnce([]) // (b) none reKyc-flagged
        .mockResolvedValueOnce([]); // paginated page
      mockPrisma.kycSubmission.findMany.mockResolvedValue([{ partnerId: 'cp1', status: 'APPROVED' }]);
      await service.list(admin, { kycStatus: 'APPROVED' });

      const bucket = mockPrisma.outlet.findMany.mock.calls[2][0].where.AND[1];
      expect(bucket.AND).toEqual(
        expect.arrayContaining([
          { OR: [{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }] },
        ]),
      );
    });

    it("kycStatus=PARKED filters on kycIntent='PARKED' (its own bucket, AND tenant scope)", async () => {
      mockPrisma.outlet.findMany
        .mockResolvedValueOnce([]) // (a) owned partners
        .mockResolvedValueOnce([]) // (b) reKyc candidates
        .mockResolvedValueOnce([]); // paginated page
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      await service.list(admin, { kycStatus: 'PARKED' });

      const where = mockPrisma.outlet.findMany.mock.calls[2][0].where;
      expect(where.AND[0]).toMatchObject({ clientId: TENANT_A, deletedAt: null });
      expect(where.AND[1]).toEqual({ kycIntent: 'PARKED' });
    });

    it('kycStatus=NOT_STARTED EXCLUDES PARKED outlets via a null-safe OR-wrap (keeps null-kycIntent pending outlets)', async () => {
      // A pending PARKED outlet has partnerId:null, which would otherwise match the
      // NOT_STARTED `{ partnerId: null }` branch. The bucket must AND-in a null-safe
      // NOT-PARKED guard so PARKED never leaks into NOT_STARTED (but null/NOT_INTERESTED stay).
      mockPrisma.outlet.findMany
        .mockResolvedValueOnce([]) // (a) owned partners
        .mockResolvedValueOnce([]) // (b) reKyc candidates
        .mockResolvedValueOnce([]); // paginated page
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      await service.list(admin, { kycStatus: 'NOT_STARTED' });

      const bucket = mockPrisma.outlet.findMany.mock.calls[2][0].where.AND[1];
      expect(bucket.AND).toEqual(
        expect.arrayContaining([
          { OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' } }] },
        ]),
      );
    });
  });

  describe('list — owner-group fields + parentId filter', () => {
    it('projects parentId/parentCode/parentBusinessName from the OutletParent relation', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'OUT-1',
          name: 'Verma Traders',
          outletTypeId: 'type1',
          city: 'Mumbai',
          state: 'MH',
          isActive: true,
          createdAt: new Date('2026-05-01T09:00:00Z'),
          distributorCode: 'DIST-01',
          beat: 'Andheri',
          metro: null,
          programName: null,
          programCategory: null,
          partnerId: null,
          reKycFlags: null,
          kycIntent: null,
          parentId: 'parent1',
          parent: { partnerCode: 'CPP01', businessName: 'Verma Group' },
          salesAssignments: [],
        },
      ]);
      const res = await service.list(admin);
      expect(res.outlets[0]).toMatchObject({
        outletId: 'OUT-1',
        parentId: 'parent1',
        parentCode: 'CPP01',
        parentBusinessName: 'Verma Group',
      });
      // The projection pulls the parent relation.
      expect(mockPrisma.outlet.findMany.mock.calls[0][0].select.parent).toEqual({
        select: { partnerCode: true, businessName: true },
      });
    });

    it('nulls the grouping fields for an ungrouped outlet (no parent relation)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'OUT-2',
          name: 'Solo Store',
          outletTypeId: 'type1',
          city: 'Pune',
          state: 'MH',
          isActive: true,
          createdAt: new Date('2026-05-01T09:00:00Z'),
          distributorCode: null,
          beat: null,
          metro: null,
          programName: null,
          programCategory: null,
          partnerId: null,
          reKycFlags: null,
          kycIntent: null,
          parentId: null,
          parent: null,
          salesAssignments: [],
        },
      ]);
      const res = await service.list(admin);
      expect(res.outlets[0]).toMatchObject({ parentId: null, parentCode: null, parentBusinessName: null });
    });

    it('?parentId narrows the where (and the parallel count) to that group; exact-match on the FK', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.outlet.count.mockResolvedValue(0);
      await service.list(admin, { parentId: 'parent1' });
      const findWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      const countWhere = mockPrisma.outlet.count.mock.calls[0][0].where;
      expect(findWhere).toMatchObject({ clientId: TENANT_A, deletedAt: null, parentId: 'parent1' });
      expect(countWhere).toEqual(findWhere); // pagination stays over the filtered set
    });

    it('an ABSENT parentId query leaves the where without a parentId key (unchanged behaviour)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await service.list(admin, {});
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.parentId).toBeUndefined();
    });
  });

  describe('listIds', () => {
    it('returns the FULL tenant list UNPAGINATED, scoped by clientId + deletedAt null, projected to the 3 FE fields', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'OUT-1', isActive: true, partnerId: null, reKycFlags: null, kycIntent: null },
        { outletCode: 'OUT-2', isActive: false, partnerId: null, reKycFlags: null, kycIntent: null },
      ]);
      const res = await service.listIds(admin);

      // (a) only the caller's clientId rows + deletedAt null, no skip/take (unpaginated).
      const args = mockPrisma.outlet.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ deletedAt: null, clientId: TENANT_A });
      expect(args.skip).toBeUndefined();
      expect(args.take).toBeUndefined();
      // (b) projection is ONLY the fields the derivation + FE need.
      expect(args.select).toEqual({
        outletCode: true,
        isActive: true,
        partnerId: true,
        reKycFlags: true,
        kycIntent: true,
      });
      // Response maps outletCode→outletId and carries only the 3 consumed fields.
      expect(res.outlets).toEqual([
        { outletId: 'OUT-1', isActive: true, kycStatus: 'NOT_STARTED' },
        { outletId: 'OUT-2', isActive: false, kycStatus: 'NOT_STARTED' },
      ]);
    });

    it('derives RE_KYC_REQUIRED for a bulk-reKyc\'d outlet (reKycFlags set even though the submission is APPROVED)', async () => {
      // The admin re-KYC upload writes a non-empty reKycFlags WITHOUT flipping the
      // latest submission (still APPROVED). deriveKycStatus priority 1 must win.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'OUT-RE', isActive: true, partnerId: 'cp1', reKycFlags: { ownerPhoto: true }, kycIntent: null },
      ]);
      mockPrisma.kycSubmission.findMany.mockResolvedValue([{ partnerId: 'cp1', status: 'APPROVED' }]);

      const res = await service.listIds(admin);
      expect(res.outlets[0]).toEqual({ outletId: 'OUT-RE', isActive: true, kycStatus: 'RE_KYC_REQUIRED' });
      // Latest-submission lookup is scoped to the owned partnerIds only.
      expect(mockPrisma.kycSubmission.findMany.mock.calls[0][0].where).toEqual({ partnerId: { in: ['cp1'] } });
    });

    it('derives APPROVED from the latest submission when no reKycFlags are set', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'OUT-OK', isActive: true, partnerId: 'cp2', reKycFlags: null, kycIntent: null },
      ]);
      mockPrisma.kycSubmission.findMany.mockResolvedValue([{ partnerId: 'cp2', status: 'APPROVED' }]);

      const res = await service.listIds(admin);
      expect(res.outlets[0].kycStatus).toBe('APPROVED');
    });

    it('skips the submission lookup entirely when no outlet has a partner', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'OUT-1', isActive: true, partnerId: null, reKycFlags: null, kycIntent: null },
      ]);
      await service.listIds(admin);
      expect(mockPrisma.kycSubmission.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listParked', () => {
    it('filters by kycIntent PARKED + clientId + deletedAt null, ordered by outletCode', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await service.listParked(admin);

      const args = mockPrisma.outlet.findMany.mock.calls[0][0];
      // (a) tenant-scoped to the PARKED, non-deleted rows only — never cross-tenant.
      expect(args.where).toEqual({
        clientId: TENANT_A,
        deletedAt: null,
        kycIntent: 'PARKED',
      });
      // Projection is only the fields the FE export consumes; ordered for a stable download.
      expect(args.select).toEqual({ outletCode: true, name: true, city: true });
      expect(args.orderBy).toEqual({ outletCode: 'asc' });
    });

    it('maps outletCode→outletId and carries name + city', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'OUT-1', name: 'Alpha Store', city: 'Pune' },
        { outletCode: 'OUT-2', name: 'Beta Store', city: 'Mumbai' },
      ]);
      const res = await service.listParked(admin);
      expect(res.outlets).toEqual([
        { outletId: 'OUT-1', name: 'Alpha Store', city: 'Pune' },
        { outletId: 'OUT-2', name: 'Beta Store', city: 'Mumbai' },
      ]);
    });

    it('coerces null name/city to empty strings', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'OUT-3', name: null, city: null },
      ]);
      const res = await service.listParked(admin);
      expect(res.outlets[0]).toEqual({ outletId: 'OUT-3', name: '', city: '' });
    });
  });

  describe('upsert', () => {
    it('marks a row ERROR when the outlet type is not enabled for the tenant', async () => {
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]); // no enabled types
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '' }],
      });
      expect(res.created).toBe(0);
      expect(res.updated).toBe(0);
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors[0]).toContain('Unknown outlet type');
    });

    it('marks a row ERROR when the XSR is not found (hierarchy not built)', async () => {
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { id: 'type1', code: 'SSS', isActive: true } },
      ]);
      mockPrisma.salesUser.findUnique.mockResolvedValue(null);
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: 'ISR-X' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors[0]).toContain('not found');
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('creates a new outlet (PENDING) scoped on (clientId, outletCode) and tags the XSR', async () => {
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { id: 'type1', code: 'SSS', isActive: true } },
      ]);
      mockPrisma.salesUser.findUnique.mockResolvedValue({ id: 'su1' });
      mockTx.outlet.findUnique.mockResolvedValue(null); // not existing → CREATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', outletName: 'Verma', city: 'Mumbai', state: 'MH', xsrId: 'ISR-1' }],
      });

      expect(res.created).toBe(1);
      expect(res.rows[0].action).toBe('CREATE');
      const upsertArgs = mockTx.outlet.upsert.mock.calls[0][0];
      expect(upsertArgs.where).toEqual({ clientId_outletCode: { clientId: TENANT_A, outletCode: 'OUT-1' } });
      expect(upsertArgs.create).toMatchObject({ clientId: TENANT_A, outletCode: 'OUT-1', isActive: false, outletTypeId: 'type1' });
      // XSR re-tag: close old assignment, create the new one.
      expect(mockTx.salesUserAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { outletId: 'o1', unassignedAt: null } }),
      );
      expect(mockTx.salesUserAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ salesUserId: 'su1', outletId: 'o1' }) }),
      );
    });

    it('reports UPDATE for an already-existing outlet', async () => {
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { id: 'type1', code: 'SSS', isActive: true } },
      ]);
      mockTx.outlet.findUnique.mockResolvedValue({ id: 'o1' }); // existing → UPDATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '' }],
      });
      expect(res.updated).toBe(1);
      expect(res.rows[0].action).toBe('UPDATE');
    });

    it('REACTIVATES a previously-deactivated outlet on re-upload (isActive→true, deactivatedAt cleared)', async () => {
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { id: 'type1', code: 'SSS', isActive: true } },
      ]);
      // existing, INACTIVE, and was genuinely DEACTIVATED (deactivatedAt set).
      mockTx.outlet.findUnique.mockResolvedValue({ id: 'o1', isActive: false, deactivatedAt: new Date('2026-06-20') });
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '' }],
      });
      expect(res.rows[0].action).toBe('REACTIVATE');
      expect(res.reactivated).toBe(1);
      const upsertArgs = mockTx.outlet.upsert.mock.calls[0][0];
      expect(upsertArgs.update).toMatchObject({ isActive: true, deactivatedAt: null });
    });

    it('does NOT activate a still-PENDING outlet on re-upload (KYC approval owns activation)', async () => {
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { id: 'type1', code: 'SSS', isActive: true } },
      ]);
      // existing, INACTIVE, but NEVER deactivated (deactivatedAt null) → pending KYC.
      mockTx.outlet.findUnique.mockResolvedValue({ id: 'o1', isActive: false, deactivatedAt: null });
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '' }],
      });
      expect(res.rows[0].action).toBe('UPDATE');
      expect(res.reactivated).toBe(0);
      const upsertArgs = mockTx.outlet.upsert.mock.calls[0][0];
      expect(upsertArgs.update.isActive).toBeUndefined(); // isActive left untouched
    });
  });

  describe('upsert — Payout Method (per-outlet payout mandate)', () => {
    const enableType = () =>
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { id: 'type1', code: 'SSS', isActive: true } },
      ]);

    it('CREATE with a blank Payout Method defaults requiredPaymentType to BANK', async () => {
      enableType();
      mockPrisma.salesUser.findUnique.mockResolvedValue({ id: 'su1' });
      mockTx.outlet.findUnique.mockResolvedValue(null); // CREATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: 'ISR-1', payoutMethod: '' }],
      });
      expect(mockTx.outlet.upsert.mock.calls[0][0].create.requiredPaymentType).toBe('BANK');
    });

    it('CREATE parses the Payout Method case-insensitively ("any" → ANY)', async () => {
      enableType();
      mockTx.outlet.findUnique.mockResolvedValue(null);
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', payoutMethod: 'any' }],
      });
      expect(mockTx.outlet.upsert.mock.calls[0][0].create.requiredPaymentType).toBe('ANY');
    });

    it('marks a row ERROR (and does NOT upsert) for an invalid Payout Method value', async () => {
      enableType();
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', payoutMethod: 'CASH' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/Invalid Payout Method/i);
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('REJECTS a UPI Payout Method when the tenant has UPI disabled (authoritative guard)', async () => {
      enableType();
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({ salesApp: { upiEnabled: false } });
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', payoutMethod: 'UPI' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/UPI is disabled for this tenant/i);
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('ACCEPTS a UPI Payout Method when the tenant has UPI enabled', async () => {
      enableType();
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({ salesApp: { upiEnabled: true } });
      mockTx.outlet.findUnique.mockResolvedValue(null);
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', payoutMethod: 'UPI' }],
      });
      expect(res.rows[0].status).toBe('OK');
      expect(mockTx.outlet.upsert.mock.calls[0][0].create.requiredPaymentType).toBe('UPI');
    });

    it('UPDATE with a blank Payout Method does NOT overwrite an existing mandate', async () => {
      enableType();
      mockTx.outlet.findUnique.mockResolvedValue({ id: 'o1' }); // existing → UPDATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', payoutMethod: '' }],
      });
      expect(mockTx.outlet.upsert.mock.calls[0][0].update.requiredPaymentType).toBeUndefined();
    });

    it('UPDATE with a non-blank Payout Method overwrites the mandate', async () => {
      enableType();
      mockTx.outlet.findUnique.mockResolvedValue({ id: 'o1' });
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', payoutMethod: 'BANK' }],
      });
      expect(mockTx.outlet.upsert.mock.calls[0][0].update.requiredPaymentType).toBe('BANK');
    });
  });

  describe('upsert — Parent ID (owner groups)', () => {
    const enableType = () =>
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletType: { id: 'type1', code: 'SSS', isActive: true } },
      ]);

    it('an ABSENT Parent ID column leaves grouping untouched (no parent preload, no parentId write)', async () => {
      enableType();
      mockPrisma.salesUser.findUnique.mockResolvedValue({ id: 'su1' });
      mockTx.outlet.findUnique.mockResolvedValue(null); // CREATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      // Row carries NO parentId key at all.
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: 'ISR-1' }],
      });

      expect(res.rows[0].status).toBe('OK');
      // No owner-group work happened (the footgun-avoidance: a re-upload without the column
      // never un-groups anything).
      expect(mockPrisma.channelPartner.findMany).not.toHaveBeenCalled();
      expect(mockTx.outlet.upsert.mock.calls[0][0].create.parentId).toBeUndefined();
    });

    it('links an outlet to an existing parent by partnerCode → writes Outlet.parentId', async () => {
      enableType();
      mockPrisma.salesUser.findUnique.mockResolvedValue({ id: 'su1' });
      // parent preload: CPP01 is a real parent
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { partnerCode: 'CPP01', id: 'parent1', isParent: true },
      ]);
      // existing-outlets preload: OUT-1 is brand new (pre-KYC) → no owner → passes trivially
      mockPrisma.outlet.findMany.mockResolvedValueOnce([]);
      mockTx.outlet.findUnique.mockResolvedValue(null); // CREATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: 'ISR-1', parentId: 'CPP01' }],
      });

      expect(res.rows[0].status).toBe('OK');
      expect(mockTx.outlet.upsert.mock.calls[0][0].create.parentId).toBe('parent1');
    });

    it('ERRORs when the Parent ID does not resolve to a partner', async () => {
      enableType();
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([]); // no such parent
      mockPrisma.outlet.findMany.mockResolvedValueOnce([]);
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', parentId: 'CPPX' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/not found/i);
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('ERRORs when the Parent ID resolves to a non-parent partner', async () => {
      enableType();
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { partnerCode: 'CP001', id: 'cp1', isParent: false },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValueOnce([]);
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', parentId: 'CP001' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/not a parent owner/i);
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('add-to-parent BLOCKS a PAN mismatch (approved outlet whose PAN ≠ the group PAN)', async () => {
      enableType();
      // parent preload (batched, on prisma)
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { partnerCode: 'CPP01', id: 'parent1', isParent: true },
      ]);
      // Existing APPROVED outlet with an owner whose PAN differs from the group PAN.
      mockPrisma.outlet.findMany.mockResolvedValueOnce([
        {
          id: 'o1',
          outletCode: 'OUT-1',
          partner: { id: 'cp1', panNumber: 'MISMATCH1Z', gstNumber: null, bankAccountNumber: null, upiId: null },
        },
      ]);
      // The uniqueness check now runs INSIDE the tx: resolveGroupPan reads the parent's PAN on tx.
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({ panNumber: 'GROUPPAN99Z' });

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', parentId: 'CPP01' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/re-kyc|PAN/i);
      // The advisory lock was taken BEFORE the check (race-proofing), and no link was written.
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('add-to-parent BLOCKS a field colliding with an outlet OUTSIDE the group (GST)', async () => {
      enableType();
      // (1) parent preload — batched on prisma
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { partnerCode: 'CPP01', id: 'parent1', isParent: true },
      ]);
      // (2) GST clash search inside checkGroupUniqueness → runs on the tx client now.
      mockTx.channelPartner.findMany.mockResolvedValueOnce([{ id: 'other', outlets: [{ parentId: null }] }]);
      // Existing outlet: owner has a GST but NO PAN (so the PAN check is a no-op).
      mockPrisma.outlet.findMany.mockResolvedValueOnce([
        {
          id: 'o1',
          outletCode: 'OUT-1',
          partner: { id: 'cp1', panNumber: null, gstNumber: 'GSTDUP123', bankAccountNumber: null, upiId: null },
        },
      ]);

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', parentId: 'CPP01' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/outside this group/i);
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('add-to-parent acquires the advisory LOCK before the uniqueness check, then links on pass', async () => {
      enableType();
      mockPrisma.salesUser.findUnique.mockResolvedValue({ id: 'su1' });
      // parent preload
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { partnerCode: 'CPP01', id: 'parent1', isParent: true },
      ]);
      // Existing outlet whose PAN already equals the group PAN → clean fit → link allowed.
      mockPrisma.outlet.findMany.mockResolvedValueOnce([
        {
          id: 'o1',
          outletCode: 'OUT-1',
          partner: { id: 'cp1', panNumber: 'GROUPPAN99Z', gstNumber: null, bankAccountNumber: null, upiId: null },
        },
      ]);
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({ panNumber: 'GROUPPAN99Z' }); // group PAN matches
      const execOrder: string[] = [];
      mockTx.$executeRaw.mockImplementation(async () => {
        execOrder.push('lock');
        return 1;
      });
      mockTx.channelPartner.findMany.mockImplementation(async () => {
        execOrder.push('check');
        return [];
      });
      mockTx.outlet.findUnique.mockResolvedValue(null); // CREATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: 'ISR-1', parentId: 'CPP01' }],
      });

      expect(res.rows[0].status).toBe('OK');
      // The lock ($executeRaw) is taken BEFORE any clash-search read runs.
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      if (execOrder.includes('check')) expect(execOrder.indexOf('lock')).toBeLessThan(execOrder.indexOf('check'));
      // On a clean fit the link is written.
      expect(mockTx.outlet.upsert.mock.calls[0][0].create.parentId).toBe('parent1');
    });

    it('BLOCKS a re-link A→B: an outlet already grouped under a DIFFERENT parent is NOT moved by upload (§4.5)', async () => {
      enableType();
      // Target parent B resolves fine.
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { partnerCode: 'CPP-B', id: 'parentB', isParent: true },
      ]);
      // The existing outlet is ALREADY grouped under parent A.
      mockPrisma.outlet.findMany.mockResolvedValueOnce([
        {
          id: 'o1',
          outletCode: 'OUT-1',
          parentId: 'parentA',
          partner: { id: 'cp1', panNumber: 'GROUPPAN99Z', gstNumber: null, bankAccountNumber: null, upiId: null },
        },
      ]);

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', parentId: 'CPP-B' }],
      });

      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/already grouped under another parent/i);
      // A bulk move between groups is refused BEFORE any lock/check/write — un-grouping is a
      // dedicated action only.
      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });

    it('ALLOWS re-affirming the SAME parent (already grouped under it) → still links, no error', async () => {
      enableType();
      mockPrisma.salesUser.findUnique.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { partnerCode: 'CPP01', id: 'parent1', isParent: true },
      ]);
      // Already grouped under the SAME parent (parent1) → re-affirm is a no-op pass, not a move.
      mockPrisma.outlet.findMany.mockResolvedValueOnce([
        {
          id: 'o1',
          outletCode: 'OUT-1',
          parentId: 'parent1',
          partner: { id: 'cp1', panNumber: 'GROUPPAN99Z', gstNumber: null, bankAccountNumber: null, upiId: null },
        },
      ]);
      mockTx.channelPartner.findUnique.mockResolvedValueOnce({ panNumber: 'GROUPPAN99Z' }); // group PAN matches
      mockTx.outlet.findUnique.mockResolvedValue({ id: 'o1' }); // existing → UPDATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: 'ISR-1', parentId: 'CPP01' }],
      });

      expect(res.rows[0].status).toBe('OK');
      expect(mockTx.outlet.upsert.mock.calls[0][0].update.parentId).toBe('parent1');
    });

    it('a PRESENT-but-BLANK Parent ID cell is a NO-OP (never un-groups; no preload, no parentId write)', async () => {
      enableType();
      mockTx.outlet.findUnique.mockResolvedValue({ id: 'o1' }); // existing → UPDATE
      mockTx.outlet.upsert.mockResolvedValue({ id: 'o1' });

      // A grouped outlet is re-uploaded with an EMPTY Parent ID cell — un-grouping must NOT happen
      // here (that is the dedicated ungroupOutlet action only).
      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', parentId: '' }],
      });

      expect(res.rows[0].status).toBe('OK');
      expect(res.rows[0].action).toBe('UPDATE');
      // No owner-group work at all: a blank cell is not a link row, so nothing is preloaded and
      // parentId is left untouched (undefined = no change).
      expect(mockPrisma.channelPartner.findMany).not.toHaveBeenCalled();
      expect(mockTx.outlet.upsert.mock.calls[0][0].update.parentId).toBeUndefined();
    });

    it('a SOFT-DELETED parent is not a valid link target — the preload filters deletedAt:null (F8)', async () => {
      enableType();
      // The parent-preload query returns nothing (a soft-deleted parent is filtered out by the
      // deletedAt:null WHERE), so the code resolves "Parent ID not found".
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([]);
      mockPrisma.outlet.findMany.mockResolvedValueOnce([]);

      const res = await service.upsert(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', outletType: 'SSS', xsrId: '', parentId: 'CPP01' }],
      });

      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors.join(' ')).toMatch(/not found/i);
      // The preload WHERE carries the soft-delete guard.
      expect(mockPrisma.channelPartner.findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null });
      expect(mockTx.outlet.upsert).not.toHaveBeenCalled();
    });
  });

  describe('ungroupOutlet — dedicated explicit un-group (§4.5)', () => {
    it('BLOCKS un-group while the child still shares a detail (shared PAN) → 400, no parentId clear', async () => {
      // outlet lookup: grouped under parent1, owner shares the group PAN
      mockPrisma.outlet.findFirst.mockResolvedValue({
        id: 'o1',
        parentId: 'parent1',
        partner: { id: 'cp1', phone: null, panNumber: 'GROUPPAN99Z', gstNumber: null, bankAccountNumber: null, upiId: null },
      });
      // parent (group member) shares the same PAN
      mockPrisma.channelPartner.findUnique.mockResolvedValue({
        phone: null, panNumber: 'GROUPPAN99Z', gstNumber: null, bankAccountNumber: null, upiId: null,
      });
      mockPrisma.outlet.findMany.mockResolvedValue([]); // no siblings

      await expect(service.ungroupOutlet(admin, 'OUT-1')).rejects.toBeInstanceOf(BadRequestException);
      // parentId was NOT cleared (no update ran).
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
    });

    it('BLOCKS un-group while the child shares a PHONE with the group (last-10 match, F4)', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue({
        id: 'o1',
        parentId: 'parent1',
        // distinct PAN, but the phone matches the parent's (different formatting).
        partner: { id: 'cp1', phone: '+91 98300-11252', panNumber: 'CHILDPAN01Z', gstNumber: null, bankAccountNumber: null, upiId: null },
      });
      mockPrisma.channelPartner.findUnique.mockResolvedValue({
        phone: '9830011252', panNumber: 'PARENTPAN9Z', gstNumber: null, bankAccountNumber: null, upiId: null,
      });
      mockPrisma.outlet.findMany.mockResolvedValue([]); // no siblings

      await expect(service.ungroupOutlet(admin, 'OUT-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
    });

    it('UN-GROUPS when fully distinct → clears Outlet.parentId (trigger clears groupId) + writes audit', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue({
        id: 'o1',
        parentId: 'parent1',
        partner: { id: 'cp1', phone: '9000000001', panNumber: 'CHILDPAN01Z', gstNumber: null, bankAccountNumber: null, upiId: null },
      });
      // parent shares nothing (different PAN + phone)
      mockPrisma.channelPartner.findUnique.mockResolvedValue({
        phone: '9000000009', panNumber: 'PARENTPAN9Z', gstNumber: null, bankAccountNumber: null, upiId: null,
      });
      mockPrisma.outlet.findMany.mockResolvedValue([]); // no siblings
      mockTx.outlet.update.mockResolvedValue({ id: 'o1' });

      const res = await service.ungroupOutlet(admin, 'OUT-1');

      expect(res).toMatchObject({ outletCode: 'OUT-1', ungrouped: true });
      // Clears ONLY parentId (the trigger owns groupId — we never write it).
      expect(mockTx.outlet.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'o1' }, data: { parentId: null } }),
      );
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });

    it('is idempotent for an already-ungrouped outlet (parentId null) → no update, no error', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue({ id: 'o1', parentId: null, partner: null });
      const res = await service.ungroupOutlet(admin, 'OUT-1');
      expect(res).toMatchObject({ ungrouped: false, alreadyUngrouped: true });
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
    });

    it('DETECTS a CASE-VARIANT share (child PAN lower-case vs group PAN upper-case) → BLOCKS un-group', async () => {
      // Canonical PAN is upper-cased; a trim-only compare would miss this share and wrongly allow
      // the un-group. The normalized compare catches it.
      mockPrisma.outlet.findFirst.mockResolvedValue({
        id: 'o1',
        parentId: 'parent1',
        partner: { id: 'cp1', phone: null, panNumber: 'grouppan99z', gstNumber: null, bankAccountNumber: null, upiId: null },
      });
      mockPrisma.channelPartner.findUnique.mockResolvedValue({
        phone: null, panNumber: 'GROUPPAN99Z', gstNumber: null, bankAccountNumber: null, upiId: null,
      });
      mockPrisma.outlet.findMany.mockResolvedValue([]); // no siblings

      await expect(service.ungroupOutlet(admin, 'OUT-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.outlet.update).not.toHaveBeenCalled();
    });

    it("excludes the child's OWN partner from the sibling scan (a partner owning 2 group outlets must not self-block)", async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue({
        id: 'o1',
        parentId: 'parent1',
        partner: { id: 'cp1', phone: '9000000001', panNumber: 'CHILDPAN01Z', gstNumber: null, bankAccountNumber: null, upiId: null },
      });
      // parent shares nothing.
      mockPrisma.channelPartner.findUnique.mockResolvedValue({
        phone: '9000000009', panNumber: 'PARENTPAN9Z', gstNumber: null, bankAccountNumber: null, upiId: null,
      });
      mockPrisma.outlet.findMany.mockResolvedValue([]); // the child's own 2nd outlet is filtered out by the query
      mockTx.outlet.update.mockResolvedValue({ id: 'o1' });

      const res = await service.ungroupOutlet(admin, 'OUT-1');

      expect(res).toMatchObject({ ungrouped: true });
      // The sibling scan excludes BOTH the child outlet AND the child's own partner.
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.id).toEqual({ not: 'o1' });
      expect(where.partner).toMatchObject({ id: { not: 'cp1' } });
    });

    it('throws NotFound for an unknown / cross-tenant outlet (scoped by clientId + deletedAt:null)', async () => {
      mockPrisma.outlet.findFirst.mockResolvedValue(null);
      await expect(service.ungroupOutlet(admin, 'OUT-X')).rejects.toBeInstanceOf(NotFoundException);
      const where = mockPrisma.outlet.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ clientId: TENANT_A, outletCode: 'OUT-X', deletedAt: null });
    });
  });

  describe('rekycFlag', () => {
    it('FLAGS an existing outlet and writes only reKycFlags', async () => {
      mockPrisma.outlet.findUnique.mockResolvedValue({ id: 'o1' });
      const res = await service.rekycFlag(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', ownerPhoto: 'Yes', remarks: 'owner changed' }],
      });
      expect(res.flagged).toBe(1);
      expect(res.cleared).toBe(0);
      const updateArgs = mockPrisma.outlet.update.mock.calls[0][0];
      expect(updateArgs.where).toEqual({ clientId_outletCode: { clientId: TENANT_A, outletCode: 'OUT-1' } });
      expect(Object.keys(updateArgs.data)).toEqual(['reKycFlags']);
      expect(updateArgs.data.reKycFlags.ownerPhoto).toBe(true);
    });

    it('CLEARS to DbNull when no field is flagged Yes', async () => {
      mockPrisma.outlet.findUnique.mockResolvedValue({ id: 'o1' });
      const res = await service.rekycFlag(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-1', remarks: 'nothing' }],
      });
      expect(res.cleared).toBe(1);
      expect(mockPrisma.outlet.update.mock.calls[0][0].data.reKycFlags).toBe(Prisma.DbNull);
    });

    it('marks a row ERROR when the outlet is not in the tenant', async () => {
      mockPrisma.outlet.findUnique.mockResolvedValue(null);
      const res = await service.rekycFlag(admin, {
        rows: [{ rowNum: 2, outletId: 'OUT-MISSING', ownerPhoto: 'Yes' }],
      });
      expect(res.rows[0].status).toBe('ERROR');
      expect(res.rows[0].errors[0]).toContain('not found');
      expect(mockPrisma.outlet.update).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle — direct clientId scoping (closes the ownerless-outlet hole)', () => {
    it('deactivate scopes by clientId directly and closes open assignments', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      const res = await service.deactivate(admin, { outletCodes: ['OUT-1'] });
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe(TENANT_A);
      expect(where.partner).toBeUndefined();
      expect(res.deactivated).toBe(1);
      expect(mockTx.outlet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['o1'] } } }),
      );
      expect(mockTx.salesUserAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ outletId: { in: ['o1'] }, unassignedAt: null }) }),
      );
    });

    it('deactivate returns { deactivated: 0, notFound } (benign no-op, not a throw) when no active outlets match', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const res = await service.deactivate(admin, { outletCodes: ['OUT-X'] });
      expect(res.deactivated).toBe(0);
      expect(res.notFound).toEqual(['OUT-X']);
      // No transaction/write runs on the zero-match path.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('revokes the live sessions of a partner whose LAST active outlet is deactivated', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      mockTx.outlet.findMany.mockResolvedValue([{ partnerId: 'cp1' }]);       // deactivated outlet belongs to cp1
      mockTx.outlet.groupBy.mockResolvedValue([]);                            // cp1 has NO remaining active outlet
      mockTx.channelPartner.findMany.mockResolvedValue([{ userId: 'u1' }]);
      mockTx.user.updateMany.mockResolvedValue({ count: 1 });
      mockTx.userSession.updateMany.mockResolvedValue({ count: 1 });

      await service.deactivate(admin, { outletCodes: ['OUT-1'] });

      expect(mockTx.channelPartner.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['cp1'] } } }),
      );
      expect(mockTx.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: { in: ['u1'] }, revokedAt: null } }),
      );
      // AUTHORITATIVE (1b): stranded owners are STAMPED (before the revoke) so a concurrent
      // refresh can't mint a surviving successor of the deactivated outlet's owner.
      expect(mockTx.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['u1'] } }, data: { sessionsInvalidBefore: expect.any(Date) } }),
      );
      // STAMP-BEFORE-REVOKE (Fix 2).
      expect(mockTx.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockTx.userSession.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('does NOT revoke sessions when the partner still has another active outlet', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      mockTx.outlet.findMany.mockResolvedValue([{ partnerId: 'cp1' }]);
      mockTx.outlet.groupBy.mockResolvedValue([{ partnerId: 'cp1' }]);        // cp1 STILL has an active outlet
      mockTx.userSession.updateMany.mockResolvedValue({ count: 0 });

      await service.deactivate(admin, { outletCodes: ['OUT-1'] });

      expect(mockTx.channelPartner.findMany).not.toHaveBeenCalled();
      expect(mockTx.userSession.updateMany).not.toHaveBeenCalled();
    });

    it('reactivate scopes by clientId + isActive false + deactivatedAt!=null and flips them active', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      const res = await service.reactivate(admin, { outletCodes: ['OUT-1'] });
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ clientId: TENANT_A, isActive: false, deletedAt: null });
      // SECURITY GUARD: only GENUINELY-DEACTIVATED outlets (deactivatedAt set) are
      // eligible — a never-approved KYC-PENDING outlet (deactivatedAt null) must be
      // excluded so reactivate cannot bypass the KYC-approval activation gate.
      expect(where.deactivatedAt).toEqual({ not: null });
      expect(res.reactivated).toBe(1);
      expect(mockPrisma.outlet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['o1'] } }, data: expect.objectContaining({ isActive: true }) }),
      );
      // Re-opening for enrollment also clears the not-interested intent.
      expect(mockPrisma.outlet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kycIntent: null, kycIntentBy: null, kycIntentAt: null }),
        }),
      );
    });

    it('reactivate REFUSES to activate a KYC-pending outlet (deactivatedAt null → no match → BadRequest, no write)', async () => {
      // The pending outlet never matches the deactivatedAt!=null filter, so findMany
      // returns [] and reactivate throws WITHOUT writing — proving a never-approved
      // outlet cannot be flipped active through this endpoint.
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await expect(service.reactivate(admin, { outletCodes: ['PENDING-1'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.outlet.updateMany).not.toHaveBeenCalled();
    });

    it('bulk-delete matches an ownerless (partnerId null) outlet via outlet.clientId and writes an audit log', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o_ownerless' }]);
      const res = await service.bulkDelete(admin, { outletIds: ['o_ownerless'] });
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe(TENANT_A);
      expect(where.partner).toBeUndefined();
      expect(res.deleted).toBe(1);
      expect(mockTx.outlet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['o_ownerless'] } }, data: expect.objectContaining({ deletedAt: expect.any(Date), isActive: false }) }),
      );
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });

    it('bulk-delete throws when no active outlets match', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await expect(service.bulkDelete(admin, { outletIds: ['nope'] })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('park — hide KYC-pending outlets from reps (reversible)', () => {
    it('sets kycIntent=PARKED (+ by/at) on matching pending outlets, scoped to the tenant, returning counts + notFound', async () => {
      // Only OUT-1 is a pending (isActive:false) outlet in the tenant; OUT-X never matches.
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      const res = await service.park(admin, { outletCodes: ['OUT-1', 'OUT-X'] });

      // Match: TRUE KYC-pending only — isActive:false AND deactivatedAt:null (never-deactivated),
      // non-deleted, tenant-scoped, by outletCode. deactivatedAt:null keeps Park out of the
      // deactivate/reactivate lifecycle (a genuinely-deactivated outlet is not parkable here).
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).toEqual({
        outletCode: { in: ['OUT-1', 'OUT-X'] },
        clientId: TENANT_A,
        deletedAt: null,
        isActive: false,
        deactivatedAt: null,
        // Idempotency: already-PARKED outlets are skipped (null-safe OR-wrap).
        OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' } }],
      });
      // Writes the PARKED intent stamp (by the actor, timestamped).
      const upd = mockPrisma.outlet.updateMany.mock.calls[0][0];
      expect(upd.where).toEqual({ id: { in: ['o1'] } });
      expect(upd.data).toMatchObject({ kycIntent: 'PARKED', kycIntentBy: 'actor1' });
      expect(upd.data.kycIntentAt).toBeInstanceOf(Date);
      // Return shape: { parked, notFound } — notFound = unmatched codes.
      expect(res).toEqual({ parked: 1, notFound: ['OUT-X'] });
    });

    it('SKIPS an approved/active outlet (isActive:true) — the isActive:false filter excludes it → zero matched, no write', async () => {
      // An active (approved) outlet never satisfies isActive:false, so findMany returns [] and park
      // returns { parked:0 } WITHOUT writing — proving Park cannot hide a live outlet (use Deactivate).
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const res = await service.park(admin, { outletCodes: ['ACTIVE-1'] });
      expect(res).toEqual({ parked: 0, notFound: ['ACTIVE-1'] });
      expect(mockPrisma.outlet.updateMany).not.toHaveBeenCalled();
    });

    it('returns { parked: 0, notFound } (a benign no-op, not a throw) when zero outlets match — so a batched upload is not aborted', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const res = await service.park(admin, { outletCodes: ['NOPE'] });
      expect(res).toEqual({ parked: 0, notFound: ['NOPE'] });
      expect(mockPrisma.outlet.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('unpark — clear the PARKED intent', () => {
    it('clears kycIntent/by/at where kycIntent=PARKED (tenant-scoped), returning { unparked, notFound }', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      const res = await service.unpark(admin, { outletCodes: ['OUT-1', 'OUT-Z'] });

      // Only currently-PARKED rows in the tenant are matched (never touches NOT_INTERESTED).
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ outletCode: { in: ['OUT-1', 'OUT-Z'] }, clientId: TENANT_A, kycIntent: 'PARKED' });
      const upd = mockPrisma.outlet.updateMany.mock.calls[0][0];
      expect(upd.where).toEqual({ id: { in: ['o1'] } });
      expect(upd.data).toEqual({ kycIntent: null, kycIntentBy: null, kycIntentAt: null });
      expect(res).toEqual({ unparked: 1, notFound: ['OUT-Z'] });
    });

    it('returns { unparked: 0, notFound } (a benign no-op, not a throw) when no parked outlets match', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const res = await service.unpark(admin, { outletCodes: ['NOPE'] });
      expect(res).toEqual({ unparked: 0, notFound: ['NOPE'] });
      expect(mockPrisma.outlet.updateMany).not.toHaveBeenCalled();
    });
  });
});

describe('deriveKycStatus — PARKED bucket', () => {
  it("returns 'PARKED' for a PARKED outlet (its own distinct display bucket, not NOT_STARTED)", () => {
    expect(deriveKycStatus(null, 'PARKED', null, new Map())).toBe('PARKED');
  });

  it("still returns 'NOT_STARTED' for a NOT_INTERESTED outlet (PARKED branch does not disturb it)", () => {
    expect(deriveKycStatus(null, 'NOT_INTERESTED', null, new Map())).toBe('NOT_STARTED');
  });
});
