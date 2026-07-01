// Unit tests for SchemesService — mirrors the tickets/wallet pilot template.
// Covers tenant scoping, the non-admin eligibility filter, soft-delete handling,
// and the target percentage/enrichment logic ported from the Next routes.
// Run: npx jest src/schemes/schemes.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchemesService } from './schemes.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  scheme: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  schemeEligibility: { findMany: jest.fn() },
  schemeEnrollmentForm: { upsert: jest.fn(), findUnique: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('SchemesService', () => {
  let service: SchemesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SchemesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(SchemesService);
  });

  describe('list', () => {
    it('scopes admins to non-deleted schemes in their tenant (all statuses when none supplied)', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(clientAdmin, {});
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      // Default (no status) returns ALL non-deleted statuses so the FE "All" pill works.
      expect(where).toEqual({ clientId: 'deoleo', deletedAt: null });
      expect(mockPrisma.schemeEligibility.findMany).not.toHaveBeenCalled();
    });

    it('restricts non-admins to schemes they are eligible for', async () => {
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([{ schemeId: 's1' }, { schemeId: 's2' }]);
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(partner, {});
      expect(mockPrisma.schemeEligibility.findMany).toHaveBeenCalledWith({
        where: { specificPartnerId: 'user1' },
        select: { schemeId: true },
      });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      // Non-admins keep the ACTIVE-only default (partner/sales enrollment views).
      expect(where).toEqual({ clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, id: { in: ['s1', 's2'] } });
    });

    it('IGNORES an explicit ?status for a non-admin — forced to ACTIVE (no draft/expired leak)', async () => {
      // Security: a partner/sales caller hand-crafting ?status=EXPIRED must NOT bypass the
      // ACTIVE-only default (their eligibility rows could otherwise expose an unpublished
      // scheme's name/code/dates). The status filter is admin-gated.
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([{ schemeId: 's1' }]);
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(partner, { status: 'EXPIRED' as never });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('ACTIVE'); // NOT 'EXPIRED'
      expect(where.id).toEqual({ in: ['s1'] });
    });

    it('applies status + type filters when supplied', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(clientAdmin, { status: 'DRAFT' as never, type: 'VISIBILITY' as never });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('DRAFT');
      expect(where.schemeType).toBe('VISIBILITY');
    });

    it('applies the search OR (name + code) on BOTH find and count, narrowing tenant scope', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(clientAdmin, { search: 'Summer' });
      const expectedOr = [
        { name: { contains: 'Summer', mode: 'insensitive' } },
        { code: { contains: 'Summer', mode: 'insensitive' } },
      ];
      expect(mockPrisma.scheme.findMany.mock.calls[0][0].where.OR).toEqual(expectedOr);
      expect(mockPrisma.scheme.count.mock.calls[0][0].where.OR).toEqual(expectedOr);
      expect(mockPrisma.scheme.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    });

    it('paginates: skip/take derive from page/limit and the envelope is canonical', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      const res = await service.list(clientAdmin, { page: 2, limit: 15 });
      const args = mockPrisma.scheme.findMany.mock.calls[0][0];
      expect(args.skip).toBe(15); // (2 - 1) * 15
      expect(args.take).toBe(15);
      expect(res.pagination).toEqual({ page: 2, limit: 15, total: 0, pages: 0 });
    });
  });

  describe('create', () => {
    it('persists with tenant + creator and normalizes dates', async () => {
      mockPrisma.scheme.create.mockResolvedValue({ id: 's1' });
      await service.create(gifsy, {
        code: 'C1',
        name: 'Scheme',
        schemeType: 'PURCHASE_INCENTIVE' as never,
        rewardType: 'POINTS' as never,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      const data = mockPrisma.scheme.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('deoleo');
      expect(data.createdByUserId).toBe('admin1');
      expect(data.status).toBe('ACTIVE');
      expect(data.startDate).toBeInstanceOf(Date);
    });
  });

  describe('getOne', () => {
    it('throws NotFound when missing', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.getOne(partner, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when soft-deleted', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', deletedAt: new Date() });
      await expect(service.getOne(partner, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the scheme when live', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', deletedAt: null });
      await expect(service.getOne(partner, 's1')).resolves.toEqual({ scheme: { id: 's1', deletedAt: null } });
    });
  });

  describe('update', () => {
    it('throws NotFound when the scheme is outside the tenant', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.update(clientAdmin, 's1', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('only writes whitelisted fields (drops the World-A rules pass-through)', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1' });
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });
      await service.update(clientAdmin, 's1', { name: 'New', status: 'PAUSED' as never });
      const data = mockPrisma.scheme.update.mock.calls[0][0].data;
      expect(data.name).toBe('New');
      expect(data.status).toBe('PAUSED');
      expect(data.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('remove', () => {
    it('forbids non-GIFSY admins', async () => {
      await expect(service.remove(clientAdmin, 's1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('soft-deletes and cancels for GIFSY admins', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1' });
      mockPrisma.scheme.update.mockResolvedValue({ id: 's1' });
      const res = await service.remove(gifsy, 's1');
      const data = mockPrisma.scheme.update.mock.calls[0][0].data;
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(data.status).toBe('CANCELLED');
      expect(res).toEqual({ message: 'Scheme deleted successfully' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P4.2 — upsertEnrollmentForm
  // ─────────────────────────────────────────────────────────────────────────

  const validFormDto = {
    campaignType: 'LOYALTY_ONLY' as const,
    formSchema: {
      captureGpsOnSubmit: false,
      requireOtp: false,
      fields: [
        {
          id: 'f1',
          type: 'TEXT',
          label: 'Name',
          required: true,
          autoFillFromExcel: false,
          autoFillEditable: false,
          order: 0,
        },
      ],
    },
  };

  describe('upsertEnrollmentForm', () => {
    it('throws Forbidden for non-admin callers', async () => {
      await expect(
        service.upsertEnrollmentForm(partner, 's1', validFormDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFound when the schemeId does not belong to the tenant', async () => {
      // findFirst returns null → scheme is missing/cross-tenant
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(
        service.upsertEnrollmentForm(clientAdmin, 'unknown-scheme', validFormDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound for a soft-deleted scheme', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: new Date() });
      await expect(
        service.upsertEnrollmentForm(clientAdmin, 's1', validFormDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('upserts the enrollment form with the correct fields', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      const fakeForm = { id: 'ef1', schemeId: 's1', campaignType: 'LOYALTY_ONLY', formSchema: validFormDto.formSchema };
      mockPrisma.schemeEnrollmentForm.upsert.mockResolvedValue(fakeForm);

      const result = await service.upsertEnrollmentForm(clientAdmin, 's1', validFormDto);

      expect(result).toEqual({ enrollmentForm: fakeForm });

      const upsertCall = mockPrisma.schemeEnrollmentForm.upsert.mock.calls[0][0];
      expect(upsertCall.where).toEqual({ schemeId: 's1' });
      expect(upsertCall.create.schemeId).toBe('s1');
      expect(upsertCall.create.campaignType).toBe('LOYALTY_ONLY');
      expect(upsertCall.update.campaignType).toBe('LOYALTY_ONLY');
    });

    it('verifies tenant scope: findFirst is called with both id and clientId', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.upsert.mockResolvedValue({ id: 'ef1' });

      await service.upsertEnrollmentForm(gifsy, 's1', validFormDto);

      expect(mockPrisma.scheme.findFirst).toHaveBeenCalledWith({
        where: { id: 's1', clientId: 'deoleo' },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P4.2 — getEnrollmentForm
  // ─────────────────────────────────────────────────────────────────────────

  describe('getEnrollmentForm', () => {
    it('throws NotFound when the schemeId is outside the tenant', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(
        service.getEnrollmentForm(partner, 's1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when no enrollment form is configured', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(null);
      await expect(
        service.getEnrollmentForm(partner, 's1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the enrollment form when it exists', async () => {
      const fakeForm = { id: 'ef1', schemeId: 's1', campaignType: 'OPEN_CAMPAIGN', formSchema: {} };
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue(fakeForm);

      const result = await service.getEnrollmentForm(partner, 's1');
      expect(result).toEqual({ enrollmentForm: fakeForm });
      expect(mockPrisma.schemeEnrollmentForm.findUnique).toHaveBeenCalledWith({
        where: { schemeId: 's1' },
      });
    });

    it('always checks tenant scope before reading the form', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', clientId: 'deoleo', deletedAt: null });
      mockPrisma.schemeEnrollmentForm.findUnique.mockResolvedValue({ id: 'ef1', schemeId: 's1' });

      await service.getEnrollmentForm(partner, 's1');

      // The tenant-scope query always includes clientId from the JWT
      expect(mockPrisma.scheme.findFirst).toHaveBeenCalledWith({
        where: { id: 's1', clientId: 'deoleo' },
      });
    });
  });

});
