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
  schemeTarget: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
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
    it('scopes admins to active, non-deleted schemes in their tenant only', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      mockPrisma.scheme.count.mockResolvedValue(0);
      await service.list(clientAdmin, {});
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', status: 'ACTIVE', deletedAt: null });
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
      expect(where).toEqual({ clientId: 'deoleo', status: 'ACTIVE', deletedAt: null, id: { in: ['s1', 's2'] } });
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

  describe('getSchemeTarget', () => {
    it('throws NotFound when the scheme is outside the tenant', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue(null);
      await expect(service.getSchemeTarget(partner, 's1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a null target with a message when none is assigned', async () => {
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', name: 'S', endDate: new Date() });
      mockPrisma.schemeTarget.findFirst.mockResolvedValue(null);
      await expect(service.getSchemeTarget(partner, 's1')).resolves.toEqual({
        target: null,
        message: 'No target assigned for this scheme',
      });
    });

    it('computes a capped percentage and enriches with scheme name/deadline', async () => {
      const deadline = new Date('2026-12-31');
      mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', name: 'S', endDate: deadline });
      mockPrisma.schemeTarget.findFirst.mockResolvedValue({ id: 't1', targetValue: 100, achievedValue: 250 });
      const res = await service.getSchemeTarget(partner, 's1');
      expect(res.target?.percentage).toBe(100);
      expect(res.target?.schemeName).toBe('S');
      expect(res.target?.deadline).toBe(deadline);
    });
  });

  describe('listTargets', () => {
    it('scopes non-admins to their own targets even if userId is supplied', async () => {
      mockPrisma.schemeTarget.findMany.mockResolvedValue([]);
      mockPrisma.schemeTarget.count.mockResolvedValue(0);
      await service.listTargets(partner, { userId: 'other' });
      const where = mockPrisma.schemeTarget.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ userId: 'user1', scheme: { clientId: 'deoleo' } });
    });

    it('lets GIFSY admins inspect another user and enriches with projectedIncentive', async () => {
      mockPrisma.schemeTarget.findMany.mockResolvedValue([
        { id: 't1', targetValue: 200, achievedValue: 50, projectedIncentive: 99, scheme: { name: 'S', endDate: 'd' } },
      ]);
      mockPrisma.schemeTarget.count.mockResolvedValue(1);
      const res = await service.listTargets(gifsy, { userId: 'other' });
      const where = mockPrisma.schemeTarget.findMany.mock.calls[0][0].where;
      expect(where.userId).toBe('other');
      expect(res.targets[0].percentage).toBe(25);
      expect(res.targets[0].incentiveEarnable).toBe(99);
      expect(res.targets[0].schemeName).toBe('S');
    });
  });
});
