// Employee Rewards Phase B W2 (EMP-GAP-1) — the GIFSY fulfilment/dispatch console must SEE and
// FULFIL account-first employee redemption orders (partnerId null, tenant via account.clientId),
// not only trade (partner) orders. Before this wave, every console read scoped by
// `partner: { clientId }`, which EXCLUDED null-partner employee orders and dereferenced partner
// fields they lack.
//
// These specs assert the ORDER-TENANT-SCOPE fragment + the row mapping, with Prisma mocked:
//   (a) an assumed operator (scope=tenant) now gets a null-partner employee order in
//       listFulfilmentOrders / getFulfilmentOrder (the OR fragment includes the account arm);
//   (b) a trade (partner) order is still returned and its row fields are unchanged (byte-identical);
//   (c) cross-tenant isolation — an operator scoped to tenant A emits a where that CANNOT match
//       tenant B's order (both OR arms pin clientId to A);
//   (d) the employee row shows the employee NAME (falls back to employeeCode), not a crash on null
//       partner.
// Run: npx jest src/rewards/rewards-fulfilment-scope.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { RewardsService } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  redemptionOrder: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  client: { findMany: jest.fn(), findUnique: jest.fn() },
  user: { findMany: jest.fn() },
  programSetting: { findFirst: jest.fn() }, // loadHolidaySet
};

const mockWallet = {};
const mockTenantSettings = {};
const mockNotifications = {};
const mockMsg91 = {};

// An ASSUMED GIFSY operator pinned to tenant A (role GIFSY_ADMIN + assumed → tenantScope = clientId).
const operatorA: JwtPayload = {
  sub: 'op-a',
  role: 'GIFSY_ADMIN',
  clientId: 'tenantA',
  phone: '',
  name: 'Op A',
  assumed: true,
} as JwtPayload;

// A trade (partner) order row as the console include returns it.
const tradeOrder = {
  id: 'o-trade',
  orderNumber: 'TA-26-000100',
  status: 'CONFIRMED',
  redemptionMode: 'PHYSICAL_GIFT',
  fulfilmentChannel: 'GIFSY_WAREHOUSE',
  totalPointsCost: 30,
  valuePaise: 12000n,
  trackingNumber: null,
  dispatchedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  reward: { id: 'r1', name: 'Mug', sourceType: 'PLATFORM' },
  partner: { id: 'cp1', businessName: 'Acme Store', clientId: 'tenantA' },
  account: { clientId: 'tenantA', employeeProfile: null }, // trade: account.clientId == partner.clientId
  statusHistory: [],
};

// An account-first EMPLOYEE order: partner null, tenant + recipient via the account.
const employeeOrder = {
  id: 'o-emp',
  orderNumber: 'TA-26-000200',
  status: 'CONFIRMED',
  redemptionMode: 'PHYSICAL_GIFT',
  fulfilmentChannel: 'GIFSY_WAREHOUSE',
  totalPointsCost: 50,
  valuePaise: 20000n,
  trackingNumber: null,
  dispatchedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  updatedAt: new Date('2026-10-02T00:00:00Z'),
  createdAt: new Date('2026-10-02T00:00:00Z'),
  reward: { id: 'r2', name: 'Bottle', sourceType: 'PLATFORM' },
  partner: null,
  account: { clientId: 'tenantA', employeeProfile: { employeeCode: 'EMP-7', user: { name: 'Asha' } } },
  statusHistory: [],
};

