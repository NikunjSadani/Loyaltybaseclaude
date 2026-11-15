// Hubble "no order for this reference" → fail + refund (owner-approved 2026-11-15; dual-audit fixes).
// Stuck orders (BAJAJ-26-000032/38/39): place + recover both failed (HUBBLE_INDETERMINATE), points
// debited, no code; an OPS "Retry with Hubble" that gets Hubble's not-found must refund exactly once.
// The prisma mock is a STATEFUL single row: update/updateMany evaluate their where-clause against the
// row and mutate it synchronously (bumping updatedAt like Prisma's @updatedAt), and transactions are
// SERIALISED (Postgres keeps the row lock of the first claim until commit) — so races are real.
// Run: npx jest src/rewards/rewards.hubble-no-order-refund.spec.ts

import { createHmac } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HUBBLE_NO_ORDER_REFUND_MIN_AGE_MS, HUBBLE_NO_ORDER_REFUND_REASON, RewardsService } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { HubbleService } from '../hubble/hubble.service';
import { HubbleWebhookController } from '../hubble/hubble-webhook.controller';
import { JwtPayload } from '../common/decorators/current-user.decorator';

jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

type Row = Record<string, unknown>;
let row: Row;
let tick = 0;

const isDateLike = (v: unknown): v is Date =>
  !!v && typeof v === 'object' && typeof (v as Date).getTime === 'function';

/** Minimal Prisma where-evaluator for the predicates the Hubble claims use. */
function matches(r: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND') return (v as Record<string, unknown>[]).every((w) => matches(r, w));
    if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(r, w));
    const cur = r[k];
    if (isDateLike(v)) return isDateLike(cur) && cur.getTime() === v.getTime();
    if (v && typeof v === 'object') {
      const op = v as Record<string, unknown>;
      if ('in' in op) return (op.in as unknown[]).includes(cur);
      if ('gt' in op) return (cur as number) > (op.gt as number);
      throw new Error(`unsupported op ${JSON.stringify(op)}`);
    }
    return cur === v;
  });
}

const write = (data: Row) => {
  Object.assign(row, data, { updatedAt: (data.updatedAt as Date | undefined) ?? new Date(Date.now() + ++tick) });
};

const snapshot = () => ({
  ...structuredClone(row),
  partner: { clientId: 'bajaj', userId: 'owner-user', phone: '9990002222', ownerName: 'Owner' },
  reward: { name: 'Amazon ₹500', metadata: { hubbleProductId: 'amz-1' } },
});

