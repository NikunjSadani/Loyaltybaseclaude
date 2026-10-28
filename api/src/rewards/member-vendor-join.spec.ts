/**
 * Wave-2 member-side vendor seam tests (Gift Catalogue & Dispatch): the vendor
 * visibility cascade (review CRITICAL #2) + the DPDP consent gate (decision #15).
 * Kept in a focused spec so the 140KB rewards.service.spec stays untouched.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { RewardsService, vendorVisibilityFilter } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { HubbleService } from '../hubble/hubble.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  // Per-outlet-type Loyalty gate (isLoyaltyEnabledForPartner): no outlet row → helper
  // returns its default TRUE (loyalty on), so these vendor-visibility/consent tests
  // exercise the catalogue/redeem path unchanged.
  outlet: { findFirst: jest.fn().mockResolvedValue(null) },
  outletTypeClientConfig: { findUnique: jest.fn().mockResolvedValue(null) },
  rewardCatalog: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  redemptionOrder: { create: jest.fn(), updateMany: jest.fn() },
  otpCode: { create: jest.fn(), deleteMany: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
};
const mockWallet = { debitRedeem: jest.fn(), reverse: jest.fn() };
const mockNotifications = { notifyUserWithChannels: jest.fn().mockResolvedValue(undefined) };
const mockMsg91 = { sendOtp: jest.fn().mockResolvedValue(undefined) };
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(async () => ({
    conversionRate: 1,
    minBankTransferAmount: 0,
    minVoucherFreeAmount: 0,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  })),
  getConversionRate: jest.fn(async () => 1),
  getOtpTemplateId: jest.fn(async () => undefined),
};

const member: JwtPayload = { sub: 'u1', role: 'SSS', clientId: 'deoleo', phone: '9991112222', name: '' };

describe('RewardsService — vendor visibility + consent (Wave 2)', () => {
  let service: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: HubbleService, useValue: { isConfigured: () => false, placeOrder: jest.fn(), getOrderByReference: jest.fn() } },
      ],
    }).compile();
    service = mod.get(RewardsService);
  });

  describe('vendorVisibilityFilter (suspend/revoke cascade)', () => {
    it('always admits PLATFORM rows; gates VENDOR rows on ACTIVE vendor + ACTIVE grant', () => {
      const f = vendorVisibilityFilter('deoleo');
      expect(f.OR).toEqual([
        { sourceType: 'PLATFORM' },
        {
          sourceType: 'VENDOR',
          vendor: { is: { status: 'ACTIVE', grants: { some: { clientId: 'deoleo', status: 'ACTIVE' } } } },
        },
      ]);
    });
  });

  describe('listCatalog applies the vendor visibility filter', () => {
    it('the where carries the PLATFORM-or-active-VENDOR OR clause + APPROVED moderation', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: null });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 1000 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(0);

      await service.listCatalog(member, {});
      const where = mockPrisma.rewardCatalog.findMany.mock.calls[0][0].where;
      expect(where.moderationStatus).toBe('APPROVED');
      expect(where.OR).toEqual(vendorVisibilityFilter('deoleo').OR);
    });
  });

  describe('DPDP consent gate on redeem (decision #15)', () => {
    it('BLOCKS a VENDOR-item redeem without consent', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', sourceType: 'VENDOR', vendorId: 'v1', redemptionMode: 'GIFT_CARD',
        pointsCost: 100, minRedemptionPoints: null, maxRedemptionPoints: null, sellingValuePaise: 50000,
      });
      await expect(service.redeem(member, { rewardId: 'r1' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('STORES vendorPiiConsentAt + consentVersion + fulfilledByVendorId when consent is given', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', sourceType: 'VENDOR', vendorId: 'v1', redemptionMode: 'GIFT_CARD',
        pointsCost: 100, minRedemptionPoints: null, maxRedemptionPoints: null, sellingValuePaise: 50000,
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: null });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100000 });
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.redemptionOrder.create.mockImplementation(async ({ data }: never) => ({ id: 'o1', orderNumber: 'D-26-1', ...(data as object) }));
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      await service.redeem(member, { rewardId: 'r1', consent: true });

      const data = mockPrisma.redemptionOrder.create.mock.calls[0][0].data;
      expect(data.fulfilledByVendorId).toBe('v1');
      expect(data.consentVersion).toBeTruthy();
      expect(data.vendorPiiConsentAt).toBeInstanceOf(Date);
    });

    it('a PLATFORM item needs NO consent (redeem proceeds)', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r2', sourceType: 'PLATFORM', vendorId: null, redemptionMode: 'GIFT_CARD',
        pointsCost: 100, minRedemptionPoints: null, maxRedemptionPoints: null, sellingValuePaise: 50000,
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: null });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100000 });
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.redemptionOrder.create.mockImplementation(async ({ data }: never) => ({ id: 'o2', orderNumber: 'D-26-2', ...(data as object) }));
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp2' });

      await service.redeem(member, { rewardId: 'r2' });
      const data = mockPrisma.redemptionOrder.create.mock.calls[0][0].data;
      expect(data.fulfilledByVendorId).toBeUndefined();
      expect(data.vendorPiiConsentAt).toBeUndefined();
    });
  });
});
