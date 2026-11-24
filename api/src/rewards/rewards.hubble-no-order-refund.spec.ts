// Hubble "no order for this reference" → fail + refund (owner-approved 2026-11-15; dual-audit fixes).
// Stuck orders (BAJAJ-26-000032/38/39): place + recover both failed (HUBBLE_INDETERMINATE), points
// debited, no code; an OPS "Retry with Hubble" that gets Hubble's not-found must refund exactly once.
// The prisma mock is a STATEFUL single row: update/updateMany evaluate their where-clause against the
// row and mutate it synchronously (bumping updatedAt like Prisma's @updatedAt), and transactions are
// SERIALISED (Postgres keeps the row lock of the first claim until commit) — so races are real.
// Run: npx jest src/rewards/rewards.hubble-no-order-refund.spec.ts

import { createHmac } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  HUBBLE_NO_ORDER_REFUND_MIN_AGE_MS,
  HUBBLE_NO_ORDER_REFUND_REASON,
  HUBBLE_PENDING_MEMBER_COPY,
  RewardsService,
  hubbleReconcileFlags,
} from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { HubblePlaceOrderRejectedError, HubbleService } from '../hubble/hubble.service';
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
    // The CANARY query (a delivered Hubble order of the same tenant).
    findMany: jest.fn(async () => canaryRows),
  },
  redemptionStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  // Last-resort ATOMIC jsonb merge (`metadata || patch`) — values: [json, now, id]; OPEN = still open.
  $executeRaw: jest.fn(async (strings: TemplateStringsArray | { strings: string[] }, ...vals: unknown[]) => {
    // DELIVERED moves also snapshot the TDS payee (owner rule 2026-11-18; a Prisma.sql object) — not the metadata merge.
    if (!Array.isArray(strings) && (strings as { strings?: string[] }).strings?.join('?').includes('"payeePan"')) return 1;
    const sql = (strings as TemplateStringsArray).join('?');
    if (sql.includes('voucherIssuedNotifiedFp')) {
      // Once-only VOUCHER_ISSUED marker (audit A): [fp, at, id, fp] — CAS on the stored fingerprint.
      const [fp, at, mid] = vals as [string, string, string];
      if (mid !== row.id) return 0;
      const m0 = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Row;
      if (m0.voucherIssuedNotifiedFp === fp) return 0;
      row.metadata = { ...m0, voucherIssuedNotifiedFp: fp, voucherIssuedNotifiedAt: at };
      return 1;
    }
    const id = vals[vals.length - 1] as string;
    const now = vals[vals.length - 2] as Date;
    if (id !== row.id) return 0;
    const base = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Row;
    const st = row.status as string;
    const terminal = ['FAILED', 'CANCELLED', 'RETURNED'].includes(st);
    const openStatus = ['CONFIRMED', 'PROCESSING', 'PENDING'].includes(st);
    const di = ['HUBBLE_SUCCESS_MANUAL_CODE_PRESENT', 'HUBBLE_PROCESSING_AFTER_MANUAL', 'HUBBLE_FAILED_VOUCHER_PRESENT'];
    const flagged = base.hubbleNeedsReconcile === true;
    let patch: Row;
    if (vals.length === 7) {
      // atomicFlagOrder: [issuedOnTerminal, terminalJson, latestJson, terminalJson, openJson, now, id]
      const [issued, terminalJson, latestJson, , openJson] = vals as [boolean, string, string, string, string];
      if (terminal && flagged && base.hubbleReconcileReason === 'HUBBLE_ISSUED_AFTER_REFUND') patch = {};
      else if (terminal && issued) {
        patch = {
          ...JSON.parse(terminalJson),
          ...(flagged ? { hubbleSupersededReason: base.hubbleReconcileReason ?? null } : {}),
          ...(flagged && di.includes(base.hubbleReconcileReason as string) ? { hubbleDoubleIssueSeen: true } : {}),
        };
      } else if (flagged && di.includes(base.hubbleReconcileReason as string)) patch = JSON.parse(latestJson);
      else if (terminal) patch = JSON.parse(terminalJson);
      else if (openStatus) patch = JSON.parse(openJson);
      else patch = {};
    } else {
      // atomicMergeOrderMetadata: [json, now, id]
      if (sql.includes("IN ('CONFIRMED', 'PROCESSING', 'PENDING')") && !openStatus) return 0;
      patch = JSON.parse(vals[0] as string) as Row;
    }
    row.metadata = { ...base, ...patch };
    row.updatedAt = now;
    return 1;
  }),
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
/** The canary: a DELIVERED Hubble order of the same tenant that Hubble really holds. */
const CANARY_ID = 'c1';
const CANARY_BODY = { status: 'SUCCESS', id: 'hub-c1', referenceId: CANARY_ID, vouchers: [{ cardNumber: 'CARD-C1' }] };
const canaryRow = (over: Row = {}) => ({
  id: CANARY_ID, supplierOrderRef: 'hub-c1', metadata: { hubbleAccount: FP }, partner: { clientId: 'bajaj' }, ...over,
});
let canaryRows: Row[] = [];
/** What Hubble answers for the canary reference (programmable per test). */
const canaryLookup = jest.fn();
/** What Hubble answers for the order under test (o1) — tests program THIS one. */
const o1Lookup = jest.fn();
const mockHubble = {
  isConfigured: jest.fn().mockReturnValue(true),
  accountFingerprint: jest.fn().mockReturnValue(FP),
  placeOrder: jest.fn(),
  getOrderByReference: jest.fn(async (ref: string) => (ref === 'o1' ? o1Lookup(ref) : canaryLookup(ref))),
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
    canaryRows = [canaryRow()];
    canaryLookup.mockReset();
    canaryLookup.mockResolvedValue(CANARY_BODY);
    o1Lookup.mockReset();
    row = stuckRow();
  });

  it('ops retry: not-found + old enough → FAILED, ONE refund (re-read amount), audit, notification, flag cleared, no Hubble stamp', async () => {
    o1Lookup.mockResolvedValue(null);

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
    o1Lookup.mockImplementation(async () => {
      row.pointsDeducted = 400; // same row version (no updatedAt change) — the in-tx read must win
      return null;
    });
    expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
    expect(mockWallet.reverse).toHaveBeenCalledWith('cp1', 400, expect.anything(), mockPrisma);
    expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].vars.points).toBe(400);
  });

  describe('H1: the WEBHOOK path never refunds', () => {
    it('webhook + not-found → no refund, flagged HUBBLE_WEBHOOK_BUT_NOT_FOUND; a later ops retry is then not refundable', async () => {
      o1Lookup.mockResolvedValue(null);

      expect(await service.reconcileHubbleOrder('o1')).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'CONFIRMED', pointsDeducted: 500 });
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_BUT_NOT_FOUND' });

      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('explicit source WEBHOOK with an actor still never refunds', async () => {
      o1Lookup.mockResolvedValue(null);
      expect(await service.reconcileHubbleOrder('o1', { actorId: 'admin1', source: 'WEBHOOK' })).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });
  });

  describe('M2: HUBBLE_UNEXPECTED needs place-attempt evidence', () => {
    it('UNEXPECTED with no place-attempt record → NOT refundable', async () => {
      row = stuckRow({ metadata: INDET({ hubbleReconcileReason: 'HUBBLE_UNEXPECTED' }) });
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('UNEXPECTED where placeOrder was called and never responded → refunded', async () => {
      row = stuckRow({ metadata: INDET({
        hubbleReconcileReason: 'HUBBLE_UNEXPECTED', hubblePlaceAttemptAt: ago(OLD).toISOString(), hubblePlaceResponded: false, hubbleAccount: FP,
      }) });
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['placeOrder responded', { hubblePlaceResponded: true }],
      ['placeOrder returned a Hubble order id', { hubblePlaceResponded: false, hubblePlaceOrderId: 'hub-1' }],
    ])('UNEXPECTED / INDETERMINATE where %s → NOT refundable', async (_n, ev) => {
      for (const reason of ['HUBBLE_UNEXPECTED', 'HUBBLE_INDETERMINATE']) {
        row = stuckRow({ metadata: INDET({ hubbleReconcileReason: reason, hubblePlaceAttemptAt: ago(OLD).toISOString(), ...ev }) });
        o1Lookup.mockResolvedValue(null);
        expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      }
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });
  });

  describe('M1: Hubble account fingerprint', () => {
    it('placed on a DIFFERENT Hubble account / base URL → NOT refundable', async () => {
      row = stuckRow({ metadata: INDET({ hubbleAccount: 'api.myhubble.money#ffffffffffffffff' }) });
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('same account → refunded; legacy order with no recorded account → refunded', async () => {
      for (const m of [INDET({ hubbleAccount: FP }), INDET()]) {
        jest.clearAllMocks();
        row = stuckRow({ metadata: m });
        o1Lookup.mockResolvedValue(null);
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
    o1Lookup.mockResolvedValue(null);

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
    o1Lookup.mockRejectedValue(err);

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
    o1Lookup.mockResolvedValue(null);

    expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
    expect(mockWallet.reverse).not.toHaveBeenCalled();
    expect(row.pointsDeducted).toBe(500);
  });

  it('concurrent triple ops retry → exactly ONE refund, one FAILED row, one audit, one notification', async () => {
    o1Lookup.mockResolvedValue(null);

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
    o1Lookup.mockImplementation(async () => {
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
    ['DELIVERED with a code', { status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Hubble' }, 'SKIPPED'],
    ['already refunded (FAILED, 0 points) — unflagged', { status: 'FAILED', pointsDeducted: 0, metadata: {} }, 'SKIPPED'],
    // A legacy FAILED order still carrying its open INDETERMINATE flag: not "nothing to do" — flagged (Acknowledge clears it).
    ['already refunded (FAILED, 0 points) — still flagged', { status: 'FAILED', pointsDeducted: 0 }, 'ALREADY_REFUNDED_FLAGGED'],
  ])('%s → no-op (no Hubble call, no refund)', async (_n, over, outcome) => {
    row = stuckRow(over as Row);
    o1Lookup.mockResolvedValue(null);

    const res = await service.retryHubbleReconcile(gifsy, 'o1');

    expect(res.outcome).toBe(outcome);
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
      o1Lookup.mockRejectedValueOnce(new Error('Hubble auth failed (HTTP 502)'));

      expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('PENDING_INDETERMINATE');
      expect(meta()).toMatchObject({
        hubblePlaceResponded: false, hubbleAccount: FP, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE',
      });
      expect(typeof meta().hubblePlaceAttemptAt).toBe('string');
      expect(mockWallet.reverse).not.toHaveBeenCalled();

      // 2 hours (+5 min) later, ops retry → Hubble's not-found (canary verified) → refunded.
      const back = ago(OLD).toISOString();
      Object.assign(row, { createdAt: ago(OLD) });
      row.metadata = { ...meta(), hubblePlaceAttemptAt: back, hubbleReconcileAt: back };
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    const confirmVia = () =>
      (service as unknown as {
        finishHubbleConfirm: (o: unknown, c: unknown) => Promise<{ status: string; message: string }>;
      }).finishHubbleConfirm(
        { id: 'o1', orderNumber: 'BAJAJ-26-000032' },
        { clientId: 'bajaj', actorId: 'u1', notifyUserId: 'owner-user', recipientPhone: null, ownerName: 'O', rewardName: 'Amazon ₹500', points: 500 },
      );
    const PENDING_COPY =
      'Redemption confirmed. Your voucher is taking longer than usual — we’re checking with the voucher provider. It will appear in your orders once issued; our team will follow up if there’s a problem.';

    it('H1: placeOrder TIMES OUT + Hubble 404 on recovery → NO refund at confirm (pending copy); retry before 2 h → too recent; after 2 h + canary → refunded ONCE', async () => {
      mockHubble.placeOrder.mockRejectedValue(new Error('Hubble request failed: Hubble did not respond within 15s'));
      o1Lookup.mockResolvedValue(null); // Hubble has not persisted the order (yet)

      const res = await confirmVia();
      expect(res).toEqual({ orderId: 'o1', status: 'CONFIRMED', message: PENDING_COPY });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(canaryLookup).not.toHaveBeenCalled(); // not even considered at confirm time
      expect(row).toMatchObject({ status: 'CONFIRMED', pointsDeducted: 500 });
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE', hubblePlaceResponded: false });

      // 1 h 55 min later: still too recent for the ops refund (2-hour gate).
      const at = (ms: number) => ago(ms).toISOString();
      Object.assign(row, { createdAt: ago(115 * 60 * 1000) });
      row.metadata = { ...meta(), hubblePlaceAttemptAt: at(115 * 60 * 1000), hubbleReconcileAt: at(115 * 60 * 1000) };
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('PENDING_NO_HUBBLE_ORDER_TOO_RECENT');
      expect(mockWallet.reverse).not.toHaveBeenCalled();

      // 2 h 5 min later, canary verified → refunded exactly once (a second retry is a no-op).
      Object.assign(row, { createdAt: ago(OLD) });
      row.metadata = { ...meta(), hubblePlaceAttemptAt: at(OLD), hubbleReconcileAt: at(OLD) };
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('SKIPPED');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
    });

    it('the refund age gate is 2 hours', () => {
      expect(HUBBLE_NO_ORDER_REFUND_MIN_AGE_MS).toBe(2 * 60 * 60 * 1000);
    });

    it.each([
      ['5xx', new Error('Hubble placeOrder non-success HTTP 503')],
      ['network', new Error('Hubble request failed: fetch failed')],
      ['an unrecognised 4xx (409)', new Error('Hubble placeOrder non-success HTTP 409')],
    ])('H1: placeOrder %s + recovery 404 → no refund, PENDING_INDETERMINATE', async (_n, err) => {
      mockHubble.placeOrder.mockRejectedValue(err);
      o1Lookup.mockResolvedValue(null);
      expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('PENDING_INDETERMINATE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' });
    });

    it('a DEFINITIVE 4xx rejection + recovery 404 + canary verified → refunded immediately; stamped so a late webhook is re-checked + flagged', async () => {
      mockHubble.placeOrder.mockRejectedValue(new HubblePlaceOrderRejectedError(400, 'E102'));
      o1Lookup.mockResolvedValue(null);
      expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('FAILED_REFUNDED');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
      expect(canaryLookup).toHaveBeenCalledWith(CANARY_ID);
      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: false,
        hubbleReconcileResolution: 'FAILED_REFUNDED',
        hubbleRefund: { previousReason: null, reason: expect.stringMatching(/E102/) },
      });

      // Hubble issues it anyway — the webhook is re-checked against Hubble and flagged, never silently skipped.
      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'hub-late', vouchers: [{ cardNumber: 'CARD-LATE' }] });
      expect(await service.reconcileHubbleOrder('o1')).toBe('SKIPPED');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
      expect(row.voucherCode).toBeNull();
    });

    it('a DEFINITIVE 4xx rejection whose "not found" is unverified (no canary) → NOT refunded; INDETERMINATE + recorded; pending copy', async () => {
      canaryRows = [];
      mockHubble.placeOrder.mockRejectedValue(new HubblePlaceOrderRejectedError(422, 'E102'));
      o1Lookup.mockResolvedValue(null);
      const res = await confirmVia();
      expect(res).toEqual({ orderId: 'o1', status: 'CONFIRMED', message: PENDING_COPY });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE',
        hubbleNoOrderUnverified: { source: 'CONFIRM', canaryOrderId: null },
      });
      expect(auditsOf('HUBBLE_NO_ORDER_UNVERIFIED')).toHaveLength(1);
    });

    it('Hubble FAILED body at placement → refunded + stamped; a later SUCCESS webhook → HUBBLE_ISSUED_AFTER_REFUND (not silently skipped)', async () => {
      row.metadata = { ...meta(), hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' }; // an open flag gets closed
      mockHubble.placeOrder.mockResolvedValue({ status: 'FAILED', id: 'hub-f', failureReason: 'out of stock' });
      expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('FAILED_REFUNDED');
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: false, hubbleReconcileResolution: 'FAILED_REFUNDED',
        hubbleRefund: { reason: 'out of stock', previousReason: 'HUBBLE_INDETERMINATE' },
      });

      // A FAILED webhook just confirms it (re-checked, nothing flagged).
      o1Lookup.mockResolvedValue({ status: 'FAILED', id: 'hub-f' });
      await service.reconcileHubbleOrder('o1');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleLateWebhookCheck: { status: 'FAILED' } });
      // …but if Hubble later reports SUCCESS → flagged for ops.
      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'hub-f', vouchers: [{ cardNumber: 'X' }] });
      await service.reconcileHubbleOrder('o1');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    it('5: confirm-time canary is capped at 2 candidates → fails closed into PENDING_INDETERMINATE (ops retry still tries 5)', async () => {
      canaryRows = ['k1', 'k2', 'k3'].map((id) => canaryRow({ id, supplierOrderRef: `hub-${id}` }));
      canaryLookup.mockImplementation(async (ref: string) => (ref === 'k3' ? { status: 'SUCCESS', id: 'hub-k3', referenceId: 'k3' } : null));
      mockHubble.placeOrder.mockRejectedValue(new HubblePlaceOrderRejectedError(400, 'E102'));
      o1Lookup.mockResolvedValue(null);
      expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('PENDING_INDETERMINATE');
      expect(canaryLookup.mock.calls.map((c) => c[0])).toEqual(['k1', 'k2']);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(meta()).toMatchObject({ hubbleReconcileReason: 'HUBBLE_INDETERMINATE', hubbleNoOrderUnverified: { source: 'CONFIRM' } });
    });

    it('5: confirm-time canary has a ~20 s total budget → a hung lookup fails closed (no refund)', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        canaryLookup.mockImplementation(() => new Promise(() => undefined)); // never answers
        mockHubble.placeOrder.mockRejectedValue(new HubblePlaceOrderRejectedError(400, 'E102'));
        o1Lookup.mockResolvedValue(null);
        const run = service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1');
        await jest.advanceTimersByTimeAsync(21_000);
        expect(await run).toBe('PENDING_INDETERMINATE');
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        expect(String((meta().hubbleNoOrderUnverified as Row).why)).toMatch(/budget/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('4: confirm copy — PROCESSING keeps "shortly"; a stuck state (not configured) gets the pending copy', async () => {
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'hub-7' });
      expect((await confirmVia()).message).toBe('Redemption confirmed. Your voucher is being issued and will appear shortly.');

      row = stuckRow({ createdAt: new Date(), updatedAt: new Date(), metadata: { sellingValuePaise: 50000 } });
      mockHubble.isConfigured.mockReturnValue(false);
      const res = await confirmVia();
      expect(res).toEqual({ orderId: 'o1', status: 'CONFIRMED', message: HUBBLE_PENDING_MEMBER_COPY });
      expect(res.message).not.toMatch(/shortly/);
    });

    it('4: a SKIPPED confirm reports the REAL state — refunded → FAILED copy; delivered → issued copy', async () => {
      row = stuckRow({ status: 'FAILED', pointsDeducted: 0, metadata: {} });
      expect(await confirmVia()).toMatchObject({ status: 'FAILED', message: expect.stringMatching(/points have been refunded/) });

      row = stuckRow({ status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Hubble', metadata: {} });
      const notify = jest
        .spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
        .mockResolvedValue(undefined);
      expect(await confirmVia()).toMatchObject({ status: 'DELIVERED', message: expect.stringMatching(/has been issued/) });
      notify.mockRestore();
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
      o1Lookup.mockResolvedValueOnce(null);
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
      o1Lookup.mockResolvedValue({
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
      o1Lookup.mockResolvedValue({ status: 'FAILED' });
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
    });

    it('lookup fails → HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND; a signed webhook + "not found" is a contradiction (kept); only Hubble FAILED clears it', async () => {
      await refundFirst();
      o1Lookup.mockRejectedValueOnce(new Error('Hubble getOrderByReference HTTP 503'));
      expect((await send()).outcome).toBe('SKIPPED');
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND', hubbleLateWebhookCheck: { status: 'LOOKUP_FAILED' },
      });

      // A signed webhook but Hubble's lookup says "no order" → NOT cleared.
      o1Lookup.mockResolvedValueOnce(null);
      await send();
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND', hubbleLateWebhookCheck: { status: 'NOT_FOUND', voucherExists: false },
      });

      // Hubble's own FAILED clears it.
      o1Lookup.mockResolvedValueOnce({ status: 'FAILED', id: 'hub-x' });
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleLateWebhookCheck: { status: 'FAILED', hubbleOrderId: 'hub-x' } });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
    });

    it('a signed webhook + "not found" on an UNFLAGGED refunded order RAISES the unknown flag (contradiction)', async () => {
      await refundFirst();
      o1Lookup.mockResolvedValueOnce(null);
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND' });
    });

    it('6: an order refunded on Hubble\'s OWN FAILED body — a FAILED webhook needs no lookup; an unreachable Hubble is only logged', async () => {
      row = stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleReconcileResolution: 'FAILED_REFUNDED', hubbleRefund: { source: 'HUBBLE_FAILED', reason: 'x' } },
      });
      expect((await send({ referenceId: 'o1', status: 'FAILED' })).outcome).toBe('SKIPPED');
      expect(mockHubble.getOrderByReference).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();

      // Any refund + a FAILED webhook + Hubble down → only logged (the signed webhook itself says FAILED).
      row = stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleReconcileResolution: 'FAILED_REFUNDED', hubbleRefund: { source: 'REJECTED', reason: 'x' } },
      });
      o1Lookup.mockRejectedValueOnce(new Error('HTTP 503'));
      await send({ referenceId: 'o1', status: 'FAILED' });
      expect(meta()).toMatchObject({ hubbleLateWebhookCheck: { status: 'LOOKUP_FAILED' } });
      expect(meta().hubbleNeedsReconcile).toBeUndefined();
    });

    describe('R5-1: a non-FAILED webhook on a refunded order is NEVER quiet when Hubble can\'t be checked', () => {
      const failedBodyRefund = () =>
        stuckRow({
          status: 'FAILED', pointsDeducted: 0,
          metadata: { hubbleReconcileResolution: 'FAILED_REFUNDED', hubbleRefund: { source: 'HUBBLE_FAILED', reason: 'x' } },
        });

      it.each(['SUCCESS', 'PROCESSING'])('Hubble-FAILED refund → signed %s webhook → lookup throws → HUBBLE_ISSUED_AFTER_REFUND', async (st) => {
        row = failedBodyRefund();
        o1Lookup.mockRejectedValue(new Error('Hubble request failed: Hubble did not respond within 15s'));
        expect((await send({ referenceId: 'o1', status: st })).outcome).toBe('SKIPPED');
        expect(meta()).toMatchObject({
          hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND',
          hubbleLateWebhookCheck: { status: `${st}_(WEBHOOK)` },
        });
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      it('Hubble not configured + a SUCCESS webhook → ISSUED too', async () => {
        row = failedBodyRefund();
        mockHubble.isConfigured.mockReturnValue(false);
        await send({ referenceId: 'o1', status: 'SUCCESS' });
        expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
      });

      it('a webhook with NO status + lookup throws → HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND (flagged, never quiet)', async () => {
        row = failedBodyRefund();
        o1Lookup.mockRejectedValue(new Error('HTTP 503'));
        await send({ referenceId: 'o1' });
        expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND' });
      });
    });

    it('a webhook for ANY refunded Hubble order (even legacy, unstamped) is re-checked — never silently skipped', async () => {
      row = stuckRow({ status: 'FAILED', pointsDeducted: 0, metadata: { hubbleStatus: 'FAILED' } });
      o1Lookup.mockResolvedValue({ status: 'FAILED', id: 'hub-f' });
      expect((await send()).outcome).toBe('SKIPPED');
      expect(mockHubble.getOrderByReference).toHaveBeenCalledWith('o1');
      expect(meta()).toMatchObject({ hubbleLateWebhookCheck: { status: 'FAILED' } });
      expect(meta().hubbleNeedsReconcile).toBeUndefined(); // nothing issued → nothing flagged

      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'hub-f', vouchers: [{ cardNumber: 'X' }] });
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('a CANCELLED (ops-refunded) Hubble order: a SUCCESS webhook is flagged HUBBLE_ISSUED_AFTER_REFUND', async () => {
      row = stuckRow({ status: 'CANCELLED', pointsDeducted: 0, metadata: {} });
      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'hub-c', vouchers: [{ cardNumber: 'X' }] });
      await send();
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
    });

    it('a webhook for a refunded NON-Hubble order (cash / no Hubble product) is not looked up', async () => {
      row = stuckRow({ status: 'FAILED', pointsDeducted: 0, metadata: {}, redemptionMode: 'BANK_TRANSFER' });
      expect((await send()).outcome).toBe('SKIPPED');
      expect(mockHubble.getOrderByReference).not.toHaveBeenCalled();
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
      expect(res).toEqual({ order: { id: 'o1', hubbleNeedsReconcile: false, hubbleReconcileReason: null, hubbleLatestReason: null } });
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: false,
        hubbleAcknowledged: { by: 'admin1', note: 'Checked Hubble portal — no voucher', reason },
      });
      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
      expect(auditsOf('HUBBLE_FLAG_ACKNOWLEDGED')[0][0].data).toMatchObject({ actorId: 'admin1', metadata: { reason } });
    });

    it('a legacy open-order flag left on a FAILED (refunded) order is acknowledgeable (Retry can\'t clear it)', async () => {
      row = flagged('HUBBLE_INDETERMINATE');
      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'checked portal');
      expect(meta().hubbleNeedsReconcile).toBe(false);
      expect(mockHubble.getOrderByReference).not.toHaveBeenCalled(); // no "Hubble has an order" reason → no pre-check
    });

    it.each(['HUBBLE_PROCESSING_CLAIM_LOST', 'HUBBLE_SUCCESS_NO_CODE', 'HUBBLE_UNKNOWN_STATUS:ON_HOLD'])(
      '7: %s on a refunded order → Hubble re-checked first: FAILED / not found → acknowledged',
      async (reason) => {
        row = flagged(reason);
        o1Lookup.mockResolvedValue({ status: 'FAILED', id: 'hub-x' });
        await service.acknowledgeHubbleFlag(gifsy, 'o1', 'checked portal');
        expect(mockHubble.getOrderByReference).toHaveBeenCalledWith('o1');
        expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleAcknowledged: { reason } });
      },
    );

    it('7: …Hubble reports an order (voucher) → flag becomes HUBBLE_ISSUED_AFTER_REFUND and the acknowledge is refused (409)', async () => {
      row = flagged('HUBBLE_PROCESSING_CLAIM_LOST');
      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'hub-x', vouchers: [{ cardNumber: 'C' }] });
      await expect(service.acknowledgeHubbleFlag(gifsy, 'o1', 'checked')).rejects.toBeInstanceOf(ConflictException);
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
      expect(auditsOf('HUBBLE_FLAG_ACKNOWLEDGED')).toHaveLength(0);
      // Ops now acknowledge the ISSUED flag itself.
      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'voucher cancelled with Hubble');
      expect(meta().hubbleNeedsReconcile).toBe(false);
    });

    it('7: …Hubble unreachable → refused (409), flag untouched', async () => {
      row = flagged('HUBBLE_SUCCESS_NO_CODE');
      o1Lookup.mockRejectedValue(new Error('HTTP 503'));
      await expect(service.acknowledgeHubbleFlag(gifsy, 'o1', 'x')).rejects.toBeInstanceOf(ConflictException);
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_SUCCESS_NO_CODE' });
    });

    it('R5-2: …Hubble unreachable + force → needs a ≥ 20-char note; then acknowledged, recorded as forced + audited', async () => {
      row = flagged('HUBBLE_SUCCESS_NO_CODE');
      o1Lookup.mockRejectedValue(new Error('HTTP 503'));
      await expect(service.acknowledgeHubbleFlag(gifsy, 'o1', 'too short', { force: true })).rejects.toBeInstanceOf(BadRequestException);
      expect(meta().hubbleNeedsReconcile).toBe(true);

      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'Hubble down all day; portal shows no voucher', { force: true });
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: false,
        hubbleAcknowledged: { forced: true, forcedBecause: 'Hubble unreachable', recheck: 'LOOKUP_FAILED', reason: 'HUBBLE_SUCCESS_NO_CODE' },
      });
      expect(auditsOf('HUBBLE_FLAG_ACKNOWLEDGED')[0][0].data.metadata).toMatchObject({ forced: true, recheck: 'LOOKUP_FAILED' });
    });

    it('R5-2: …force never bypasses a Hubble that REPORTS an order (still 409 + ISSUED)', async () => {
      row = flagged('HUBBLE_SUCCESS_NO_CODE');
      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'h', vouchers: [{ cardNumber: 'C' }] });
      await expect(
        service.acknowledgeHubbleFlag(gifsy, 'o1', 'Hubble down all day; portal shows no voucher', { force: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
    });

    it('R5-2: …Hubble NOT CONFIGURED in this environment → acknowledged, recorded recheck NOT_CONFIGURED', async () => {
      row = flagged('HUBBLE_PROCESSING_CLAIM_LOST');
      mockHubble.isConfigured.mockReturnValue(false);
      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'checked');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleAcknowledged: { recheck: 'NOT_CONFIGURED' } });
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

  describe('CANARY: a "not found" is trusted only when a KNOWN Hubble order is found through the same lookup', () => {
    const expectUnverified = async (whyPattern: RegExp) => {
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_UNVERIFIED');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'CONFIRMED', pointsDeducted: 500 });
      // Still flagged INDETERMINATE (retry-able later), with WHY recorded on the order + audited.
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' });
      expect((meta().hubbleNoOrderUnverified as Row).why).toMatch(whyPattern);
      expect(auditsOf('HUBBLE_NO_ORDER_UNVERIFIED')).toHaveLength(1);
      expect(auditsOf('HUBBLE_RECONCILE_RETRY')[0][0].data.metadata).toMatchObject({ outcome: 'NO_HUBBLE_ORDER_UNVERIFIED' });
      expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
    };

    it('the canary query spans tenants (credentials are platform-wide): delivered Hubble orders with a ref, never the order itself', async () => {
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ id: { not: 'o1' }, status: 'DELIVERED', supplierOrderRef: { not: null } });
      expect(where.partner).toBeUndefined();
      expect(canaryLookup).toHaveBeenCalledWith(CANARY_ID);
    });

    it('a canary of ANOTHER tenant on the SAME Hubble account verifies; another tenant on a DIFFERENT account / legacy (no fingerprint) does not', async () => {
      canaryRows = [canaryRow({ partner: { clientId: 'deoleo' } })];
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');

      for (const c of [
        canaryRow({ partner: { clientId: 'deoleo' }, metadata: { hubbleAccount: 'api.myhubble.money#ffffffffffffffff' } }),
        canaryRow({ partner: { clientId: 'deoleo' }, metadata: {} }),
      ]) {
        jest.clearAllMocks();
        row = stuckRow();
        canaryRows = [c];
        await expectUnverified(/no delivered Hubble order on this Hubble account/);
        expect(canaryLookup).not.toHaveBeenCalled();
      }
    });

    it('L1: tries up to 5 candidates newest-first, succeeds on the first that verifies', async () => {
      canaryRows = ['k1', 'k2', 'k3', 'k4', 'k5'].map((id) => canaryRow({ id, supplierOrderRef: `hub-${id}` }));
      canaryLookup.mockImplementation(async (ref: string) =>
        ref === 'k4' ? { status: 'SUCCESS', id: 'hub-k4', referenceId: 'k4' } : ref === 'k2' ? null : (() => { throw new Error('HTTP 503'); })(),
      );
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect(canaryLookup.mock.calls.map((c) => c[0])).toEqual(['k1', 'k2', 'k3', 'k4']);
    });

    it('L1: none of the first 5 verifies → fails closed (a 6th is never tried)', async () => {
      canaryRows = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((id) => canaryRow({ id, supplierOrderRef: `hub-${id}` }));
      canaryLookup.mockImplementation(async (ref: string) => (ref === 'k6' ? { status: 'SUCCESS', id: 'hub-k6', referenceId: 'k6' } : null));
      await expectUnverified(/no canary verified \(5 tried\)/);
      expect(canaryLookup.mock.calls.map((c) => c[0])).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
    });

    it('no canary order exists (no delivered Hubble order for this tenant) → NOT refunded', async () => {
      canaryRows = [];
      await expectUnverified(/no delivered Hubble order/);
      expect(canaryLookup).not.toHaveBeenCalled();
    });

    it('L3: markHubblePendingReconcile losing every compare-and-set still flags an OPEN order (atomic merge, other keys kept)', async () => {
      const realUpdate = mockPrisma.redemptionOrder.update.getMockImplementation()!;
      mockPrisma.redemptionOrder.update.mockImplementation(async () => { throw new Error('P2025'); });
      row = stuckRow({ metadata: { sellingValuePaise: 50000 } });
      mockHubble.placeOrder.mockRejectedValue(new Error('Hubble request failed: Hubble did not respond within 15s'));
      mockHubble.getProduct.mockResolvedValue({ productId: 'amz-1', name: 'A', denominationType: 'FLEXIBLE', denominations: [], minValue: 1, maxValue: 100000, maxVouchersPerOrder: 1 });
      o1Lookup.mockRejectedValue(new Error('down'));
      try {
        expect(await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1')).toBe('PENDING_INDETERMINATE');
      } finally {
        mockPrisma.redemptionOrder.update.mockImplementation(realUpdate);
      }
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
      expect(meta()).toMatchObject({ sellingValuePaise: 50000, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' });
    });

    it('canary lookup ALSO says "not found" (wrong route / gateway 404 masquerading) → NOT refunded', async () => {
      canaryLookup.mockResolvedValue(null);
      await expectUnverified(/also returned "not found"/);
    });

    it('canary lookup throws → NOT refunded', async () => {
      canaryLookup.mockRejectedValue(new Error('Hubble getOrderByReference HTTP 503'));
      await expectUnverified(/canary lookup failed/);
    });

    it.each([
      ['a non-SUCCESS status', { ...CANARY_BODY, status: 'PROCESSING' }],
      ['a different reference', { ...CANARY_BODY, referenceId: 'someone-else' }],
      ['a different Hubble order id', { ...CANARY_BODY, id: 'hub-other' }],
    ])('canary lookup returns %s → NOT refunded', async (_n, body) => {
      canaryLookup.mockResolvedValue(body);
      await expectUnverified(/canary lookup returned/);
    });

    it('a canary placed on a DIFFERENT Hubble account is skipped; a legacy (no-fingerprint) canary is used', async () => {
      canaryRows = [canaryRow({ metadata: { hubbleAccount: 'api.myhubble.money#ffffffffffffffff' } })];
      await expectUnverified(/no delivered Hubble order/);

      jest.clearAllMocks();
      row = stuckRow();
      canaryRows = [canaryRow({ id: 'c-other', metadata: { hubbleAccount: 'api.myhubble.money#ffffffffffffffff' } }), canaryRow({ metadata: {} })];
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect(canaryLookup).toHaveBeenCalledWith(CANARY_ID);
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });
  });

  describe('fingerprint format change (base-URL path now included)', () => {
    const PATH_FP = 'api.dev.myhubble.money/partner#0123456789abcdef';

    it('an order recorded in the OLD host-only format is compared on host + hash → still refundable', async () => {
      mockHubble.accountFingerprint.mockReturnValue(PATH_FP);
      canaryRows = [canaryRow({ metadata: { hubbleAccount: FP } })]; // canary recorded in the old format too
      row = stuckRow({ metadata: INDET({ hubbleAccount: FP }) });
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    it('a NEW-format fingerprint with a different base path → NOT refundable', async () => {
      mockHubble.accountFingerprint.mockReturnValue(PATH_FP);
      row = stuckRow({ metadata: INDET({ hubbleAccount: 'api.dev.myhubble.money/old-path#0123456789abcdef' }) });
      o1Lookup.mockResolvedValue(null);
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('an old host-only fingerprint on a DIFFERENT host or client hash → NOT refundable', async () => {
      mockHubble.accountFingerprint.mockReturnValue(PATH_FP);
      for (const acct of ['api.myhubble.money#0123456789abcdef', 'api.dev.myhubble.money#ffffffffffffffff']) {
        row = stuckRow({ metadata: INDET({ hubbleAccount: acct }) });
        o1Lookup.mockResolvedValue(null);
        expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      }
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });
  });

  describe('a Hubble webhook racing the ops no-order refund (lost claims)', () => {
    /** The ops refund commits while the webhook's Hubble lookup is in flight. */
    const refundLandsDuringLookup = () => {
      Object.assign(row, {
        status: 'FAILED', pointsDeducted: 0, valuePaise: 0n, updatedAt: new Date(Date.now() + 5000),
        metadata: { ...meta(), hubbleNeedsReconcile: false, hubbleReconcileResolution: 'REFUNDED_NO_HUBBLE_ORDER' },
      });
    };

    it.each([
      ['SUCCESS (storeHubbleSuccess lost claim)', { status: 'SUCCESS', id: 'hub-late', vouchers: [{ cardNumber: 'CARD-LATE', cardPin: '1234' }] }],
      ['PROCESSING (markHubbleProcessing lost claim)', { status: 'PROCESSING', id: 'hub-late' }],
    ])('Hubble %s → HUBBLE_ISSUED_AFTER_REFUND (ack-able), never CLAIM_LOST / PENDING_RECONCILE, never applied', async (_n, body) => {
      o1Lookup.mockImplementationOnce(async () => {
        refundLandsDuringLookup();
        return body;
      });
      o1Lookup.mockResolvedValue(body); // the late-webhook re-check

      expect(await service.reconcileHubbleOrder('o1')).toBe('SKIPPED');

      expect(row).toMatchObject({ status: 'FAILED', pointsDeducted: 0, voucherCode: null, voucherProvider: null });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true,
        hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND',
        hubbleReconcileResolution: 'REFUNDED_NO_HUBBLE_ORDER',
        hubbleLateWebhookCheck: { status: body.status, hubbleOrderId: 'hub-late' },
      });
      expect(JSON.stringify(row.metadata)).not.toMatch(/CARD-LATE|1234/);
      // Ops can clear it (the flag is one acknowledge accepts).
      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'checked portal');
      expect(meta().hubbleNeedsReconcile).toBe(false);
    });

    it('a webhook not-found racing the refund → post-refund flag (not the open-order WEBHOOK_BUT_NOT_FOUND); refund record kept', async () => {
      o1Lookup.mockImplementationOnce(async () => {
        refundLandsDuringLookup();
        return null;
      });
      expect(await service.reconcileHubbleOrder('o1')).toBe('NO_HUBBLE_ORDER_NOT_REFUNDABLE');
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true,
        hubbleReconcileReason: 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND',
        hubbleRaceReason: 'HUBBLE_WEBHOOK_BUT_NOT_FOUND',
        hubbleReconcileResolution: 'REFUNDED_NO_HUBBLE_ORDER',
      });
      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'checked portal');
      expect(meta().hubbleNeedsReconcile).toBe(false);
    });

    it('a racing open-order flag never downgrades HUBBLE_ISSUED_AFTER_REFUND', async () => {
      o1Lookup.mockImplementationOnce(async () => {
        refundLandsDuringLookup();
        row.metadata = { ...meta(), hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' };
        return null;
      });
      await service.reconcileHubbleOrder('o1');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
    });
  });

  describe('1: a Hubble delivery closes pending-type flags (a DELIVERED order is never stuck flagged)', () => {
    const SUCCESS = { status: 'SUCCESS', id: 'hub-ok', vouchers: [{ cardNumber: 'CARD-OK' }] };

    it.each(['HUBBLE_INDETERMINATE', 'HUBBLE_UNEXPECTED', 'HUBBLE_WEBHOOK_BUT_NOT_FOUND', 'HUBBLE_SUCCESS_NO_CODE', 'HUBBLE_PROCESSING_CLAIM_LOST'])(
      'flagged %s → Hubble SUCCESS webhook delivers it AND clears the flag (resolution DELIVERED)',
      async (reason) => {
        row = stuckRow({ metadata: INDET({ hubbleReconcileReason: reason }) });
        o1Lookup.mockResolvedValue(SUCCESS);
        expect(await service.reconcileHubbleOrder('o1')).toBe('DELIVERED');
        expect(row).toMatchObject({ status: 'DELIVERED', voucherCode: 'CARD-OK' });
        expect(meta()).toMatchObject({
          hubbleNeedsReconcile: false, hubbleReconcileResolution: 'DELIVERED', hubbleResolvedPreviousReason: reason,
        });
        expect(hubbleReconcileFlags(row.metadata).hubbleNeedsReconcile).toBe(false);
      },
    );

    it('a double-issuance flag (PROCESSING_AFTER_MANUAL) stays on the delivered order; Retry skips it, Acknowledge clears it', async () => {
      row = stuckRow({ metadata: INDET({ hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL' }) });
      o1Lookup.mockResolvedValue(SUCCESS);
      expect(await service.reconcileHubbleOrder('o1')).toBe('DELIVERED');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL' });
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('SKIPPED');
      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'only one voucher was used');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleAcknowledged: { reason: 'HUBBLE_PROCESSING_AFTER_MANUAL' } });
    });

    it.each([
      ['a MANUAL_OVERRIDE takeover', { hubbleStatus: 'MANUAL_OVERRIDE' }],
      ['a RELEASED order', { hubbleStatus: 'RELEASED' }],
      ['an earlier double-issuance reason (sticky marker)', { hubbleDoubleIssueSeen: true }],
      ['an acknowledged double-issuance reason', { hubbleAcknowledged: { reason: 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT' } }],
    ])('R5-3: a delivery does NOT close the flag on %s', async (_n, extra) => {
      row = stuckRow({ metadata: INDET({ ...extra }) });
      o1Lookup.mockResolvedValue(SUCCESS);
      expect(await service.reconcileHubbleOrder('o1')).toBe('DELIVERED');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' });
    });

    it('R5-3: a later reason never overwrites an OPEN double-issuance flag (kept; newer one stored as hubbleLatestReason)', async () => {
      row = stuckRow({ metadata: INDET({ hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL' }) });
      o1Lookup.mockResolvedValue({ status: 'ON_HOLD', id: 'h' }); // → HUBBLE_UNKNOWN_STATUS:ON_HOLD
      await service.reconcileHubbleOrder('o1');
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true,
        hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL',
        hubbleLatestReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD',
      });
    });

    it('R5-3: raising a double-issuance reason sets the sticky hubbleDoubleIssueSeen marker', async () => {
      row = stuckRow({ status: 'CONFIRMED', voucherCode: 'MANUAL-1', metadata: {} });
      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'h', vouchers: [{ cardNumber: 'HUB-1' }] });
      await service.reconcileHubbleOrder('o1'); // claim refused (code on the order) → SUCCESS_MANUAL_CODE_PRESENT
      expect(meta()).toMatchObject({ hubbleReconcileReason: 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT', hubbleDoubleIssueSeen: true });
    });

    it('R5-3: the CAS-exhausted fallback also keeps an open double-issuance reason', async () => {
      const realUpdate = mockPrisma.redemptionOrder.update.getMockImplementation()!;
      mockPrisma.redemptionOrder.update.mockImplementation(async () => { throw new Error('P2025'); });
      row = stuckRow({ metadata: INDET({ hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL' }) });
      o1Lookup.mockResolvedValue({ status: 'ON_HOLD', id: 'h' });
      try {
        await service.reconcileHubbleOrder('o1');
      } finally {
        mockPrisma.redemptionOrder.update.mockImplementation(realUpdate);
      }
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL', hubbleLatestReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD',
      });
    });

    it('R6-M1: on a REFUNDED order a "Hubble has an order" reason supersedes an open double-issuance flag → HUBBLE_ISSUED_AFTER_REFUND', async () => {
      row = stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_FAILED_VOUCHER_PRESENT', hubbleReconcileResolution: 'FAILED_REFUNDED' },
      });
      await (service as unknown as { markHubblePendingReconcile: (id: string, r: string) => Promise<void> })
        .markHubblePendingReconcile('o1', 'HUBBLE_SUCCESS_NO_CODE');
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true,
        hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND',
        hubbleSupersededReason: 'HUBBLE_FAILED_VOUCHER_PRESENT',
        hubbleDoubleIssueSeen: true,
      });
      expect(meta().hubbleLatestReason).toBeUndefined();
    });

    it('R6-M1: …but a lower-severity unknown reason on that refunded order keeps the double-issuance flag (newer stored)', async () => {
      row = stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_FAILED_VOUCHER_PRESENT' },
      });
      await (service as unknown as { markHubblePendingReconcile: (id: string, r: string) => Promise<void> })
        .markHubblePendingReconcile('o1', 'HUBBLE_WEBHOOK_BUT_NOT_FOUND');
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_FAILED_VOUCHER_PRESENT', hubbleLatestReason: 'HUBBLE_WEBHOOK_BUT_NOT_FOUND',
      });
    });

    it('R6-M1: the CAS-exhausted single-statement fallback applies the SAME terminal rule (ISSUED wins)', async () => {
      const realUpdate = mockPrisma.redemptionOrder.update.getMockImplementation()!;
      mockPrisma.redemptionOrder.update.mockImplementation(async () => { throw new Error('P2025'); });
      row = stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL', keep: 1 },
      });
      try {
        await (service as unknown as { markHubblePendingReconcile: (id: string, r: string) => Promise<void> })
          .markHubblePendingReconcile('o1', 'HUBBLE_UNKNOWN_STATUS:ON_HOLD');
      } finally {
        mockPrisma.redemptionOrder.update.mockImplementation(realUpdate);
      }
      expect(meta()).toMatchObject({
        keep: 1,
        hubbleNeedsReconcile: true,
        hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND',
        hubbleSupersededReason: 'HUBBLE_PROCESSING_AFTER_MANUAL',
        hubbleDoubleIssueSeen: true,
      });
      const sql = (mockPrisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
      expect(sql).toMatch(/WHERE "id" = \?$/); // terminal orders are no longer excluded by a status filter
    });

    it('R6-M1: Acknowledge of FAILED_VOUCHER_PRESENT on a refunded order re-checks Hubble first (voucher → ISSUED + 409)', async () => {
      row = stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_FAILED_VOUCHER_PRESENT' },
      });
      o1Lookup.mockResolvedValue({ status: 'SUCCESS', id: 'h', vouchers: [{ cardNumber: 'C' }] });
      await expect(service.acknowledgeHubbleFlag(gifsy, 'o1', 'checked')).rejects.toBeInstanceOf(ConflictException);
      expect(mockHubble.getOrderByReference).toHaveBeenCalledWith('o1');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
    });

    it('R6-M2: acknowledging the double-issuance flag RE-RAISES the newer recorded reason (not cleared), audited; the next ack clears', async () => {
      row = stuckRow({
        status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Hubble',
        metadata: {
          hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL',
          hubbleLatestReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD', hubbleLatestReasonAt: 'x',
        },
      });
      expect(hubbleReconcileFlags(row.metadata)).toMatchObject({ hubbleLatestReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD' });

      const res = await service.acknowledgeHubbleFlag(gifsy, 'o1', 'one voucher used');
      expect(res).toEqual({ order: { id: 'o1', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD', hubbleLatestReason: null } });
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD', hubbleLatestReason: null,
        hubbleAcknowledged: { reason: 'HUBBLE_PROCESSING_AFTER_MANUAL' },
      });
      expect(auditsOf('HUBBLE_FLAG_ACKNOWLEDGED')[0][0].data.metadata).toMatchObject({ reRaised: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD' });

      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'status resolved in portal');
      expect(meta().hubbleNeedsReconcile).toBe(false);
    });

    it('acknowledge on a DELIVERED order with any leftover flag is accepted', async () => {
      row = stuckRow({ status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Hubble', metadata: INDET() });
      await service.acknowledgeHubbleFlag(gifsy, 'o1', 'delivered fine');
      expect(meta().hubbleNeedsReconcile).toBe(false);
    });
  });

  describe('projection + low-level guards', () => {
    it('10: the console projection carries WHY a "no order" was not trusted, only while flagged', () => {
      const m = { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE', hubbleNoOrderUnverified: { why: 'no canary verified (2 tried)' } };
      expect(hubbleReconcileFlags(m)).toEqual({
        hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE', hubbleNoOrderUnverifiedWhy: 'no canary verified (2 tried)',
      });
      expect(hubbleReconcileFlags({ ...m, hubbleNeedsReconcile: false })).toEqual({ hubbleNeedsReconcile: false, hubbleReconcileReason: null });
    });

    it('8: the atomic merge treats a non-object metadata as {} (CASE WHEN jsonb_typeof)', async () => {
      // Unflagged start: re-raising an ALREADY-open reason is a no-op now (audit F), so no write would happen.
      row = stuckRow({ metadata: { sellingValuePaise: 50000 } });
      const realUpdate = mockPrisma.redemptionOrder.update.getMockImplementation()!;
      mockPrisma.redemptionOrder.update.mockImplementation(async () => { throw new Error('P2025'); });
      mockHubble.placeOrder.mockRejectedValue(new Error('Hubble request failed: Hubble did not respond within 15s'));
      mockHubble.getProduct.mockResolvedValue({ productId: 'amz-1', name: 'A', denominationType: 'FLEXIBLE', denominations: [], minValue: 1, maxValue: 100000, maxVouchersPerOrder: 1 });
      o1Lookup.mockRejectedValue(new Error('down'));
      try {
        await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1');
      } finally {
        mockPrisma.redemptionOrder.update.mockImplementation(realUpdate);
      }
      const sql = (mockPrisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
      expect(sql).toMatch(/CASE WHEN jsonb_typeof\("metadata"\) = 'object' THEN "metadata" ELSE '\{\}'::jsonb END/);
    });

    it('9: the canary query requires deliveredAt and puts the account fingerprint (current + legacy host-only form) in SQL', async () => {
      mockHubble.accountFingerprint.mockReturnValue('api.dev.myhubble.money/partner#0123456789abcdef');
      canaryRows = [canaryRow()];
      o1Lookup.mockResolvedValue(null);
      await service.retryHubbleReconcile(gifsy, 'o1');
      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where.deliveredAt).toEqual({ not: null });
      expect(where.OR).toEqual([
        { metadata: { path: ['hubbleAccount'], equals: 'api.dev.myhubble.money/partner#0123456789abcdef' } },
        { metadata: { path: ['hubbleAccount'], equals: 'api.dev.myhubble.money#0123456789abcdef' } },
        { partner: { clientId: 'bajaj' } },
      ]);
    });
  });

  describe('late-webhook check never clears a concurrently-raised HUBBLE_ISSUED_AFTER_REFUND', () => {
    const refunded = (reason: string) =>
      stuckRow({
        status: 'FAILED', pointsDeducted: 0,
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: reason, hubbleReconcileResolution: 'REFUNDED_NO_HUBBLE_ORDER' },
      });

    it('ISSUED raised by a concurrent webhook while this check looked Hubble up → not cleared', async () => {
      row = refunded('HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND');
      o1Lookup.mockImplementationOnce(async () => {
        row.metadata = { ...meta(), hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' };
        row.updatedAt = new Date(Date.now() + 7000);
        return null; // this check sees "not found" → would clear the UNKNOWN flag
      });
      await service.reconcileHubbleOrder('o1');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' });
    });

    it('ISSUED written between the check\'s read and its write → the CAS loses, re-evaluates, does not clear', async () => {
      row = refunded('HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND');
      o1Lookup.mockResolvedValue({ status: 'FAILED', id: 'hub-x' });
      const realUpdate = mockPrisma.redemptionOrder.update.getMockImplementation()!;
      mockPrisma.redemptionOrder.update.mockImplementationOnce(async (args) => {
        // A concurrent webhook commits ISSUED first (new row version)…
        row.metadata = { ...meta(), hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND' };
        row.updatedAt = new Date(Date.now() + 9000);
        return realUpdate(args); // …so this version-pinned write misses (P2025)
      });

      await service.reconcileHubbleOrder('o1');

      expect(mockPrisma.redemptionOrder.update).toHaveBeenCalledTimes(2); // lost once, re-read + re-evaluated
      expect(meta()).toMatchObject({
        hubbleNeedsReconcile: true,
        hubbleReconcileReason: 'HUBBLE_ISSUED_AFTER_REFUND',
        hubbleLateWebhookCheck: { status: 'FAILED', hubbleOrderId: 'hub-x' },
      });
    });

    it('without contention the unknown flag still auto-clears on FAILED', async () => {
      row = refunded('HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND');
      o1Lookup.mockResolvedValue({ status: 'FAILED' });
      await service.reconcileHubbleOrder('o1');
      expect(meta().hubbleNeedsReconcile).toBe(false);
    });
  });
  // ── Automatic re-check (source SWEEP, owner 2026-11-24) ─────────────────────────────────────────
  describe('source SWEEP (automatic re-check)', () => {
    const SUCCESS_BODY = { status: 'SUCCESS', id: 'hub-o1', referenceId: 'o1', vouchers: [{ cardNumber: 'CARD-O1' }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ro = mockPrisma.redemptionOrder as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cl = mockPrisma.client as any;
    beforeEach(() => {
      // notifyVoucherIssued (shared) self-loads the order + the client label.
      ro.findUnique = jest.fn(async () => snapshot());
      cl.findUnique = jest.fn(async () => ({ branding: null, internalName: 'Bajaj' }));
      // The prod incident shape: place timed out, recover found Hubble PROCESSING → PROCESSING, unflagged.
      row = stuckRow({
        status: 'PROCESSING',
        voucherProvider: 'Hubble',
        fulfilmentChannel: 'DIGITAL_VOUCHER',
        metadata: { sellingValuePaise: 50000, hubblePlaceAttemptAt: ago(30 * 60_000).toISOString(), hubblePlaceResponded: false, hubbleStatus: 'PROCESSING', hubbleOrderId: '01M85ZNA' },
      });
    });
    afterEach(() => {
      delete ro.findUnique;
      delete cl.findUnique;
    });

    it('Hubble SUCCESS → DELIVERED with the code, history says "auto re-check", member gets the VOUCHER_ISSUED notification once', async () => {
      o1Lookup.mockResolvedValue(SUCCESS_BODY);
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(outcome).toBe('DELIVERED');
      expect(row).toMatchObject({ status: 'DELIVERED', voucherCode: 'CARD-O1', voucherProvider: 'Hubble' });
      expect(mockHubble.placeOrder).not.toHaveBeenCalled();
      const notes = mockPrisma.redemptionStatusHistory.create.mock.calls.map((c) => (c[0] as { data: { notes?: string } }).data.notes);
      expect(notes).toContain('Hubble voucher issued (auto re-check)');
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
      expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0]).toMatchObject({ eventKey: 'VOUCHER_ISSUED', userId: 'owner-user' });
    });

    it('a stale flag (HUBBLE_PROCESSING_STALE) is cleared by a later SUCCESS the usual way', async () => {
      row.metadata = { ...(row.metadata as Row), hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_STALE' };
      o1Lookup.mockResolvedValue(SUCCESS_BODY);
      await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(row.status).toBe('DELIVERED');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: false, hubbleResolvedPreviousReason: 'HUBBLE_PROCESSING_STALE' });
    });

    it('the webhook path now notifies too (same code): SUCCESS via webhook → one VOUCHER_ISSUED', async () => {
      o1Lookup.mockResolvedValue(SUCCESS_BODY);
      await service.reconcileHubbleOrder('o1', { webhookStatus: 'SUCCESS' });
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
      expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].eventKey).toBe('VOUCHER_ISSUED');
    });

    it('Hubble still PROCESSING → unchanged, no notification, no refund', async () => {
      o1Lookup.mockResolvedValue({ status: 'PROCESSING', id: 'hub-o1', referenceId: 'o1' });
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(outcome).toBe('PROCESSING');
      expect(row.status).toBe('PROCESSING');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
    });

    it('Hubble says NO ORDER → the sweep NEVER refunds (left for ops), even for an old order', async () => {
      row = stuckRow(); // old, CONFIRMED, INDETERMINATE — the ops retry WOULD refund this one
      o1Lookup.mockResolvedValue(null);
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(outcome).toBe('PENDING_RECONCILE');
      expect(row.status).toBe('CONFIRMED');
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('a Hubble lookup error → PENDING_RECONCILE (kept for the next sweep), nothing written', async () => {
      o1Lookup.mockRejectedValue(new Error('Hubble did not respond within 15s'));
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(outcome).toBe('PENDING_RECONCILE');
      expect(row.status).toBe('PROCESSING');
    });

    it('Hubble FAILED → refunded through the usual path', async () => {
      o1Lookup.mockResolvedValue({ status: 'FAILED', id: 'hub-o1', referenceId: 'o1', failureReason: 'out of stock' });
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(outcome).toBe('FAILED_REFUNDED');
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    // ── Audit fix round ─────────────────────────────────────────────────────────────────────────
    const voucherIssuedSends = () =>
      mockNotifications.notifyUserWithChannels.mock.calls.filter((c) => (c[0] as { eventKey: string }).eventKey === 'VOUCHER_ISSUED');

    it('A: a reconcile that LOSES the claim (confirm already delivered it) sends NO second voucher message', async () => {
      // The order is already DELIVERED by the confirm path (which notified); Retry read it a moment earlier.
      const stale = snapshot();
      row.status = 'DELIVERED';
      row.voucherCode = 'CARD-O1';
      o1Lookup.mockResolvedValue(SUCCESS_BODY);
      mockPrisma.redemptionOrder.findFirst
        .mockImplementationOnce(async () => snapshot()) // owner / tenant
        .mockImplementationOnce(async () => stale); // loadHubbleOrder: stale PROCESSING view
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'OPS_RETRY', actorId: 'admin1' });
      expect(outcome).toBe('DELIVERED');
      expect(voucherIssuedSends()).toHaveLength(0);
    });

    it('A: the confirm path notifies only as the winner, and a second notify for the SAME code is suppressed (once-only marker)', async () => {
      mockHubble.getProduct.mockResolvedValue({ productId: 'amz-1', name: 'A', denominationType: 'FLEXIBLE', denominations: [], minValue: 1, maxValue: 100000, maxVouchersPerOrder: 1 });
      row = stuckRow({ metadata: { sellingValuePaise: 50000 } }); // CONFIRMED, unflagged, about to be placed
      mockHubble.placeOrder.mockResolvedValue(SUCCESS_BODY);
      const outcome = await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'u1');
      expect(outcome).toBe('DELIVERED');
      expect(voucherIssuedSends()).toHaveLength(1);
      expect(meta().voucherIssuedNotifiedFp).toEqual(expect.any(String));
      expect(JSON.stringify(meta())).not.toContain('CARD-O1'); // a hash, never the code
      // Any other path asking to notify for the same code now (e.g. a racing webhook) → suppressed.
      await (service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }).notifyVoucherIssued('o1', 'bajaj');
      expect(voucherIssuedSends()).toHaveLength(1);
      // A PIN added later is a new credential → sent again.
      row.voucherPin = '1234';
      await (service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }).notifyVoucherIssued('o1', 'bajaj');
      expect(voucherIssuedSends()).toHaveLength(2);
    });

    it('B: a refund on Hubble FAILED via reconcile notifies the member (REDEMPTION_FAILED) once; a lost refund does not', async () => {
      o1Lookup.mockResolvedValue({ status: 'FAILED', id: 'hub-o1', referenceId: 'o1', failureReason: 'out of stock' });
      await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      const failed = () =>
        mockNotifications.notifyUserWithChannels.mock.calls.filter((c) => (c[0] as { eventKey: string }).eventKey === 'REDEMPTION_FAILED');
      expect(failed()).toHaveLength(1);
      expect(failed()[0][0]).toMatchObject({ userId: 'owner-user', vars: { points: 500, orderId: 'BAJAJ-26-000032' } });
      // Again (already FAILED + refunded): resolved → nothing more.
      await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(failed()).toHaveLength(1);
    });

    it('C: the re-check flags an UNFLAGGED "no order" order (process died mid-place) HUBBLE_INDETERMINATE — never refunds', async () => {
      row = stuckRow({ metadata: { sellingValuePaise: 50000, hubblePlaceAttemptAt: ago(OLD).toISOString(), hubblePlaceResponded: false } });
      o1Lookup.mockResolvedValue(null);
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(outcome).toBe('PENDING_RECONCILE');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      // …and ops Retry can refund it under the existing evidence + age + canary rules: not before 2 h after
      // the flag (the age counts from the later of created / place attempt / flag) …
      expect((await service.retryHubbleReconcile(gifsy, 'o1')).outcome).toBe('PENDING_NO_HUBBLE_ORDER_TOO_RECENT');
      // … and once that has passed, it is refunded.
      row.metadata = { ...meta(), hubbleReconcileAt: ago(OLD).toISOString() };
      const res = await service.retryHubbleReconcile(gifsy, 'o1');
      expect(res.outcome).toBe('REFUNDED_NO_HUBBLE_ORDER');
    });

    it('C: Hubble had acknowledged the order (PROCESSING before) → "no order" is a contradiction: HUBBLE_PROCESSING_NOT_FOUND', async () => {
      o1Lookup.mockResolvedValue(null); // the beforeEach row: PROCESSING, hubbleOrderId recorded, unflagged
      await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_NOT_FOUND' });
    });

    it('E: Hubble SUCCESS on an order already DELIVERED by hand (non-Hubble code) → double-issue flag, not "delivered"', async () => {
      const stale = snapshot();
      Object.assign(row, { status: 'DELIVERED', voucherCode: 'MANUAL-9', voucherProvider: 'Manual' });
      o1Lookup.mockResolvedValue(SUCCESS_BODY);
      mockPrisma.redemptionOrder.findFirst
        .mockImplementationOnce(async () => snapshot())
        .mockImplementationOnce(async () => stale);
      const outcome = await service.reconcileHubbleOrder('o1', { source: 'SWEEP' });
      expect(outcome).toBe('PENDING_RECONCILE');
      expect(meta()).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT' });
      expect(row.voucherCode).toBe('MANUAL-9');
      expect(voucherIssuedSends()).toHaveLength(0);
    });

    it('F: re-raising the SAME open reason writes nothing (no hubbleReconcileAt / updatedAt churn)', async () => {
      row = stuckRow(); // flagged HUBBLE_INDETERMINATE
      const before = { at: meta().hubbleReconcileAt, updatedAt: row.updatedAt };
      await (service as unknown as { markHubblePendingReconcile: (a: string, b: string) => Promise<void> }).markHubblePendingReconcile('o1', 'HUBBLE_INDETERMINATE');
      expect(meta().hubbleReconcileAt).toBe(before.at);
      expect(row.updatedAt).toBe(before.updatedAt);
    });
  });
});