let txQueue: Promise<unknown> = Promise.resolve();
const mockPrisma = {
  auditLog: { create: jest.fn().mockResolvedValue({}) },
  client: { findFirst: jest.fn() },
  redemptionOrder: {
    findFirst: jest.fn(async () => snapshot()),
    update: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      if (!matches(row, where)) throw new Error('P2025 record to update not found');
      write(data);
      return snapshot();
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      if (!matches(row, where)) return { count: 0 };
      write(data);
      return { count: 1 };
    }),
  },
  redemptionStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => {
    const run = txQueue.then(() => fn(mockPrisma));
    txQueue = run.then(() => undefined, () => undefined);
    return run;
  }),
};
const mockWallet = { debitRedeem: jest.fn(), reverse: jest.fn().mockResolvedValue(undefined) };
const mockNotifications = {
  enqueue: jest.fn(),
  writeInApp: jest.fn(),
  notifyUser: jest.fn(),
  notifyUserWithChannels: jest.fn().mockResolvedValue(undefined),
};
const FP = 'api.dev.myhubble.money#0123456789abcdef';
const mockHubble = {
  isConfigured: jest.fn().mockReturnValue(true),
  accountFingerprint: jest.fn().mockReturnValue(FP),
  placeOrder: jest.fn(),
  getOrderByReference: jest.fn(),
  getProduct: jest.fn(),
  getProductForRedeem: jest.fn(),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9990001111', name: '' };

const ago = (ms: number) => new Date(Date.now() - ms);
const OLD = HUBBLE_NO_ORDER_REFUND_MIN_AGE_MS + 5 * 60 * 1000;
const INDET = (over: Row = {}): Row => ({
  sellingValuePaise: 50000,
  hubbleNeedsReconcile: true,
  hubbleReconcileReason: 'HUBBLE_INDETERMINATE',
  hubbleReconcileAt: ago(OLD).toISOString(),
  ...over,
});

/** The stuck shape: place + recover failed → CONFIRMED, debited, flagged INDETERMINATE, no code. */
const stuckRow = (over: Row = {}): Row => {
  const createdAt = ago(OLD);
  return {
    id: 'o1',
    orderNumber: 'BAJAJ-26-000032',
    partnerId: 'cp1',
    status: 'CONFIRMED',
    voucherCode: null,
    voucherPin: null,
    voucherProvider: null,
    supplierOrderRef: null,
    pointsDeducted: 500,
    valuePaise: 50000n,
    redemptionMode: 'GIFT_CARD',
    createdAt,
    updatedAt: createdAt,
    metadata: INDET(),
    ...over,
  };
};

const auditsOf = (event: string) =>
  mockPrisma.auditLog.create.mock.calls.filter(
    (c) => (c[0] as { data: { metadata: { event: string } } }).data.metadata.event === event,
  );
const meta = () => row.metadata as Row;

describe('Hubble "no order for reference" → fail + refund (ops retry only)', () => {
  let service: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: TenantSettingsService, useValue: {} },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: { sendOtp: jest.fn() } },
        { provide: HubbleService, useValue: mockHubble },
        { provide: GifsyRoleService, useValue: { getPermissions: jest.fn().mockResolvedValue(new Set()) } },
      ],
    }).compile();
    service = module.get(RewardsService);
    mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });
    mockHubble.isConfigured.mockReturnValue(true);
    mockHubble.accountFingerprint.mockReturnValue(FP);
    row = stuckRow();
  });

  it('ops retry: not-found + old enough → FAILED, ONE refund (re-read amount), audit, notification, flag cleared, no Hubble stamp', async () => {
    mockHubble.getOrderByReference.mockResolvedValue(null);

    const res = await service.retryHubbleReconcile(gifsy, 'o1');

    expect(res).toEqual({ orderId: 'o1', outcome: 'REFUNDED_NO_HUBBLE_ORDER' });
    expect(mockHubble.placeOrder).not.toHaveBeenCalled();
    expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    expect(mockWallet.reverse).toHaveBeenCalledWith(
      'cp1', 500, { referenceId: 'o1', description: 'Refund BAJAJ-26-000032 (voucher not issued)' }, mockPrisma,
    );
    expect(row).toMatchObject({
      status: 'FAILED', pointsDeducted: 0, valuePaise: 0n, cancelReason: HUBBLE_NO_ORDER_REFUND_REASON,
      voucherProvider: null, // L8: no 'Hubble' stamp — no Hubble order exists
    });
    expect(meta()).toMatchObject({
      hubbleNeedsReconcile: false,
      hubbleReconcileResolution: 'REFUNDED_NO_HUBBLE_ORDER',
      hubbleNoOrderRefund: { by: 'admin1', previousReason: 'HUBBLE_INDETERMINATE', pointsRefunded: 500 },
      sellingValuePaise: 50000,
    });
    expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.redemptionStatusHistory.create.mock.calls[0][0].data).toMatchObject({
      fromStatus: 'CONFIRMED', toStatus: 'FAILED', changedById: 'admin1',
    });
    expect(auditsOf('HUBBLE_NO_ORDER_REFUNDED')).toHaveLength(1);
    expect(auditsOf('HUBBLE_NO_ORDER_REFUNDED')[0][0].data).toMatchObject({
      actorId: 'admin1',
      metadata: { reason: 'Hubble confirmed no order for this reference — refunded', pointsRefunded: 500, source: 'OPS_RETRY' },
    });
    expect(auditsOf('HUBBLE_RECONCILE_RETRY')[0][0].data.metadata).toMatchObject({ outcome: 'REFUNDED_NO_HUBBLE_ORDER' });
    // L7: order number + date, no "Please try again".
    expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
    const n = mockNotifications.notifyUserWithChannels.mock.calls[0][0];
    expect(n).toMatchObject({
      clientId: 'bajaj', userId: 'owner-user', eventKey: 'REDEMPTION_FAILED', recipientPhone: '9990002222',
      vars: expect.objectContaining({ points: 500, rewardName: 'Amazon ₹500', orderId: 'BAJAJ-26-000032' }),
    });
    expect(n.body).toMatch(/^Your Amazon ₹500 redemption BAJAJ-26-000032 from \d{2} [A-Z][a-z]{2} \d{4} couldn't be completed\. 500 points have been returned to your wallet\.$/);
    expect(n.body).not.toMatch(/try again/i);
  });

  it('L2: the refund amount is the value RE-READ inside the transaction', async () => {
    mockHubble.getOrderByReference.mockImplementation(async () => {
      row.pointsDeducted = 400; // same row version (no updatedAt change) — the in-tx read must win
      return null;
    });
    expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
    expect(mockWallet.reverse).toHaveBeenCalledWith('cp1', 400, expect.anything(), mockPrisma);
    expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].vars.points).toBe(400);
  });

  describe('H1: the WEBHOOK path never refunds', () => {
    it('webhook + not-found → no refund, flagged HUBBLE_WEBHOOK_BUT_NOT_FOUND; a later ops retry is then not refundable', async () => {
      mockHubble.getOrderByReference.mockResolvedValue(null);

      expect(await service.reconcileHubbleOrder('o1')).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'CONFIRMED', pointsDeducted: 500 });
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_BUT_NOT_FOUND' });

      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('explicit source WEBHOOK with an actor still never refunds', async () => {
      mockHubble.getOrderByReference.mockResolvedValue(null);
      expect(await service.reconcileHubbleOrder('o1', { actorId: 'admin1', source: 'WEBHOOK' })).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });
  });

  describe('M2: HUBBLE_UNEXPECTED needs place-attempt evidence', () => {
    it('UNEXPECTED with no place-attempt record → NOT refundable', async () => {
      row = stuckRow({ metadata: INDET({ hubbleReconcileReason: 'HUBBLE_UNEXPECTED' }) });
      mockHubble.getOrderByReference.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('UNEXPECTED where placeOrder was called and never responded → refunded', async () => {
      row = stuckRow({ metadata: INDET({
        hubbleReconcileReason: 'HUBBLE_UNEXPECTED', hubblePlaceAttemptAt: ago(OLD).toISOString(), hubblePlaceResponded: false, hubbleAccount: FP,
      }) });
      mockHubble.getOrderByReference.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['placeOrder responded', { hubblePlaceResponded: true }],
      ['placeOrder returned a Hubble order id', { hubblePlaceResponded: false, hubblePlaceOrderId: 'hub-1' }],
    ])('UNEXPECTED / INDETERMINATE where %s → NOT refundable', async (_n, ev) => {
      for (const reason of ['HUBBLE_UNEXPECTED', 'HUBBLE_INDETERMINATE']) {
        row = stuckRow({ metadata: INDET({ hubbleReconcileReason: reason, hubblePlaceAttemptAt: ago(OLD).toISOString(), ...ev }) });
        mockHubble.getOrderByReference.mockResolvedValue(null);
        expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      }
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });
  });

  describe('M1: Hubble account fingerprint', () => {
    it('placed on a DIFFERENT Hubble account / base URL → NOT refundable', async () => {
      row = stuckRow({ metadata: INDET({ hubbleAccount: 'api.myhubble.money#ffffffffffffffff' }) });
      mockHubble.getOrderByReference.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('same account → refunded; legacy order with no recorded account → refunded', async () => {
      for (const m of [INDET({ hubbleAccount: FP }), INDET()]) {
        jest.clearAllMocks();
        row = stuckRow({ metadata: m });
        mockHubble.getOrderByReference.mockResolvedValue(null);
        expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
        expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
      }
    });
  });

  it.each([
    ['created 5 min ago', () => stuckRow({ createdAt: ago(5 * 60 * 1000), updatedAt: ago(5 * 60 * 1000) })],
    ['old order, failed attempt flagged 10 min ago', () => stuckRow({ metadata: INDET({ hubbleReconcileAt: ago(10 * 60 * 1000).toISOString() }) })],
    ['old order, place attempt started 10 min ago', () => stuckRow({ metadata: INDET({ hubblePlaceAttemptAt: ago(10 * 60 * 1000).toISOString(), hubblePlaceResponded: false }) })],
    ['no createdAt on the row', () => ({ ...stuckRow(), createdAt: undefined })],
  ])('not-found but too young (%s) → still pending, no refund', async (_n, make) => {
    row = make();
    mockHubble.getOrderByReference.mockResolvedValue(null);

    const res = await service.retryHubbleReconcile(gifsy, 'o1');

    expect(res.outcome).toBe('PENDING_NO_HUBBLE_ORDER_TOO_RECENT');
    expect(mockWallet.reverse).not.toHaveBeenCalled();
    expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'CONFIRMED', pointsDeducted: 500 });
    expect(meta().hubbleNeedsReconcile).toBe(true);
    expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
  });

  it.each([
    ['auth failure', new Error('Hubble auth failed (HTTP 502)')],
    ['5xx', new Error('Hubble getOrderByReference HTTP 503')],
    ['timeout', new Error('Hubble request failed: Hubble did not respond within 15s')],
    ['401 after re-auth', new Error('Hubble getOrderByReference HTTP 401')],
    ['an unrecognised (HTML / gateway) 404', new Error('Hubble getOrderByReference HTTP 404 with an unrecognised body (not a Hubble error) — indeterminate')],
  ])('%s on get-by-reference → still PENDING_RECONCILE, no refund', async (_n, err) => {
    mockHubble.getOrderByReference.mockRejectedValue(err);

    const res = await service.retryHubbleReconcile(gifsy, 'o1');

    expect(res.outcome).toBe('PENDING_RECONCILE');
    expect(mockWallet.reverse).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'CONFIRMED', pointsDeducted: 500 });
    expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
  });

  it.each([
    ['PROCESSING locally (Hubble acknowledged it once)', { status: 'PROCESSING', voucherProvider: 'Hubble' }],
    ['a Hubble order id in metadata', { metadata: INDET({ hubbleOrderId: 'hub-1' }) }],
    ['a supplierOrderRef', { supplierOrderRef: 'hub-1' }],
    ['a voucher code on the order', { voucherCode: 'MANUAL-1' }],
    ['a reason that proves Hubble answered before (SUCCESS_NO_CODE)', { metadata: INDET({ hubbleReconcileReason: 'HUBBLE_SUCCESS_NO_CODE' }) }],
    ['HUBBLE_PROCESSING_NOT_FOUND', { metadata: INDET({ hubbleReconcileReason: 'HUBBLE_PROCESSING_NOT_FOUND' }) }],
    ['no reconcile flag at all', { metadata: {} }],
    ['no row version (updatedAt) to pin the refund to', { updatedAt: undefined }],
  ])('L9: not-found but NOT provably un-acknowledged (%s) → its own outcome, no refund', async (_n, over) => {
    row = stuckRow(over as Row);
    mockHubble.getOrderByReference.mockResolvedValue(null);

    expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
    expect(mockWallet.reverse).not.toHaveBeenCalled();
    expect(row.pointsDeducted).toBe(500);
  });

  it('concurrent triple ops retry → exactly ONE refund, one FAILED row, one audit, one notification', async () => {
    mockHubble.getOrderByReference.mockResolvedValue(null);

    const outs = await Promise.all([1, 2, 3].map(() => service.retryHubbleReconcile(gifsy, 'o1').then((r) => r.outcome)));

    expect(outs.filter((o) => o === 'REFUNDED_NO_HUBBLE_ORDER')).toHaveLength(1);
    expect(outs.filter((o) => o !== 'REFUNDED_NO_HUBBLE_ORDER').every((o) => o === 'SKIPPED')).toBe(true);
    expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(auditsOf('HUBBLE_NO_ORDER_REFUNDED')).toHaveLength(1);
    expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
  });

  it.each([
    ['a concurrent reconcile flag (HUBBLE_UNKNOWN_STATUS) written after the read', () => {
      row.metadata = { ...meta(), hubbleReconcileReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD' };
      row.updatedAt = new Date(Date.now() + 999);
    }],
    ['a Hubble PROCESSING stamp landing after the read', () => {
      Object.assign(row, { status: 'PROCESSING', voucherProvider: 'Hubble', supplierOrderRef: 'hub-9', updatedAt: new Date(Date.now() + 999) });
    }],
  ])('H2: %s makes the refund lose (no refund, metadata not overwritten)', async (_n, mutate) => {
    let concurrent: unknown;
    mockHubble.getOrderByReference.mockImplementation(async () => {
      mutate();
      concurrent = structuredClone(row.metadata); // what the concurrent writer left
      return null;
    });

    expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('PENDING_RECONCILE');
    expect(mockWallet.reverse).not.toHaveBeenCalled();
    expect(row.pointsDeducted).toBe(500);
    expect(row.metadata).toEqual(concurrent); // never overwritten from the stale read
  });

  it.each([
    ['DELIVERED with a code', { status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Hubble' }],
    ['already refunded (FAILED, 0 points)', { status: 'FAILED', pointsDeducted: 0 }],
  ])('%s → SKIPPED no-op (no Hubble call, no refund)', async (_n, over) => {
    row = stuckRow(over as Row);
    mockHubble.getOrderByReference.mockResolvedValue(null);

    const res = await service.retryHubbleReconcile(gifsy, 'o1');

    expect(res.outcome).toBe('SKIPPED');
    expect(mockHubble.getOrderByReference).not.toHaveBeenCalled();
    expect(mockWallet.reverse).not.toHaveBeenCalled();
    expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
  });

  describe('place-time evidence (issueHubbleVoucherForOrder)', () => {
    beforeEach(() => {
      row = stuckRow({ createdAt: new Date(), updatedAt: new Date(), metadata: { sellingValuePaise: 50000 } });
      mockHubble.getProduct.mockResolvedValue({
        productId: 'amz-1', name: 'Amazon', denominationType: 'FLEXIBLE', denominations: [], minValue: 1, maxValue: 100000, maxVouchersPerOrder: 1,
      });
    });

    it('place + recover both fail → attempt recorded (not responded, account fingerprint) + INDETERMINATE; refundable once old enough', async () => {
      mockHubble.placeOrder.mockRejectedValue(new Error('Hubble auth failed (HTTP 502)'));
      mockHubble.getOrderByReference.mockRejectedValueOnce(new Error('Hubble auth failed (HTTP 502)'));

      expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('PENDING_RECONCILE');
      expect(meta()).toMatchObject({
        hubblePlaceResponded: false, hubbleAccount: FP, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE',
      });
      expect(typeof meta().hubblePlaceAttemptAt).toBe('string');
      expect(mockWallet.reverse).not.toHaveBeenCalled();

      // 35 minutes later, ops retry → Hubble's not-found → refunded.
      const back = ago(OLD).toISOString();
      Object.assign(row, { createdAt: ago(OLD) });
      row.metadata = { ...meta(), hubblePlaceAttemptAt: back, hubbleReconcileAt: back };
      mockHubble.getOrderByReference.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    it('placeOrder responds (PROCESSING) → responded + Hubble order id recorded; the PROCESSING claim still wins (row version kept in step)', async () => {
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'hub-7' });

      expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('PROCESSING');
      expect(row.status).toBe('PROCESSING');
      expect(meta()).toMatchObject({ hubblePlaceResponded: true, hubblePlaceOrderId: 'hub-7', hubbleAccount: FP, hubbleStatus: 'PROCESSING' });
      expect(meta().hubbleNeedsReconcile).toBeUndefined(); // no CLAIM_LOST flag
    });
  });

  describe('late Hubble webhook after the no-order refund', () => {
    const SECRET = 'test-webhook-secret';
    let controller: HubbleWebhookController;
    const signed = (payload: unknown) => {
      const raw = Buffer.from(JSON.stringify(payload));
      return { raw, sig: createHmac('sha256', SECRET).update(raw).digest('base64') };
    };
    const send = async (payload: Row = { referenceId: 'o1' }) => {
      const { raw, sig } = signed(payload);
      return controller.webhook({ rawBody: raw } as never, payload, sig);
    };
    const refundFirst = async () => {
      mockHubble.getOrderByReference.mockResolvedValueOnce(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      jest.clearAllMocks();
      mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });
    };

    beforeEach(() => {
      process.env.HUBBLE_WEBHOOK_SECRET = SECRET;
      controller = new HubbleWebhookController(service);
    });
    afterEach(() => {
      delete process.env.HUBBLE_WEBHOOK_SECRET;
    });

    it('Hubble now reports SUCCESS → never delivered / re-refunded; HUBBLE_ISSUED_AFTER_REFUND + check stored (no code); ops retry says ALREADY_REFUNDED_FLAGGED', async () => {
      await refundFirst();
      mockHubble.getOrderByReference.mockResolvedValue({
        status: 'SUCCESS', id: 'hub-late', vouchers: [{ cardNumber: 'CARD-LATE', cardPin: '1234', cardType: 'CARD_AND_PIN_NO_SECURED' }],
      });

      const res = await send({ referenceId: 'o1', status: 'SUCCESS' });

      expect(res).toEqual({ ok: true, reconciled: true, outcome: 'SKIPPED' });
      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0, voucherCode: null, voucherPin: null });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
      expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true,
        hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND',
        hubbleReconcileResolution: 'REFUNDED_NO_HUBBLE_ORDER',
        hubbleLateWebhookCheck: { status: 'SUCCESS', hubbleOrderId: 'hub-late', voucherExists: true },
      });
      expect(JSON.stringify(row.metadata)).not.toMatch(/CARD-LATE|1234/);
      expect(auditsOf('HUBBLE_LATE_WEBHOOK_AFTER_NO_ORDER_REFUND')).toHaveLength(1);

      // L1: an ops retry on it is NOT "nothing to do".
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('ALREADY_REFUNDED_FLAGGED');
      expect(mockWallet.reverse).not.toHaveBeenCalled();

      // A later FAILED / not-found webhook never auto-clears the high-severity flag.
      mockHubble.getOrderByReference.mockResolvedValue({ status: 'FAILED' });
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
    });

    it('lookup fails → HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND; a later webhook where Hubble says FAILED / not-found clears it automatically', async () => {
      await refundFirst();
      mockHubble.getOrderByReference.mockRejectedValueOnce(new Error('Hubble getOrderByReference HTTP 503'));
      expect((await send()).outcome).toBe('SKIPPED');
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND', hubbleLateWebhookCheck: { status: 'LOOKUP_FAILED' },
      });

      mockHubble.getOrderByReference.mockResolvedValueOnce(null);
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleLateWebhookCheck: { status: 'NOT_FOUND', voucherExists: false } });

      // FAILED clears too (re-flag first).
      mockHubble.getOrderByReference.mockRejectedValueOnce(new Error('down'));
      await send();
      expect(meta().hubbleNeedsReconcile).toBe(true);
      mockHubble.getOrderByReference.mockResolvedValueOnce({ status: 'FAILED', id: 'hub-x' });
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleLateWebhookCheck: { status: 'FAILED', hubbleOrderId: 'hub-x' } });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
    });

    it('a webhook for an ordinary Hubble-FAILED (not no-order) refunded order is a silent SKIPPED as before', async () => {
      row = stuckRow({ status: 'FAILED', pointsDeducted: 0, metadata: { hubbleStatus: 'FAILED' } });
      expect((await send()).outcome).toBe('SKIPPED');
      expect(mockHubble.getOrderByReference).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });
  });

  describe('acknowledgeHubbleFlag ("Acknowledge — resolved")', () => {
    const flagged = (reason: string) =>
      stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: reason, hubbleReconcileResolution: 'REFUNDED_NO_HUBBLE_ORDER' },
      });

    it.each(['HUBBLE_ISSUED_AFTER_REFUND', 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND'])('GIFSY_ADMIN clears %s with a note (audited)', async (reason) => {
      row = flagged(reason);
      const res = await service.acknowledgeHubbleFlag(gifsy, 'o1', '  Checked Hubble portal — no voucher  ');
      expect(res).toEqual({ order: { id: 'o1', hubbleNeedsReconcile: false, hubbleReconcileReason: null } });
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: false,
        hubbleAcknowledged: { by: 'admin1', note: 'Checked Hubble portal — no voucher', reason },
      });
      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
      expect(auditsOf('HUBBLE_FLAG_ACKNOWLEDGED')[0][0].data).toMatchObject({ actorId: 'admin1', metadata: { reason } });
    });

    it('rejects a non-GIFSY_ADMIN, a blank note, and any other flag (e.g. an open INDETERMINATE order)', async () => {
      row = flagged('HUBBLE_ISSUED_AFTER_REFUND');
      const staff = { ...gifsy, role: 'GIFSY_STAFF' } as JwtPayload;
      await expect(service.acknowledgeHubbleFlag(staff, 'o1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.acknowledgeHubbleFlag(gifsy, 'o1', '   ')).rejects.toBeInstanceOf(BadRequestException);
      row = stuckRow(); // CONFIRMED + INDETERMINATE — must go through retry, never acknowledge
      await expect(service.acknowledgeHubbleFlag(gifsy, 'o1', 'x')).rejects.toBeInstanceOf(BadRequestException);
      expect(meta().hubbleNeedsReconcile).toBe(true);
      expect(auditsOf('HUBBLE_FLAG_ACKNOWLEDGED')).toHaveLength(0);
    });
  });
});
