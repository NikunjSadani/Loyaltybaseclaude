import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { VendorAdminService } from './vendor-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  vendor: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  vendorTenantGrant: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  client: { findFirst: jest.fn(), findMany: jest.fn() },
  user: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  userSession: { updateMany: jest.fn() },
  auditLog: { create: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9990001111', name: '' };
const partner: JwtPayload = { sub: 'u1', role: 'SSS', clientId: 'deoleo', phone: '9991112222', name: '' };
// A scoped Gifsy STAFF (isGifsyOperator true) — must NOT reach the owner-only enumeration
// endpoints (Wave-2 audit MED#3).
const staff: JwtPayload = { sub: 's1', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '9993334444', name: '' };

describe('VendorAdminService', () => {
  let service: VendorAdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [VendorAdminService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = mod.get(VendorAdminService);
  });

  describe('data-boundary guard', () => {
    it('rejects a non-operator', async () => {
      await expect(service.listVendors(partner)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.createVendor(partner, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('OWNER-ONLY: a scoped GIFSY_STAFF cannot enumerate vendors / tenants (MED#3)', async () => {
      await expect(service.listVendors(staff)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.getVendor(staff, 'v1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.listTenants(staff)).rejects.toBeInstanceOf(ForbiddenException);
      // no cross-tenant grant map was ever read
      expect(mockPrisma.vendor.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.vendor.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.client.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listVendors', () => {
    it('shapes items with grants (+clientName) and userCount', async () => {
      mockPrisma.vendor.findMany.mockResolvedValue([
        {
          id: 'v1',
          name: 'Acme',
          status: 'ACTIVE',
          grants: [{ id: 'g1', clientId: 'deoleo', approvalPolicy: 'GIFSY_APPROVE', status: 'ACTIVE' }],
          _count: { users: 2 },
        },
      ]);
      mockPrisma.client.findMany.mockResolvedValue([{ id: 'deoleo', internalName: 'Deoleo' }]);

      const res = await service.listVendors(gifsy);
      expect(res.items[0]).toMatchObject({
        id: 'v1',
        name: 'Acme',
        userCount: 2,
        grants: [{ clientId: 'deoleo', clientName: 'Deoleo', approvalPolicy: 'GIFSY_APPROVE', status: 'ACTIVE' }],
      });
    });
  });

  describe('getVendor (FLAT detail)', () => {
    it('rejects a non-operator', async () => {
      await expect(service.getVendor(partner, 'v1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404 when the vendor does not exist', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue(null);
      await expect(service.getVendor(gifsy, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns grants (+clientName) AND the users login list (+clientName)', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({
        id: 'v1',
        name: 'Acme',
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01'),
        grants: [{ id: 'g1', clientId: 'deoleo', approvalPolicy: 'GIFSY_APPROVE', status: 'ACTIVE' }],
        users: [
          { id: 'vu1', name: 'Rep', phone: '9998887777', clientId: 'deoleo', status: 'ACTIVE' },
        ],
      });
      mockPrisma.client.findMany.mockResolvedValue([{ id: 'deoleo', internalName: 'Deoleo' }]);

      const res = await service.getVendor(gifsy, 'v1');
      expect(res).toMatchObject({
        id: 'v1',
        name: 'Acme',
        status: 'ACTIVE',
        userCount: 1,
        grants: [{ id: 'g1', clientId: 'deoleo', clientName: 'Deoleo', approvalPolicy: 'GIFSY_APPROVE', status: 'ACTIVE' }],
        users: [{ id: 'vu1', name: 'Rep', phone: '9998887777', clientId: 'deoleo', clientName: 'Deoleo', status: 'ACTIVE' }],
      });
    });
  });

  describe('listTenants (grant picker)', () => {
    it('rejects a non-operator', async () => {
      await expect(service.listTenants(partner)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns ACTIVE tenants EXCLUDING the gifsy operator tenant, shaped {id,name}', async () => {
      mockPrisma.client.findMany.mockResolvedValue([{ id: 'deoleo', internalName: 'Deoleo' }]);
      const res = await service.listTenants(gifsy);
      expect(mockPrisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'ACTIVE', id: { not: 'gifsy' } } }),
      );
      expect(res).toEqual({ items: [{ id: 'deoleo', name: 'Deoleo' }] });
    });
  });

  describe('updateVendor — SUSPEND cascade', () => {
    it('SUSPENDED stamps sessionsInvalidBefore + sweeps the vendor users\' sessions', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', status: 'ACTIVE' });
      mockPrisma.vendor.update.mockResolvedValue({ id: 'v1', status: 'SUSPENDED' });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'vu1' }, { id: 'vu2' }]);

      await service.updateVendor(gifsy, 'v1', { status: 'SUSPENDED' });

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['vu1', 'vu2'] } },
        data: { sessionsInvalidBefore: expect.any(Date) },
      });
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
        where: { userId: { in: ['vu1', 'vu2'] }, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('a name-only edit does NOT sweep sessions', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', status: 'ACTIVE' });
      mockPrisma.vendor.update.mockResolvedValue({ id: 'v1', status: 'ACTIVE' });
      await service.updateVendor(gifsy, 'v1', { name: 'New Name' });
      expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('grants', () => {
    it('createGrant creates a new grant', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1' });
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'deoleo' });
      mockPrisma.vendorTenantGrant.findUnique.mockResolvedValue(null);
      mockPrisma.vendorTenantGrant.create.mockResolvedValue({ id: 'g1', status: 'ACTIVE' });

      const res = await service.createGrant(gifsy, 'v1', { clientId: 'deoleo', approvalPolicy: 'AUTO_LIVE' });
      expect(res).toMatchObject({ id: 'g1', status: 'ACTIVE' });
    });

    it('createGrant reactivates an existing (REVOKED) grant', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1' });
      mockPrisma.client.findFirst.mockResolvedValue({ id: 'deoleo' });
      mockPrisma.vendorTenantGrant.findUnique.mockResolvedValue({ id: 'g1', status: 'REVOKED' });
      mockPrisma.vendorTenantGrant.update.mockResolvedValue({ id: 'g1', status: 'ACTIVE' });

      await service.createGrant(gifsy, 'v1', { clientId: 'deoleo', approvalPolicy: 'GIFSY_APPROVE' });
      expect(mockPrisma.vendorTenantGrant.update).toHaveBeenCalledWith({
        where: { id: 'g1' },
        data: { status: 'ACTIVE', approvalPolicy: 'GIFSY_APPROVE' },
      });
    });

    it('updateGrant REVOKED sweeps sessions for that tenant only', async () => {
      mockPrisma.vendorTenantGrant.findFirst.mockResolvedValue({ id: 'g1', vendorId: 'v1', clientId: 'deoleo', status: 'ACTIVE' });
      mockPrisma.vendorTenantGrant.update.mockResolvedValue({ id: 'g1', status: 'REVOKED' });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'vu1' }]);

      await service.updateGrant(gifsy, 'v1', 'g1', { status: 'REVOKED' });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: { vendorId: 'v1', clientId: 'deoleo' },
        select: { id: true },
      });
      expect(mockPrisma.userSession.updateMany).toHaveBeenCalled();
    });
  });

  describe('createVendorUser', () => {
    it('requires an ACTIVE grant for the tenant', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', status: 'ACTIVE' });
      mockPrisma.vendorTenantGrant.findFirst.mockResolvedValue(null);
      await expect(
        service.createVendorUser(gifsy, 'v1', { phone: '9998887777', name: 'Rep', clientId: 'deoleo' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a VENDOR user pinned to the tenant', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', status: 'ACTIVE' });
      mockPrisma.vendorTenantGrant.findFirst.mockResolvedValue({ id: 'g1' });
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'vu1', name: 'Rep', phone: '9998887777', role: 'VENDOR', clientId: 'deoleo', vendorId: 'v1', status: 'ACTIVE',
      });

      const res = await service.createVendorUser(gifsy, 'v1', { phone: '9998887777', name: 'Rep', clientId: 'deoleo' });
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: 'VENDOR', vendorId: 'v1', clientId: 'deoleo' }) }),
      );
      expect(res).toMatchObject({ role: 'VENDOR', vendorId: 'v1' });
    });

    it('rejects a suspended vendor', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', status: 'SUSPENDED' });
      await expect(
        service.createVendorUser(gifsy, 'v1', { phone: '9998887777', name: 'Rep', clientId: 'deoleo' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 when the vendor does not exist', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue(null);
      await expect(
        service.createVendorUser(gifsy, 'nope', { phone: '9998887777', name: 'Rep', clientId: 'deoleo' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