describe('RewardsService — fulfilment console tenant scope (EMP-GAP-1)', () => {
  let service: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.programSetting.findFirst.mockResolvedValue(null); // no holidays
    mockPrisma.client.findMany.mockResolvedValue([{ id: 'tenantA', internalName: 'Tenant A' }]);
    mockPrisma.client.findUnique.mockResolvedValue({ internalName: 'Tenant A' });
    mockPrisma.user.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(RewardsService);
  });

  // ─── (a)+(d) list: employee order visible + recipient shown ────────────────────
  it('(a) listFulfilmentOrders returns a null-partner employee order for a scoped operator', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([employeeOrder]);
    mockPrisma.redemptionOrder.count.mockResolvedValue(1);

    const res = await service.listFulfilmentOrders(operatorA, {} as never);

    // The scope where spans BOTH arms (trade partner + employee account) pinned to tenant A.
    const whereArg = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
    expect(whereArg.OR).toEqual([
      { partner: { clientId: 'tenantA' } },
      { account: { clientId: 'tenantA' } },
    ]);

    expect(res.items).toHaveLength(1);
    const row = res.items[0];
    expect(row.id).toBe('o-emp');
    // (d) recipient falls back to the employee name; tenant resolves via the account's clientId.
    expect(row.partnerName).toBe('Asha');
    expect(row.clientId).toBe('tenantA');
    expect(row.tenantName).toBe('Tenant A');
  });

  it('(d) employee row falls back to employeeCode when the employee has no user name', async () => {
    const noName = {
      ...employeeOrder,
      account: { clientId: 'tenantA', employeeProfile: { employeeCode: 'EMP-7', user: { name: null } } },
    };
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([noName]);
    mockPrisma.redemptionOrder.count.mockResolvedValue(1);

    const res = await service.listFulfilmentOrders(operatorA, {} as never);
    expect(res.items[0].partnerName).toBe('EMP-7');
  });

  // ─── (b) trade rows unchanged ──────────────────────────────────────────────────
  it('(b) a trade (partner) order still renders byte-identical (partnerName = businessName)', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([tradeOrder]);
    mockPrisma.redemptionOrder.count.mockResolvedValue(1);

    const res = await service.listFulfilmentOrders(operatorA, {} as never);
    const row = res.items[0];
    expect(row.id).toBe('o-trade');
    expect(row.partnerName).toBe('Acme Store'); // partner present → short-circuits, unchanged
    expect(row.clientId).toBe('tenantA');
    expect(row.tenantName).toBe('Tenant A');
  });

  // ─── (c) cross-tenant isolation (the where can't match tenant B) ───────────────
  it('(c) an operator scoped to tenant A emits a where that cannot match tenant B orders', async () => {
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.count.mockResolvedValue(0);

    await service.listFulfilmentOrders(operatorA, {} as never);

    const whereArg = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
    // Both arms pin clientId to tenantA — no arm admits any other tenant (e.g. tenantB).
    for (const arm of whereArg.OR) {
      const clientId = arm.partner?.clientId ?? arm.account?.clientId;
      expect(clientId).toBe('tenantA');
    }
    // A scoped operator must NOT be able to override the pin via q.clientId (ignored for scope).
    await service.listFulfilmentOrders(operatorA, { clientId: 'tenantB' } as never);
    const where2 = mockPrisma.redemptionOrder.findMany.mock.calls[1][0].where;
    expect(where2.OR).toEqual([
      { partner: { clientId: 'tenantA' } },
      { account: { clientId: 'tenantA' } },
    ]);
  });

  // ─── (a) detail: employee order visible via getFulfilmentOrder ─────────────────
  it('(a) getFulfilmentOrder returns a null-partner employee order with the employee recipient', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      ...employeeOrder,
      quantity: 1,
      logisticsPartner: null,
      trackingUrl: null,
      supplierOrderRef: null,
      voucherCode: null,
      voucherProvider: null,
      fulfilledByVendorId: null,
      fulfilledByVendor: null,
      deliveryName: null,
      deliveryAddressLine1: null,
      deliveryAddressLine2: null,
      deliveryCity: null,
      deliveryState: null,
      deliveryPincode: null,
      deliveryPhone: null,
      reward: { id: 'r2', name: 'Bottle', sourceType: 'PLATFORM', giftMasterId: null, vendorId: null },
    });

    const res = await service.getFulfilmentOrder(operatorA, 'o-emp');

    const whereArg = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0].where;
    expect(whereArg.OR).toEqual([
      { partner: { clientId: 'tenantA' } },
      { account: { clientId: 'tenantA' } },
    ]);
    expect(res.id).toBe('o-emp');
    expect(res.partnerName).toBe('Asha'); // (d) no crash on null partner
    expect(res.clientId).toBe('tenantA');
    expect(res.tenantName).toBe('Tenant A');
  });

  // ─── Platform-wide OWNER (un-assumed) → no scope fragment ──────────────────────
  it('an un-assumed OWNER scopes platform-wide (no OR fragment)', async () => {
    const owner: JwtPayload = { sub: 'ow', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.count.mockResolvedValue(0);

    await service.listFulfilmentOrders(owner, {} as never);
    const whereArg = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
    expect(whereArg.OR).toBeUndefined(); // platform-wide → all tenants
  });
});
