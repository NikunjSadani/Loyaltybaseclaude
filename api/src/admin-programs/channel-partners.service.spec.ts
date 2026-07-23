// Unit tests for ChannelPartnersService — the OPERATING-partner admin endpoints.
// Focus: a PARENT (owner-group anchor, isParent=true) is non-operating and must be excluded
// from getOne/update just as it already is from list/count (F10 / PARTNER-MULTI-OUTLET §9).
// Run: npx jest src/admin-programs/channel-partners.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ChannelPartnersService } from './channel-partners.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  channelPartner: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
};

const TENANT_A = 'tenant-a';
const admin: JwtPayload = { sub: 'actor1', role: 'CLIENT_ADMIN', clientId: TENANT_A, phone: '', name: '' };

describe('ChannelPartnersService', () => {
  let service: ChannelPartnersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChannelPartnersService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(ChannelPartnersService);
  });

  describe('list / count exclude parents (existing behaviour, guarded)', () => {
    it('scopes the list to isParent:false + isActive + the tenant', async () => {
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);
      mockPrisma.channelPartner.count.mockResolvedValue(0);
      await service.list(admin, {});
      const where = mockPrisma.channelPartner.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ clientId: TENANT_A, isActive: true, isParent: false });
    });
  });

  describe('getOne excludes parents (F10)', () => {
    it('scopes the lookup with isParent:false and returns the operating partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      const res = await service.getOne(admin, 'cp1');
      expect(res.partner).toEqual({ id: 'cp1' });
      const where = mockPrisma.channelPartner.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 'cp1', clientId: TENANT_A, isParent: false });
    });

    it('returns NotFound for a PARENT id (excluded by isParent:false → findFirst yields null)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null); // a parent id won't match the filter
      await expect(service.getOne(admin, 'parent1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update excludes parents (F10)', () => {
    it('rejects a PARENT id with NotFound and never mutates it', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null); // parent excluded by isParent:false
      await expect(service.update(admin, 'parent1', { isActive: false })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const where = mockPrisma.channelPartner.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 'parent1', clientId: TENANT_A, isParent: false });
      expect(mockPrisma.channelPartner.update).not.toHaveBeenCalled();
    });

    it('updates a real operating partner (isParent:false match)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.channelPartner.update.mockResolvedValue({ id: 'cp1', isActive: false });
      const res = await service.update(admin, 'cp1', { isActive: false });
      expect(res.partner).toMatchObject({ id: 'cp1' });
      expect(mockPrisma.channelPartner.update).toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });
  });
});
