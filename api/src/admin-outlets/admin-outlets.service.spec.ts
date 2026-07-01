// Unit tests for AdminOutletsService — ported from the admin/outlets Next routes.
// Covers tenant/clientId scoping (the ownerless-outlet hole the platform lifecycle
// test guards against) + the outlet-master upsert / re-KYC flag upload validation.
// Run: npx jest src/admin-outlets/admin-outlets.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminOutletsService } from './admin-outlets.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SalesNotificationsService } from '../notifications/sales-notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  outlet: { findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  salesUserAssignment: { updateMany: jest.fn(), create: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  userSession: { updateMany: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  outlet: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn() },
  salesUser: { findUnique: jest.fn() },
  salesUserAssignment: { updateMany: jest.fn() },
  kycSubmission: { findMany: jest.fn() },
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
    mockTx.outlet.groupBy.mockResolvedValue([]);
    mockTx.channelPartner.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminOutletsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
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
        // (a) reKycFlags candidates — none flagged
        .mockResolvedValueOnce([])
        // (b) distinct partnerIds for the tenant's owned outlets
        .mockResolvedValueOnce([{ partnerId: 'cp1' }, { partnerId: 'cp2' }])
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
        // (a) reKycFlags candidates: one non-empty, one empty {} (must be excluded)
        .mockResolvedValueOnce([
          { id: 'o-flagged', reKycFlags: { ownerPhoto: true } },
          { id: 'o-empty', reKycFlags: {} },
        ])
        // (b) no owned partners
        .mockResolvedValueOnce([])
        // paginated fetch
        .mockResolvedValueOnce([]);
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      await service.list(admin, { kycStatus: 'RE_KYC_REQUIRED' });

      const where = mockPrisma.outlet.findMany.mock.calls[2][0].where;
      // The bucket predicate ORs on the flagged id set — only the non-empty one.
      expect(JSON.stringify(where)).toContain('o-flagged');
      expect(JSON.stringify(where)).not.toContain('o-empty');
    });

    it('kycStatus=APPROVED excludes NOT_INTERESTED outlets (priority 2) but keeps NULL kycIntent', async () => {
      // Regression: an outlet marked NOT_INTERESTED still carries its partner + submission.
      // deriveKycStatus priority 2 makes it NOT_STARTED (ahead of the APPROVED submission
      // bucket, priority 4), so the APPROVED filter must NOT include it — else it shows under
      // the wrong tab AND double-counts the paginated total. The guard must be NULL-safe.
      mockPrisma.outlet.findMany
        .mockResolvedValueOnce([]) // (a) none reKyc-flagged
        .mockResolvedValueOnce([{ partnerId: 'cp1' }]) // (b) owned partners
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

    it('deactivate throws when no active outlets match', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      await expect(service.deactivate(admin, { outletCodes: ['OUT-X'] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('revokes the live sessions of a partner whose LAST active outlet is deactivated', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      mockTx.outlet.findMany.mockResolvedValue([{ partnerId: 'cp1' }]);       // deactivated outlet belongs to cp1
      mockTx.outlet.groupBy.mockResolvedValue([]);                            // cp1 has NO remaining active outlet
      mockTx.channelPartner.findMany.mockResolvedValue([{ userId: 'u1' }]);
      mockTx.userSession.updateMany.mockResolvedValue({ count: 1 });

      await service.deactivate(admin, { outletCodes: ['OUT-1'] });

      expect(mockTx.channelPartner.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['cp1'] } } }),
      );
      expect(mockTx.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: { in: ['u1'] }, revokedAt: null } }),
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

    it('reactivate scopes by clientId + isActive false and flips them active', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletCode: 'OUT-1' }]);
      const res = await service.reactivate(admin, { outletCodes: ['OUT-1'] });
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ clientId: TENANT_A, isActive: false, deletedAt: null });
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
});
