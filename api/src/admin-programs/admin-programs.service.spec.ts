// Unit tests for the admin-programs services (one module, multiple sub-domains).
// Covers tenant/clientId scoping + a few key branches ported from the Next routes.
// Run: npx jest src/admin-programs/admin-programs.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

import { ChannelPartnersService } from './channel-partners.service';
import { VisibilityService } from './visibility.service';
import { BannersService } from './banners.service';
import { BannerConfigService } from './banner-config.service';
import { SchemesService } from './schemes.service';
import { ReportsService } from './reports.service';
import { KycService } from '../kyc/kyc.service';

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'p1', role: 'WHOLESALER', clientId: 'deoleo', phone: '', name: '' };

const mockPrisma = {
  channelPartner: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn(), count: jest.fn() },
  programSetting: { findFirst: jest.fn(), upsert: jest.fn() },
  bannerManagement: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  scheme: { findFirst: jest.fn() },
  schemeEnrollment: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  ticket: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
};

// TenantService mock — used by VisibilityService (bulkUpload mode gate).
// Default: resolves to 'AMOUNT_UPLOAD' so the existing bulkUpload tests that probe
// file-validation errors are not short-circuited by the mode gate.
const mockTenant = {
  resolveVisibilityCaptureMode: jest.fn().mockResolvedValue('AMOUNT_UPLOAD'),
  // Master visibility switch — default ON so the existing bulkUpload/listRecords tests
  // are not blocked by the master gate (the OFF→403 case is tested separately).
  resolveVisibilityEnabled: jest.fn().mockResolvedValue(true),
};

async function build<T>(token: new (...args: never[]) => T): Promise<T> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      token as never,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: TenantService, useValue: mockTenant },
      // ReportsService.outletMaster mints doc-view links via KycService.
      { provide: KycService, useValue: { signDocViewToken: jest.fn(() => 'tok') } },
    ],
  }).compile();
  return module.get(token);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Re-apply the default mock after clearAllMocks resets implementations.
  mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
  mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
});

