// Employee Rewards Phase B — unit tests for the ACCOUNT-FIRST self-service redeem rail on
// RewardsService.redeemForEmployee + the transitionOrder refund branch for an account-owned order.
//
// Covers: the EMPLOYEE-earner tenant gate (a TRADE tenant is rejected); resolving the CALLER's OWN
// SalesUser; cash modes rejected; inactive/absent employee rejected; an ACCOUNT-FIRST order created
// (partnerId null, CONFIRMED, debit via debitRedeemForAccount NOT debitRedeem); insufficient balance
// rolls back; the sourceKey idempotency short-circuit; and the trade redeem/confirmRedeem are never
// reached. Plus: transitionOrder refunds an employee (null-partner) order via reverseForAccount.
// Run: npx jest src/rewards/rewards.employee-redeem.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { EmployeeRedeemDto } from './dto/rewards.dto';

// Account helpers are stubbed (own tests in reward-account.helper.spec.ts) so these specs assert the
// ORCHESTRATION (which helper is called), not the helpers' internal tx calls.
jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-outlet'),
  ensureEmployeeAccount: jest.fn().mockResolvedValue('acc-emp'),
  ensureEmployeeWallet: jest.fn().mockResolvedValue('w-emp'),
}));
import { ensureEmployeeAccount, ensureEmployeeWallet } from '../common/reward-account.helper';

// Deterministic tenant order number (own tests in order-number.helper.spec.ts).
jest.mock('./order-number.helper', () => ({
  generateTenantOrderNumber: jest.fn().mockResolvedValue('ACME-26-000123'),
}));

const mockPrisma = {
  client: { findUnique: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  rewardCatalog: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  redemptionOrder: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  redemptionStatusHistory: { create: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
};

const mockWallet = {
  debitRedeem: jest.fn(),
  debitRedeemForAccount: jest.fn().mockResolvedValue({ transactionId: 'wt1', newRedeemable: 0, ledgerId: 'l1' }),
  reverse: jest.fn(),
  reverseForAccount: jest.fn().mockResolvedValue({ transactionId: 'wtR', newRedeemable: 50, ledgerId: 'lR' }),
};

const mockNotifications = {
  notifyUserWithChannels: jest.fn().mockResolvedValue(undefined),
};
const mockMsg91 = { sendOtp: jest.fn().mockResolvedValue(undefined) };

const SETTINGS = () => ({
  conversionRate: 1,
  minBankTransferAmount: 0,
  minVoucherFreeAmount: 0,
  redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
});
let mockSettings = SETTINGS();
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(async () => mockSettings),
  getConversionRate: jest.fn(async () => mockSettings.conversionRate),
};

const EMPLOYEE_CLIENT = { loyaltyType: 'EMPLOYEE_REWARDS', features: null };
const TRADE_CLIENT = { loyaltyType: 'TRADE_LOYALTY', features: null };

// A logged-in employee (role = tenant hierarchy code; irrelevant — the service resolves the SalesUser).
const employee: JwtPayload = { sub: 'u-emp', role: 'FIELD_EXEC', clientId: 'acme', phone: '9830000000', name: 'Asha' };
const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'acme', phone: '', name: '' };

const PLATFORM_GIFT = {
  id: 'r1',
  clientId: 'acme',
  name: 'Mug',
  redemptionMode: 'PHYSICAL_GIFT',
  pointsCost: 50,
  minRedemptionPoints: null,
  maxRedemptionPoints: null,
  stockQuantity: null,
  sellingValuePaise: 20000,
  sourceType: 'PLATFORM',
  vendorId: null,
};

const ADDR = { name: 'Asha', mobile: '9830000000', address: '1 St', city: 'Kolkata', state: 'WB', pincode: '700001' };

