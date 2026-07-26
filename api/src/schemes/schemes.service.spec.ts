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
  // Wave 3 enrollment threading (submitEnrollment / getMyEnrollment).
  channelPartner: { findFirst: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
  outlet: { findMany: jest.fn() },
  schemeEnrollment: { upsert: jest.fn(), findUnique: jest.fn() },
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

    it('Wave 4 opt-in: shows ALL active tenant schemes when NO eligibility rows are configured', async () => {
      // The default state (no code writes SchemeEligibility today): a partner sees every ACTIVE
      // tenant scheme — NOT an empty catalog. Regression guard for the dead-mechanism bug.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1', groupId: null });
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([]); // none configured
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(partner, {});
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', status: 'ACTIVE', deletedAt: null }); // NO id restriction
      // Eligibility is matched on BOTH the active partner id and the login user id.
      expect(mockPrisma.schemeEligibility.findMany).toHaveBeenCalledWith({
        where: { specificPartnerId: { in: ['p1', 'user1'] } },
        select: { schemeId: true },
      });
    });

    it('restricts non-admins to their eligibility rows WHEN configured (opt-in allowlist)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1', groupId: null });
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([{ schemeId: 's1' }, { schemeId: 's2' }]);
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(partner, {});
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, id: { in: ['s1', 's2'] } });
    });

    it('IGNORES an explicit ?status for a non-admin — forced to ACTIVE (no draft/expired leak)', async () => {
      // Security: a partner/sales caller hand-crafting ?status=EXPIRED must NOT bypass the ACTIVE-only default.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'p1', groupId: null });
      mockPrisma.schemeEligibility.findMany.mockResolvedValue([{ schemeId: 's1' }]);
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(partner, { status: 'EXPIRED' as never });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('ACTIVE'); // NOT 'EXPIRED'
      expect(where.id).toEqual({ in: ['s1'] });
    });

    it('rejects a forged x-active-partner-id selector (not in the operable set) → Forbidden', async () => {
      // own partner exists (grouped) but the requested sibling id resolves to nothing → forbidden.
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'p1', groupId: 'PAR' }) // own lookup
        .mockResolvedValueOnce(null); // sibling authorize lookup → not operable
      await expect(service.list(partner, {}, 'w3test-evil')).rejects.toBeInstanceOf(ForbiddenException);
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