describe('ChannelPartnersService', () => {
  it('scopes list by clientId and isActive (drops World-A class/tier filters)', async () => {
    const service = await build(ChannelPartnersService);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.count.mockResolvedValue(0);

    await service.list(gifsy, { search: 'kumar' });

    const where = mockPrisma.channelPartner.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe('deoleo');
    expect(where.isActive).toBe(true);
    expect(where).not.toHaveProperty('partnerClass');
    expect(where).not.toHaveProperty('tier');
    expect(where.OR).toEqual([
      { businessName: { contains: 'kumar', mode: 'insensitive' } },
      { phone: { contains: 'kumar' } },
      { panNumber: { contains: 'kumar', mode: 'insensitive' } },
    ]);
  });

  it('throws NotFound when updating a partner outside the tenant', async () => {
    const service = await build(ChannelPartnersService);
    mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
    await expect(service.update(gifsy, 'cp1', { isActive: false })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates only isActive (currentTierConfigId is dropped) and writes an audit log', async () => {
    const service = await build(ChannelPartnersService);
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
    mockPrisma.channelPartner.update.mockResolvedValue({ id: 'cp1', isActive: false });

    await service.update(gifsy, 'cp1', { isActive: false });

    const data = mockPrisma.channelPartner.update.mock.calls[0][0].data;
    expect(data.isActive).toBe(false);
    expect(data).not.toHaveProperty('currentTierConfigId');
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
  });
});

describe('VisibilityService', () => {
  it('blocks partner roles from reading records', async () => {
    const service = await build(VisibilityService);
    await expect(service.listRecords(partner, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scopes records by clientId and clamps the limit to 100', async () => {
    const service = await build(VisibilityService);
    mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([]);
    mockPrisma.outletVisibilityRecord.count.mockResolvedValue(0);

    await service.listRecords(gifsy, { limit: 500, page: 1 });

    const args = mockPrisma.outletVisibilityRecord.findMany.mock.calls[0][0];
    expect(args.where.clientId).toBe('deoleo');
    expect(args.take).toBe(100);
  });

  it('rejects a bulk-upload with a non-xlsx extension', async () => {
    const service = await build(VisibilityService);
    const file = { originalname: 'data.csv', buffer: Buffer.from('') } as Express.Multer.File;
    await expect(service.bulkUpload(gifsy, file)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a bulk-upload with no file', async () => {
    const service = await build(VisibilityService);
    await expect(service.bulkUpload(gifsy, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('master visibility gate', () => {
    it('403s a tenant admin bulk-upload when visibility is OFF — before parsing the file', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const service = await build(VisibilityService);
      const file = { originalname: 'data.xlsx', buffer: Buffer.from('') } as Express.Multer.File;
      await expect(service.bulkUpload(clientAdmin, file)).rejects.toThrow(
        'Visibility is not enabled for this tenant.',
      );
    });

    it('403s a tenant admin listRecords when visibility is OFF', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const service = await build(VisibilityService);
      await expect(service.listRecords(clientAdmin, {})).rejects.toThrow(
        'Visibility is not enabled for this tenant.',
      );
    });

    it('EXEMPTS the GIFSY operator even when the flag is OFF', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const service = await build(VisibilityService);
      mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([]);
      mockPrisma.outletVisibilityRecord.count.mockResolvedValue(0);
      // Passes the gate (exempt) and proceeds to the real query.
      await expect(service.listRecords(gifsy, {})).resolves.toBeDefined();
    });
  });
});

describe('BannersService', () => {
  it('restricts non-GIFSY list to ACTIVE, non-expired banners', async () => {
    const service = await build(BannersService);
    mockPrisma.bannerManagement.findMany.mockResolvedValue([]);

    await service.list(clientAdmin);

    const where = mockPrisma.bannerManagement.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe('deoleo');
    expect(where.status).toBe('ACTIVE');
    expect(where.OR).toBeDefined();
  });

  it('does NOT filter status for GIFSY admins', async () => {
    const service = await build(BannersService);
    mockPrisma.bannerManagement.findMany.mockResolvedValue([]);

    await service.list(gifsy);

    const where = mockPrisma.bannerManagement.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ clientId: 'deoleo' });
  });

  it('soft-deletes within the tenant or throws NotFound', async () => {
    const service = await build(BannersService);
    mockPrisma.bannerManagement.findFirst.mockResolvedValue(null);
    await expect(service.remove(gifsy, 'b1')).rejects.toBeInstanceOf(NotFoundException);

    mockPrisma.bannerManagement.findFirst.mockResolvedValue({ id: 'b1' });
    mockPrisma.bannerManagement.update.mockResolvedValue({});
    await service.remove(gifsy, 'b1');
    const data = mockPrisma.bannerManagement.update.mock.calls[0][0].data;
    expect(data.deletedAt).toBeInstanceOf(Date);
  });
});

describe('BannerConfigService', () => {
  it('blocks partner roles from reading config', async () => {
    const service = await build(BannerConfigService);
    await expect(service.get(partner)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('SchemesService', () => {
  it('throws NotFound when the scheme is outside the tenant', async () => {
    const service = await build(SchemesService);
    mockPrisma.scheme.findFirst.mockResolvedValue(null);
    await expect(service.exportEnrollments(gifsy, 's1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound when the scheme has no enrollments', async () => {
    const service = await build(SchemesService);
    mockPrisma.scheme.findFirst.mockResolvedValue({ id: 's1', code: 'SCH1' });
    mockPrisma.schemeEnrollment.findMany.mockResolvedValue([]);
    await expect(service.exportEnrollments(gifsy, 's1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ReportsService', () => {
  it('points-ledger: rejects missing from/to', async () => {
    const service = await build(ReportsService);
    await expect(service.pointsLedger(gifsy, { from: '', to: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('points-ledger: scopes outlets by partner.clientId', async () => {
    const service = await build(ReportsService);
    mockPrisma.outlet.findMany.mockResolvedValue([]);

    const res = await service.pointsLedger(gifsy, { from: '2026-01', to: '2026-03' });

    const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(where.partner.clientId).toBe('deoleo');
    expect(where.deletedAt).toBeNull();
    expect(res).toHaveProperty('months');
    expect(res).toHaveProperty('rows');
  });

  it('ticket-aging: rejects an invalid status value', async () => {
    const service = await build(ReportsService);
    await expect(
      service.ticketAging(gifsy, { status: 'BOGUS' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ticket-aging: scopes tickets by clientId and applies the default open set', async () => {
    const service = await build(ReportsService);
    mockPrisma.ticket.findMany.mockResolvedValue([]);

    const res = await service.ticketAging(gifsy, {});

    const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe('deoleo');
    expect(where.deletedAt).toBeNull();
    expect(where.status.in).toEqual(['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'ESCALATED']);
    expect(res).toHaveProperty('summary');
  });
});