describe('RewardsService — Employee Rewards Phase B (self-service redeem)', () => {
  let service: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSettings = SETTINGS();
    mockPrisma.$transaction.mockImplementation((fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
    mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT);
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-emp', isActive: true });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ ...PLATFORM_GIFT });
    mockPrisma.rewardCatalog.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null); // no prior idempotent order
    mockPrisma.redemptionOrder.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'o1', orderNumber: 'ACME-26-000123', ...args.data }),
    );
    mockWallet.debitRedeemForAccount.mockResolvedValue({ transactionId: 'wt1', newRedeemable: 0, ledgerId: 'l1' });
    (ensureEmployeeAccount as jest.Mock).mockResolvedValue('acc-emp');
    (ensureEmployeeWallet as jest.Mock).mockResolvedValue('w-emp');

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

  const dto = (over: Partial<EmployeeRedeemDto> = {}): EmployeeRedeemDto =>
    ({ rewardId: 'r1', quantity: 1, deliveryAddress: ADDR, sourceKey: 'k-default', ...over } as EmployeeRedeemDto);

  // ─── Tenant gate (Deoleo / trade safety) ─────────────────────────────────────
  it('REJECTS a TRADE tenant (fail-safe EMPLOYEE-earner gate) — no debit, no order', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.redeemForEmployee(employee, dto())).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    expect(mockWallet.debitRedeemForAccount).not.toHaveBeenCalled();
    expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
  });

  it('REJECTS an unknown/absent loyaltyType (fail-safe → TRADE)', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(null);
    await expect(service.redeemForEmployee(employee, dto())).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── Identity: the caller's OWN SalesUser ────────────────────────────────────
  it('resolves the CALLER own SalesUser (userId + clientId, non-deleted) and debits that account', async () => {
    await service.redeemForEmployee(employee, dto());
    expect(mockPrisma.salesUser.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u-emp', clientId: 'acme', deletedAt: null },
      select: { id: true, isActive: true },
    });
    expect(ensureEmployeeAccount).toHaveBeenCalledWith(mockPrisma, 'su-emp');
    expect(ensureEmployeeWallet).toHaveBeenCalledWith(mockPrisma, 'acc-emp');
  });

  it('REJECTS a caller with no SalesUser (non-employee) — never debits', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    await expect(service.redeemForEmployee(employee, dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockWallet.debitRedeemForAccount).not.toHaveBeenCalled();
  });

  it('REJECTS an INACTIVE employee — never debits', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su-emp', isActive: false });
    await expect(service.redeemForEmployee(employee, dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockWallet.debitRedeemForAccount).not.toHaveBeenCalled();
  });

  // ─── Catalogue + channel validation ──────────────────────────────────────────
  it('404s a missing/non-available item', async () => {
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
    await expect(service.redeemForEmployee(employee, dto())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('REJECTS a CASH mode (UPI/BANK_TRANSFER) — employees have no cash rail', async () => {
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ ...PLATFORM_GIFT, redemptionMode: 'UPI' });
    await expect(service.redeemForEmployee(employee, dto({ deliveryAddress: undefined }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockWallet.debitRedeemForAccount).not.toHaveBeenCalled();
  });

  // ─── The money path ──────────────────────────────────────────────────────────
  it('creates an ACCOUNT-FIRST CONFIRMED order and debits via debitRedeemForAccount (NOT debitRedeem)', async () => {
    const res = await service.redeemForEmployee(employee, dto());

    expect(res.status).toBe('CONFIRMED');
    expect(res.requiredPoints).toBe(50);

    const created = mockPrisma.redemptionOrder.create.mock.calls[0][0].data;
    expect(created.partnerId).toBeNull(); // account-first — no ChannelPartner
    expect(created.accountId).toBe('acc-emp');
    expect(created.status).toBe('CONFIRMED');
    expect(created.pointsDeducted).toBe(50); // past the debit already
    expect(created.totalPointsCost).toBe(50);
    expect(created.orderNumber).toBe('ACME-26-000123');

    // Debit the ACCOUNT wallet via the account-first primitive — never the trade (partner) one.
    expect(mockWallet.debitRedeemForAccount).toHaveBeenCalledWith(
      'acc-emp',
      50,
      { referenceId: 'o1', description: 'Redemption ACME-26-000123' },
      mockPrisma,
    );
    expect(mockWallet.debitRedeem).not.toHaveBeenCalled();

    // A creation status-history row lands the order in the fulfilment lifecycle.
    expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
      data: { orderId: 'o1', fromStatus: null, toStatus: 'CONFIRMED', changedById: 'u-emp' },
    });
  });

  it('never invokes the trade redeem/confirmRedeem self-redeem paths', async () => {
    const redeemSpy = jest.spyOn(service, 'redeem');
    const confirmSpy = jest.spyOn(service, 'confirmRedeem');
    await service.redeemForEmployee(employee, dto());
    expect(redeemSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('rolls back when the wallet has insufficient balance (debit throws)', async () => {
    mockWallet.debitRedeemForAccount.mockRejectedValue(new BadRequestException('Insufficient wallet balance for redemption'));
    await expect(service.redeemForEmployee(employee, dto())).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── Idempotency (double-submit) ─────────────────────────────────────────────
  it('a re-submit with the SAME key + SAME reward returns the EXISTING order and does NOT debit again', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o-existing', rewardId: 'r1', orderNumber: 'ACME-26-000001' });
    const res = await service.redeemForEmployee(employee, dto({ sourceKey: 'run_k1' }));
    expect(res.orderId).toBe('o-existing');
    expect(mockPrisma.$executeRaw).toHaveBeenCalled(); // per-(account,key) advisory lock taken
    expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    expect(mockWallet.debitRedeemForAccount).not.toHaveBeenCalled();
  });

  it('FAILS LOUD when the SAME key was used for a DIFFERENT reward (audit A Finding 2) — no silent wrong-order return', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o-other', rewardId: 'r-OTHER', orderNumber: 'ACME-26-000002' });
    await expect(service.redeemForEmployee(employee, dto({ sourceKey: 'run_k1' }))).rejects.toBeInstanceOf(BadRequestException);
    expect(mockWallet.debitRedeemForAccount).not.toHaveBeenCalled();
    expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
  });

  it('stamps the idempotency key on the order metadata when none exists yet', async () => {
    await service.redeemForEmployee(employee, dto({ sourceKey: 'run_k2' }));
    const created = mockPrisma.redemptionOrder.create.mock.calls[0][0].data;
    expect((created.metadata as Record<string, unknown>).employeeRedeemKey).toBe('run_k2');
    expect(mockWallet.debitRedeemForAccount).toHaveBeenCalledTimes(1);
  });

  // ─── transitionOrder refund for an ACCOUNT-FIRST (null-partner) order ─────────
  it('transitionOrder CANCEL refunds an employee order via reverseForAccount (NOT reverse)', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o1',
      partnerId: null,
      accountId: 'acc-emp',
      pointsDeducted: 50,
      quantity: 1,
      orderNumber: 'ACME-26-000123',
      status: 'CONFIRMED',
      redemptionMode: 'PHYSICAL_GIFT',
      fulfilmentChannel: null,
      voucherCode: null,
    });
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 }); // refund claim wins
    mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });

    await service.transitionOrder(gifsy, 'o1', { toStatus: 'CANCELLED' } as never);

    expect(mockWallet.reverseForAccount).toHaveBeenCalledWith(
      'acc-emp',
      50,
      { referenceId: 'o1', description: 'Refund ACME-26-000123' },
      mockPrisma,
    );
    expect(mockWallet.reverse).not.toHaveBeenCalled();
    // No ChannelPartner owner → no partner-notification fan-out for an employee order.
    expect(mockPrisma.channelPartner.findFirst).not.toHaveBeenCalled();
  });

  it('transitionOrder CANCEL still refunds a TRADE (partner) order via reverse (byte-identical path)', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o2',
      partnerId: 'cp1',
      accountId: 'acc-outlet',
      pointsDeducted: 30,
      quantity: 1,
      orderNumber: 'ACME-26-000200',
      status: 'CONFIRMED',
      redemptionMode: 'PHYSICAL_GIFT',
      fulfilmentChannel: null,
      voucherCode: null,
    });
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o2', status: 'CANCELLED' });
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'u1', phone: '9', ownerName: 'Owner' });

    await service.transitionOrder(gifsy, 'o2', { toStatus: 'CANCELLED' } as never);

    expect(mockWallet.reverse).toHaveBeenCalledWith(
      'cp1',
      30,
      { referenceId: 'o2', description: 'Refund ACME-26-000200' },
      mockPrisma,
    );
    expect(mockWallet.reverseForAccount).not.toHaveBeenCalled();
  });
});
