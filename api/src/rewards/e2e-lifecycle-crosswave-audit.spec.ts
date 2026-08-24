/**
 * Gift Catalogue & Dispatch — LIFECYCLE / DISPATCH / CROSS-WAVE adversarial audit spec.
 *
 * Final whole-module gate (Waves 1–3). This file targets EDGE CASES and CROSS-WAVE
 * SEAMS not already exercised by the focused specs (rewards.service.spec,
 * vendor-portal.service.spec, gift-disbursal.service.spec, vendor-pii.helper.spec,
 * gift-value.helper.spec, dispatch-sla.spec, order-number.helper.spec):
 *
 *  A. Order-number edge cases — year rollover reset, >999,999 width/ordering, and the
 *     deriveTenantCode collision (two slugs → one prefix namespace).
 *  B. Cross-wave 194R ⇄ disbursal reconciliation — a tenant holding BOTH a PLATFORM and
 *     a VENDOR gift, with RETURNED + CANCELLED noise, sums value on the DELIVERED basis
 *     ONLY (== 194R Source-2), grouping platform + vendor separately but into one total.
 *  C. GAP — channel-appropriate required fields: a DIGITAL_VOUCHER order can currently
 *     reach DELIVERED with NO voucher code (no server-side guard). Documented + a skipped
 *     assertion of the desired behaviour.
 *  D. GAP — GiftCategory delete guard is incomplete: it checks child categories + gift
 *     masters but NOT RewardCatalog rows linked via giftCategoryId (vendor items have no
 *     master), and the FK is ON DELETE SET NULL → deleting silently strips the shared-
 *     taxonomy link from live vendor catalogue rows. Documented + a skipped assertion.
 *  E. Transition state-machine terminality — DELIVERED→PROCESSING is rejected (a
 *     terminal/backwards edge the edge-map must never allow).
 *
 * Known-bug cases are marked it.skip + `// BUG:` and listed in the audit report.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { GiftCatalogueService } from '../gift-catalogue/gift-catalogue.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  deriveTenantCode,
  formatOrderNumber,
  generateTenantOrderNumber,
} from './order-number.helper';
import {
  buildDisbursalReport,
  DisbursalOrderRow,
} from '../vendor/gift-disbursal.helper';

// ─────────────────────────────────────────────────────────────────────────────
// A. ORDER-NUMBER EDGE CASES (pure helper — no DB)
// ─────────────────────────────────────────────────────────────────────────────
describe('order-number — lifecycle edge cases', () => {
  const makeTx = (existing: string[]) => ({
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue(existing.map((orderNumber) => ({ orderNumber }))),
  });

  it('year rollover RESETS the sequence to 000001 for the new YY prefix', async () => {
    // The scan is prefix-scoped (LIKE 'DEOLEO-26-%'), so last year's DEOLEO-25-* rows
    // are invisible to the 2026 generator → the 26 sequence starts fresh at 1.
    const tx = makeTx([]); // no DEOLEO-26-* rows yet
    const n = await generateTenantOrderNumber(tx as never, 'deoleo', new Date('2026-01-01T06:00:00Z'));
    expect(n).toBe('DEOLEO-26-000001');
  });

  it('does NOT truncate past 999,999 — a 7-digit suffix increments correctly', async () => {
    // Above 1,000,000/yr the suffix widens to 7 digits; the SQL orders by LENGTH DESC
    // first so the widest (numerically-largest) wins. parseInt + padStart(min 6) keeps 7.
    const tx = makeTx(['DEOLEO-26-1000000']);
    const n = await generateTenantOrderNumber(tx as never, 'deoleo', new Date('2026-06-01T00:00:00Z'));
    expect(n).toBe('DEOLEO-26-1000001');
    expect(formatOrderNumber('DEOLEO', '26', 1_000_001)).toBe('DEOLEO-26-1000001');
  });

  it('the advisory xact lock is taken BEFORE the max-suffix scan (collision-safe)', async () => {
    const tx = makeTx(['DEOLEO-26-000041']);
    await generateTenantOrderNumber(tx as never, 'deoleo', new Date('2026-06-01T00:00:00Z'));
    const lockOrder = tx.$executeRaw.mock.invocationCallOrder[0];
    const scanOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(scanOrder);
  });

  it('AUDIT NOTE (LOW): two slugs differing only by punctuation collapse to ONE prefix', () => {
    // deriveTenantCode strips non-alphanumerics, so distinct clientIds can share a code
    // → they share one order-number namespace + advisory lock. Uniqueness is still SAFE
    // (they scan the shared max), but the prefix no longer identifies the tenant. Real
    // prod slugs ('deoleo','gifsy') don't collide; documented so a future slug can't.
    expect(deriveTenantCode('deo-leo')).toBe(deriveTenantCode('deoleo'));
    expect(deriveTenantCode('acme.foods')).toBe(deriveTenantCode('acmefoods'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. CROSS-WAVE 194R ⇄ DISBURSAL RECONCILIATION (pure helper)
// ─────────────────────────────────────────────────────────────────────────────
describe('cross-wave — disbursal value basis reconciles with 194R Source-2', () => {
  it('sums value on DELIVERED valuePaise ONLY; platform + vendor group apart but total together', () => {
    // One tenant (deoleo), one outlet, holding BOTH a PLATFORM gift and a VENDOR gift,
    // plus RETURNED + CANCELLED + PENDING noise. 194R Source-2 = sum of DELIVERED
    // valuePaise for the tenant; the disbursal report VALUE must equal exactly that.
    const rows: DisbursalOrderRow[] = [
      { clientId: 'deoleo', vendorId: null, status: 'DELIVERED', valuePaise: 500_000n }, // platform gift
      { clientId: 'deoleo', vendorId: 'v1', status: 'DELIVERED', valuePaise: 300_000n }, // vendor gift
      { clientId: 'deoleo', vendorId: 'v1', status: 'RETURNED', valuePaise: 0n },        // returned → zeroed
      { clientId: 'deoleo', vendorId: null, status: 'CANCELLED', valuePaise: 500_000n }, // cancelled RETAINS valuePaise
      { clientId: 'deoleo', vendorId: 'v1', status: 'PENDING', valuePaise: null },       // pre-confirm
    ];
    const report = buildDisbursalReport(
      rows,
      new Map([['deoleo', 'Deoleo']]),
      new Map([['v1', 'Acme Vendor']]),
    );

    const expected194RBase = 500_000 + 300_000; // DELIVERED only
    expect(report.totals.valuePaise).toBe(expected194RBase);
    expect(report.totals.deliveredCount).toBe(2);
    expect(report.totals.totalOrders).toBe(5); // counts span ALL statuses

    const platform = report.items.find((g) => g.vendorId === null)!;
    const vendor = report.items.find((g) => g.vendorId === 'v1')!;
    // Platform group: 1 delivered (500k) + 1 cancelled (value excluded, counted).
    expect(platform.valuePaise).toBe(500_000);
    expect(platform.totalOrders).toBe(2);
    expect(platform.statusBreakdown.CANCELLED).toBe(1);
    // Vendor group: 1 delivered (300k) + returned + pending (value excluded, counted).
    expect(vendor.valuePaise).toBe(300_000);
    expect(vendor.totalOrders).toBe(3);
    // Sum of the two groups == the 194R base (seam a + c + d).
    expect(platform.valuePaise + vendor.valuePaise).toBe(expected194RBase);
  });

  it('a RETURNED order is EXCLUDED from value even if its valuePaise were not zeroed (robust to the belt-and-suspenders)', () => {
    const rows: DisbursalOrderRow[] = [
      { clientId: 'deoleo', vendorId: 'v1', status: 'RETURNED', valuePaise: 999_999n },
    ];
    const report = buildDisbursalReport(rows, new Map(), new Map());
    expect(report.totals.valuePaise).toBe(0); // status != DELIVERED → never summed
    expect(report.totals.totalOrders).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock harness for the service-level suites (C, E)
// ─────────────────────────────────────────────────────────────────────────────
jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  rewardCatalog: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  rewardCategory: { findFirst: jest.fn(), create: jest.fn() },
  redemptionOrder: {
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  redemptionStatusHistory: { create: jest.fn() },
  giftCategory: { findFirst: jest.fn(), count: jest.fn(), delete: jest.fn() },
  giftMaster: { count: jest.fn() },
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

// Un-assumed GIFSY_ADMIN → platformWide → cross-tenant console write path.
const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9990001111', name: '' };

describe('transition state-machine + channel-required-fields (service level)', () => {
  let rewards: RewardsService;

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
      ],
    }).compile();
    rewards = mod.get(RewardsService);
    mockPrisma.redemptionOrder.update.mockImplementation(async ({ data }: never) => ({
      id: 'o1',
      partnerId: 'cp1',
      orderNumber: 'DEOLEO-26-000001',
      ...(data as object),
    }));
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.redemptionStatusHistory.create.mockResolvedValue({ id: 'h1' });
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'u1', phone: '9', ownerName: 'O' });
  });

  // ── E. terminality / illegal edges ────────────────────────────────────────
  it('REJECTS a backwards/terminal edge DELIVERED→PROCESSING', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o1', partnerId: 'cp1', status: 'DELIVERED', redemptionMode: 'PHYSICAL_GIFT',
      pointsDeducted: 100, orderNumber: 'DEOLEO-26-000001',
    });
    await expect(
      rewards.transitionOrder(gifsy, 'o1', { toStatus: 'PROCESSING' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
  });

  it('REJECTS reviving a terminal CANCELLED order (CANCELLED→PROCESSING)', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o1', partnerId: 'cp1', status: 'CANCELLED', redemptionMode: 'GIFT_CARD',
      pointsDeducted: 0, orderNumber: 'DEOLEO-26-000001',
    });
    await expect(
      rewards.transitionOrder(gifsy, 'o1', { toStatus: 'PROCESSING' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── C. channel-appropriate required fields (DIGITAL_VOUCHER) ───────────────
  // BUG-1 (was a GAP, now FIXED): a DIGITAL_VOUCHER order must NOT reach DELIVERED without
  // an actual voucher code to deliver (channel-appropriate required field, design §5).
  // transitionOrder now rejects DISPATCHED→DELIVERED when the effective channel is
  // DIGITAL_VOUCHER and there is no non-blank effective voucher code. (The former
  // "documents current behaviour" GAP test that asserted this SUCCEEDED was removed — it
  // contradicted the fix.)
  it('BUG-1 FIXED: rejects DELIVERED for a DIGITAL_VOUCHER order with no voucher code (no update)', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o1', partnerId: 'cp1', status: 'DISPATCHED', redemptionMode: 'GIFT_CARD',
      fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: null, pointsDeducted: 100,
      orderNumber: 'DEOLEO-26-000001',
    });
    await expect(
      rewards.transitionOrder(gifsy, 'o1', { toStatus: 'DELIVERED' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
  });

  it('BUG-1 FIXED: DELIVERED is ALLOWED once a voucher code is supplied on the transition', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o1', partnerId: 'cp1', status: 'DISPATCHED', redemptionMode: 'GIFT_CARD',
      fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: null, pointsDeducted: 100,
      orderNumber: 'DEOLEO-26-000001',
    });
    const res = await rewards.transitionOrder(gifsy, 'o1', {
      toStatus: 'DELIVERED' as never,
      voucherCode: 'AMZN-XYZ-123',
    });
    // The effective voucher code (supplied on the call) satisfies the channel guard.
    expect(mockPrisma.redemptionOrder.update).toHaveBeenCalled();
    expect(res.order.status).toBe('DELIVERED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. GiftCategory delete guard (Wave 1 + Wave 2 seam)
// ─────────────────────────────────────────────────────────────────────────────
describe('GiftCatalogueService.deleteCategory — in-use guard completeness', () => {
  let catalogue: GiftCatalogueService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        GiftCatalogueService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    catalogue = mod.get(GiftCatalogueService);
  });

  // BUG-2 (was a GAP, now FIXED): deleteCategory previously guarded ONLY by child
  // categories + gift masters, never by RewardCatalog rows linked via giftCategoryId (a
  // VENDOR item has no GiftMaster, so it slipped past; the FK's ON DELETE SET NULL then
  // silently stripped the taxonomy link on live vendor rows). FIXED: deleteCategory now
  // also counts RewardCatalog rows on giftCategoryId and blocks with a ConflictException.
  // (The former "documents current behaviour" GAP test that asserted the delete SUCCEEDED
  // without counting RewardCatalog was removed — it contradicted the fix.)
  it('BUG-2 FIXED: blocks deleting a category still referenced by RewardCatalog.giftCategoryId (vendor items)', async () => {
    mockPrisma.giftCategory.findFirst.mockResolvedValue({ id: 'gc1' });
    mockPrisma.giftCategory.count.mockResolvedValue(0); // no child categories
    mockPrisma.giftMaster.count.mockResolvedValue(0);   // no masters filed under it
    mockPrisma.rewardCatalog.count.mockResolvedValue(1); // a live vendor item links here
    await expect(catalogue.deleteCategory(gifsy, 'gc1')).rejects.toThrow();
    // The new guard ran (RewardCatalog rows on giftCategoryId counted) and the delete was
    // prevented.
    expect(mockPrisma.rewardCatalog.count).toHaveBeenCalledWith({
      where: { giftCategoryId: 'gc1', deletedAt: null },
    });
    expect(mockPrisma.giftCategory.delete).not.toHaveBeenCalled();
  });

  it('deleteCategory still SUCCEEDS when no children, masters, or RewardCatalog rows reference it', async () => {
    mockPrisma.giftCategory.findFirst.mockResolvedValue({ id: 'gc1' });
    mockPrisma.giftCategory.count.mockResolvedValue(0);
    mockPrisma.giftMaster.count.mockResolvedValue(0);
    mockPrisma.rewardCatalog.count.mockResolvedValue(0); // nothing links here
    mockPrisma.giftCategory.delete.mockResolvedValue({ id: 'gc1' });

    const res = await catalogue.deleteCategory(gifsy, 'gc1');

    expect(mockPrisma.rewardCatalog.count).toHaveBeenCalledWith({
      where: { giftCategoryId: 'gc1', deletedAt: null },
    });
    expect(mockPrisma.giftCategory.delete).toHaveBeenCalledWith({ where: { id: 'gc1' } });
    expect(res).toEqual({ id: 'gc1', deleted: true });
  });
});
