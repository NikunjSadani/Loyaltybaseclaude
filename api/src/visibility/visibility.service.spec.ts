// Unit tests for VisibilityService — mirrors the S4 tickets/wallet template.
// Covers tenant scoping, the GIFSY-only approve/reject transitions + audit trail,
// the partner-role block on outlet-statuses, and fraud-log pagination ported
// from the Next routes.
// Run: npx jest src/visibility/visibility.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { VisibilityService } from './visibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  visibilitySubmission: { update: jest.fn() },
  visibilityApproval: { create: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  visibilitySubmission: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
  visibilityApproval: { create: jest.fn() },
  visibilityFraudLog: { findMany: jest.fn(), count: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

// Default tenant mock — resolves to PHOTO_APPROVAL so the existing approve/reject
// tests are not blocked by the capture-mode gate.
const mockTenant = {
  resolveVisibilityCaptureMode: jest.fn().mockResolvedValue('PHOTO_APPROVAL'),
  // Master visibility switch — default ON so the existing submit/approve/reject/list
  // tests are not blocked by the master gate (the OFF→403 case is tested separately).
  resolveVisibilityEnabled: jest.fn().mockResolvedValue(true),
};

const mockStorage = {
  generateKey: jest.fn().mockReturnValue('visibility/deoleo/key.png'),
  uploadFile: jest.fn().mockResolvedValue('https://storage/visibility/deoleo/key.png'),
};

// gifsy = the cross-tenant operator. clientId 'gifsy' is intentionally NOT a real
// tenant — A1 (#38) makes GIFSY_ADMIN exempt from the caller-tenant filter, so its
// queries must NOT carry a clientId scope (it acts on the record's own tenant).
const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('VisibilityService', () => {
  let service: VisibilityService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Re-apply the default mock implementation after clearAllMocks resets it.
    mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('PHOTO_APPROVAL');
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    service = module.get(VisibilityService);
  });

  describe('listSubmissions', () => {
    it('scopes to the tenant via partner.user.clientId and applies filters', async () => {
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([]);
      mockPrisma.visibilitySubmission.count.mockResolvedValue(0);
      await service.listSubmissions(partner, { outletId: 'o1', programId: 'p1', status: 'DRAFT' as never });
      const where = mockPrisma.visibilitySubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({
        partner: { user: { clientId: 'deoleo' } },
        outletId: 'o1',
        programId: 'p1',
        status: 'DRAFT',
      });
    });

    it('paginates with defaults', async () => {
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([]);
      mockPrisma.visibilitySubmission.count.mockResolvedValue(3);
      const res = await service.listSubmissions(partner, {});
      expect(res.pagination).toEqual({ page: 1, limit: 20, total: 3, pages: 1 });
    });

    // ── Partner denylist (mirrors outletStatuses) ───────────────────────────────
    it('blocks channel-partner roles (they submit via POST /submit, not list)', async () => {
      for (const role of ['SSS', 'WHOLESALER', 'SUB_STOCKIST'] as const) {
        const p: JwtPayload = { ...partner, role };
        await expect(service.listSubmissions(p, {})).rejects.toBeInstanceOf(ForbiddenException);
      }
      // No DB query is issued for a blocked partner.
      expect(mockPrisma.visibilitySubmission.findMany).not.toHaveBeenCalled();
    });

    it('proceeds for a tenant admin (CLIENT_ADMIN)', async () => {
      const tenantAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([]);
      mockPrisma.visibilitySubmission.count.mockResolvedValue(0);
      await service.listSubmissions(tenantAdmin, {});
      expect(mockPrisma.visibilitySubmission.findMany).toHaveBeenCalled();
    });

    it('proceeds for the GIFSY cross-tenant operator', async () => {
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([]);
      mockPrisma.visibilitySubmission.count.mockResolvedValue(0);
      await service.listSubmissions(gifsy, {});
      expect(mockPrisma.visibilitySubmission.findMany).toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('throws NotFound when the submission does not exist (Gifsy is cross-tenant, #38)', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue(null);
      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(NotFoundException);
      // GIFSY_ADMIN is exempt from the caller-tenant filter — the lookup is by id only,
      // scoped by the record's OWN tenant, so the operator can reach any brand's record.
      expect(mockPrisma.visibilitySubmission.findFirst).toHaveBeenCalledWith({
        where: { id: 's1' },
      });
    });

    it('a tenant user (non-Gifsy) stays scoped to its own clientId', async () => {
      const tenantAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue(null);
      await expect(service.approve(tenantAdmin, 's1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.visibilitySubmission.findFirst).toHaveBeenCalledWith({
        where: { id: 's1', partner: { user: { clientId: 'deoleo' } } },
      });
    });

    it('rejects an already-approved submission', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue({ id: 's1', status: 'APPROVED' });
      await expect(service.approve(gifsy, 's1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approves, records the approval, and writes an audit log', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue({ id: 's1', status: 'SUBMITTED' });
      const res = await service.approve(gifsy, 's1');
      expect(res).toEqual({ message: 'Submission approved successfully' });
      expect(mockTx.visibilitySubmission.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: 'APPROVED', reviewedByUserId: 'admin1', reviewedAt: expect.any(Date) },
      });
      expect(mockTx.visibilityApproval.create).toHaveBeenCalledWith({
        data: { submissionId: 's1', reviewerUserId: 'admin1', fromStatus: 'SUBMITTED', toStatus: 'APPROVED' },
      });
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('rejects an already-rejected submission', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue({ id: 's1', status: 'REJECTED' });
      await expect(service.reject(gifsy, 's1', { reason: 'blurry' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects with a reason, records the approval row + audit log', async () => {
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue({ id: 's1', status: 'SUBMITTED' });
      const res = await service.reject(gifsy, 's1', { reason: 'blurry' });
      expect(res).toEqual({ message: 'Submission rejected successfully' });
      expect(mockTx.visibilitySubmission.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: {
          status: 'REJECTED',
          rejectionReason: 'blurry',
          reviewedByUserId: 'admin1',
          reviewedAt: expect.any(Date),
        },
      });
      expect(mockTx.visibilityApproval.create).toHaveBeenCalledWith({
        data: {
          submissionId: 's1',
          reviewerUserId: 'admin1',
          fromStatus: 'SUBMITTED',
          toStatus: 'REJECTED',
          notes: 'blurry',
        },
      });
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('outletStatuses', () => {
    it('blocks partner roles', async () => {
      const sss: JwtPayload = { ...partner, role: 'SSS' };
      await expect(service.outletStatuses(sss, { outletCodes: 'A1' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns an empty map when no outletCodes are provided', async () => {
      const res = await service.outletStatuses(partner, {});
      expect(res).toEqual({});
      expect(mockPrisma.outletVisibilityRecord.findMany).not.toHaveBeenCalled();
    });

    it('builds an outletCode→status map scoped to the tenant + month', async () => {
      mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([
        {
          outletCode: 'A1',
          status: 'APPROVED',
          dateOfCapture: new Date('2026-06-10T00:00:00.000Z'),
          approvedBy: 'admin1',
          capturedByEmployeeName: 'Rep',
        },
      ]);
      const res = await service.outletStatuses(partner, { outletCodes: 'A1, B2', month: '2026-06' });
      expect(mockPrisma.outletVisibilityRecord.findMany).toHaveBeenCalledWith({
        where: { clientId: 'deoleo', month: '2026-06', outletCode: { in: ['A1', 'B2'] } },
        select: {
          outletCode: true,
          status: true,
          dateOfCapture: true,
          approvedBy: true,
          capturedByEmployeeName: true,
        },
      });
      expect(res).toEqual({
        A1: { status: 'APPROVED', dateOfCapture: '2026-06-10', approvedBy: 'admin1', capturedByEmployeeName: 'Rep' },
      });
    });
  });

  describe('listFraudLog', () => {
    it('is cross-tenant for Gifsy (no clientId filter) and applies a date range (#38)', async () => {
      mockPrisma.visibilityFraudLog.findMany.mockResolvedValue([]);
      mockPrisma.visibilityFraudLog.count.mockResolvedValue(0);
      await service.listFraudLog(gifsy, { dateFrom: '2026-01-01', dateTo: '2026-02-01' });
      const where = mockPrisma.visibilityFraudLog.findMany.mock.calls[0][0].where;
      // fraud-log is GIFSY-only — the operator sees every brand's fraud log.
      expect(where).toEqual({
        createdAt: { gte: new Date('2026-01-01'), lte: new Date('2026-02-01') },
      });
    });

    it('paginates with defaults and no date filter (Gifsy cross-tenant)', async () => {
      mockPrisma.visibilityFraudLog.findMany.mockResolvedValue([]);
      mockPrisma.visibilityFraudLog.count.mockResolvedValue(5);
      const res = await service.listFraudLog(gifsy, {});
      const where = mockPrisma.visibilityFraudLog.findMany.mock.calls[0][0].where;
      expect(where).toEqual({});
      expect(res.pagination).toEqual({ page: 1, limit: 20, total: 5, pages: 1 });
    });
  });

  // ── Master visibility gate (visibilityEnabled) ───────────────────────────────
  describe('master visibility gate', () => {
    const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };

    it('403s a tenant user when visibility is OFF — before touching the DB', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      await expect(service.listSubmissions(clientAdmin, {})).rejects.toThrow(
        'Visibility is not enabled for this tenant.',
      );
      expect(mockPrisma.visibilitySubmission.findMany).not.toHaveBeenCalled();
    });

    it('403s a partner submit when visibility is OFF — no GCS upload, no row', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const file = { buffer: Buffer.from('x'), size: 1, mimetype: 'image/jpeg', originalname: 'a.jpg' } as Express.Multer.File;
      await expect(service.submit(partner, file, { programId: 'p1' } as never)).rejects.toThrow(
        'Visibility is not enabled for this tenant.',
      );
      // Gate throws before any GCS upload or DB write.
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('EXEMPTS the GIFSY operator even when their own tenant flag is OFF', async () => {
      // The operator approves ENABLED tenants' submissions cross-tenant; the gate must
      // never block them on the gifsy tenant's own (default-OFF) flag.
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      mockPrisma.visibilitySubmission.findFirst.mockResolvedValue(null);
      // Passes the gate (exempt) and proceeds to the DB lookup → NotFound, not Forbidden.
      await expect(service.approve(gifsy, 'sub1')).rejects.toThrow('Submission not found');
    });
  });
});
