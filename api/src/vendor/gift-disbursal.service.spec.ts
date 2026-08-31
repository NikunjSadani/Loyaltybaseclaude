import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { GiftDisbursalService } from './gift-disbursal.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  redemptionOrder: { findMany: jest.fn() },
  client: { findMany: jest.fn() },
  vendor: { findMany: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'a1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9990001111', name: '' };
const clientAdmin: JwtPayload = { sub: 'c1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '9992223333', name: '' };
const partner: JwtPayload = { sub: 'u1', role: 'SSS', clientId: 'deoleo', phone: '9991112222', name: '' };

describe('GiftDisbursalService', () => {
  let service: GiftDisbursalService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.findMany.mockResolvedValue([{ id: 'deoleo', internalName: 'Deoleo' }]);
    mockPrisma.vendor.findMany.mockResolvedValue([{ id: 'v1', name: 'Acme' }]);
    const mod: TestingModule = await Test.createTestingModule({
      providers: [GiftDisbursalService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = mod.get(GiftDisbursalService);
  });

  it('rejects a non-admin role', async () => {
    await expect(service.report(partner, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('FORCE-scopes a CLIENT_ADMIN to their own tenant (ignores a foreign clientId param)', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    await service.report(clientAdmin, { clientId: 'someone-else' });
    expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where).toMatchObject({
      partner: { clientId: 'deoleo' },
    });
  });

  it('a platform-wide Gifsy operator reads ALL tenants (no clientId scope) unless narrowed', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    await service.report(gifsy, {});
    expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where.partner).toBeUndefined();

    jest.clearAllMocks();
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    await service.report(gifsy, { clientId: 'deoleo' });
    expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where).toMatchObject({
      partner: { clientId: 'deoleo' },
    });
  });

  it('value == DELIVERED basis (194R-aligned): only DELIVERED valuePaise sums', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { status: 'DELIVERED', valuePaise: 150000n, fulfilledByVendorId: 'v1', partner: { clientId: 'deoleo' } },
      { status: 'DELIVERED', valuePaise: 50000n, fulfilledByVendorId: 'v1', partner: { clientId: 'deoleo' } },
      // CANCELLED keeps valuePaise but must NOT be counted in value
      { status: 'CANCELLED', valuePaise: 999999n, fulfilledByVendorId: 'v1', partner: { clientId: 'deoleo' } },
      // PLATFORM (no vendor) delivered → separate group
      { status: 'DELIVERED', valuePaise: 100000n, fulfilledByVendorId: null, partner: { clientId: 'deoleo' } },
    ]);

    const res = await service.report(gifsy, {});
    // vendor group value = 150000 + 50000 = 200000 (CANCELLED excluded)
    const vendorGroup = res.items.find((i) => i.vendorId === 'v1')!;
    expect(vendorGroup.valuePaise).toBe(200000);
    expect(vendorGroup.deliveredCount).toBe(2);
    expect(vendorGroup.statusBreakdown).toMatchObject({ DELIVERED: 2, CANCELLED: 1 });

    const platformGroup = res.items.find((i) => i.vendorId === null)!;
    expect(platformGroup.vendorName).toBe('Platform');
    expect(platformGroup.valuePaise).toBe(100000);

    // totals value = 200000 + 100000 = 300000 (all DELIVERED, no CANCELLED)
    expect(res.totals.valuePaise).toBe(300000);
    expect(res.totals.deliveredCount).toBe(3);
  });

  it('windows on deliveredAt (194R Source-2 basis), NOT createdAt (MED#5)', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    await service.report(gifsy, { from: '2025-04-01', to: '2026-03-31' });
    const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
    expect(where.deliveredAt).toBeDefined();
    expect(where.deliveredAt.gte).toBeInstanceOf(Date);
    expect(where.deliveredAt.lte).toBeInstanceOf(Date);
    // must NOT window on createdAt (that basis wouldn't reconcile to 194R)
    expect(where.createdAt).toBeUndefined();
  });

  it('date-only deliveredAt window uses INCLUSIVE IST day bounds, not raw/UTC setHours (IST boundary fix)', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    await service.report(gifsy, { from: '2025-04-01', to: '2026-03-31' });
    const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;

    // from → 00:00:00.000 IST of 2025-04-01 = 2025-03-31T18:30:00.000Z (NOT raw 05:30 IST).
    expect(where.deliveredAt.gte.toISOString()).toBe('2025-03-31T18:30:00.000Z');
    // to → 23:59:59.999 IST of 2026-03-31 = 2026-03-31T18:29:59.999Z (NOT the old UTC
    // setHours 23:59:59.999Z, which over-included ~5.5h into the next IST day).
    expect(where.deliveredAt.lte.toISOString()).toBe('2026-03-31T18:29:59.999Z');

    // A DELIVERED at 23:00 IST on the to-date (2026-03-31T17:30:00Z) is INSIDE the window.
    const insideTo = new Date('2026-03-31T17:30:00.000Z');
    expect(insideTo.getTime()).toBeLessThanOrEqual(where.deliveredAt.lte.getTime());
    // A DELIVERED at 02:00 IST the NEXT day (2026-03-31T20:30:00Z, = 2026-04-01 IST) is
    // EXCLUDED — the old UTC setHours(23,59,59,999) wrongly included it in FY2025-26.
    const nextIstDay = new Date('2026-03-31T20:30:00.000Z');
    expect(nextIstDay.getTime()).toBeGreaterThan(where.deliveredAt.lte.getTime());
  });

  it('vendorId filter narrows to one fulfiller', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    await service.report(gifsy, { vendorId: 'v1' });
    expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where).toMatchObject({
      fulfilledByVendorId: 'v1',
    });
  });
});
