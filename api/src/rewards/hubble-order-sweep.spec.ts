// Automatic re-check of Hubble-handed orders (owner 2026-11-24, prod BAJAJ-26-000050).
// Pure due/back-off rules + the sweep's claim / isolation / stale-flag mechanics. The per-order
// Hubble status logic is NOT re-tested here — it is reconcileHubbleOrder's (see
// rewards.hubble-no-order-refund.spec.ts "source SWEEP").
// Run: npx jest src/rewards/hubble-order-sweep.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import {
  HUBBLE_PROCESSING_STALE_REASON,
  HUBBLE_SWEEP_BATCH,
  RewardsService,
  hubbleSweepDue,
  hubbleWaitInfo,
} from './rewards.service';
import { HubbleOrderSweep } from './hubble-order-sweep';
import { PrismaService } from '../prisma/prisma.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { HubbleService } from '../hubble/hubble.service';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const MIN = 60_000;
const at = (msAgo: number) => new Date(NOW - msAgo);
const iso = (msAgo: number) => at(msAgo).toISOString();

/** An open Hubble-handed order row as the claim query returns it. */
const cand = (id: string, handedAgo: number, lastSweepAgo?: number, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt: at(handedAgo + 5_000),
  metadata: {
    hubblePlaceAttemptAt: iso(handedAgo),
    ...(lastSweepAgo !== undefined ? { hubbleLastSweepAt: iso(lastSweepAgo) } : {}),
    ...extra,
  },
});

describe('hubbleSweepDue — age window + back-off', () => {
  it.each([
    ['handed 1 min ago (place call may be in flight)', cand('a', 1 * MIN), false],
    ['handed 3 min ago, never checked', cand('a', 3 * MIN), true],
    ['first hour: checked 1 min ago', cand('a', 20 * MIN, 1 * MIN), false],
    ['first hour: checked 2 min ago', cand('a', 20 * MIN, 2 * MIN), true],
    ['after 1 h: checked 5 min ago', cand('a', 3 * 60 * MIN, 5 * MIN), false],
    ['after 1 h: checked 15 min ago', cand('a', 3 * 60 * MIN, 15 * MIN), true],
    ['older than 7 days', cand('a', 7 * 24 * 60 * MIN + MIN), false],
  ])('%s → %s', (_l, order, due) => {
    expect(hubbleSweepDue(order, NOW)).toBe(due);
  });

  it('falls back to createdAt when the order has no place-attempt stamp (older Hubble orders)', () => {
    expect(hubbleSweepDue({ createdAt: at(10 * MIN), metadata: { hubbleStatus: 'PROCESSING' } }, NOW)).toBe(true);
    expect(hubbleSweepDue({ createdAt: at(1 * MIN), metadata: { hubbleStatus: 'PROCESSING' } }, NOW)).toBe(false);
  });
});

describe('hubbleWaitInfo — "Retry with Hubble" without a flag', () => {
  const base = { createdAt: at(40 * MIN), voucherCode: null, voucherProvider: null };
  it('handed (place attempt) + open → handed, with since / last checked', () => {
    expect(hubbleWaitInfo({ ...base, status: 'PROCESSING', metadata: { hubblePlaceAttemptAt: iso(30 * MIN), hubbleLastSweepAt: iso(MIN) } })).toEqual({
      hubbleHanded: true, hubbleWaitingSince: iso(30 * MIN), hubbleLastCheckedAt: iso(MIN),
    });
  });
  it.each([
    ['DELIVERED', { status: 'DELIVERED', metadata: { hubblePlaceAttemptAt: iso(MIN) } }],
    ['FAILED (terminal)', { status: 'FAILED', metadata: { hubblePlaceAttemptAt: iso(MIN) } }],
    ['a code is on it', { status: 'PROCESSING', voucherCode: 'X-1', metadata: { hubblePlaceAttemptAt: iso(MIN) } }],
    ['manual override', { status: 'PROCESSING', metadata: { hubblePlaceAttemptAt: iso(MIN), hubbleStatus: 'MANUAL_OVERRIDE' } }],
    ['never handed to Hubble (Deoleo-like)', { status: 'CONFIRMED', metadata: { sellingValuePaise: 100 } }],
  ])('%s → not handed', (_l, o) => {
    expect(hubbleWaitInfo({ ...base, ...o } as never).hubbleHanded).toBe(false);
  });
});

describe('RewardsService.sweepHubbleOrders', () => {
  let service: RewardsService;
  let candidates: ReturnType<typeof cand>[];
  let locked: boolean;
  let claimCalls: string[];
  let orderNow: Record<string, { status: string; voucherCode: string | null; createdAt: Date; metadata: Record<string, unknown> }>;
  const mockHubble = { isConfigured: jest.fn().mockReturnValue(true) };
  const auditCreate = jest.fn().mockResolvedValue({});

  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ locked }];
      return candidates;
    }),
    $executeRaw: jest.fn(async (_s: TemplateStringsArray, ...vals: unknown[]) => {
      const id = vals[1] as string; // [nowIso, id, prevStamp]
      claimCalls.push(id);
      return 1;
    }),
  };
  const mockPrisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    $executeRaw: jest.fn().mockReturnValue(Promise.resolve(1)),
    redemptionOrder: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        const o = orderNow[where.id];
        return o ? { id: where.id, orderNumber: `ORD-${where.id}`, ...o } : null;
      }),
    },
    auditLog: { create: auditCreate },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    locked = true;
    claimCalls = [];
    candidates = [];
    orderNow = {};
    mockHubble.isConfigured.mockReturnValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: {} },
        { provide: TenantSettingsService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: Msg91Service, useValue: {} },
        { provide: HubbleService, useValue: mockHubble },
        { provide: GifsyRoleService, useValue: {} },
      ],
    }).compile();
    service = module.get(RewardsService);
  });

  const openOrder = (handedAgo: number, meta: Record<string, unknown> = {}) => ({
    status: 'PROCESSING',
    voucherCode: null,
    createdAt: at(handedAgo + 5_000),
    metadata: { hubblePlaceAttemptAt: iso(handedAgo), ...meta },
  });

  it('picks only DUE orders, oldest-checked first, capped at the batch size; checks each via reconcileHubbleOrder(SWEEP)', async () => {
    candidates = [
      cand('young', 1 * MIN), // too young
      cand('recent', 20 * MIN, 1 * MIN), // first hour, checked 1 min ago
      ...Array.from({ length: HUBBLE_SWEEP_BATCH + 5 }, (_, i) => cand(`d${i}`, 10 * MIN)),
    ];
    const rec = jest.spyOn(service, 'reconcileHubbleOrder').mockResolvedValue('PROCESSING');
    const res = await service.sweepHubbleOrders(NOW);
    expect(res.claimed).toBe(HUBBLE_SWEEP_BATCH);
    expect(rec).toHaveBeenCalledTimes(HUBBLE_SWEEP_BATCH);
    expect(rec.mock.calls.map((c) => c[0])).toEqual(Array.from({ length: HUBBLE_SWEEP_BATCH }, (_, i) => `d${i}`));
    expect(rec.mock.calls[0][1]).toEqual({ source: 'SWEEP' });
    expect(claimCalls).not.toContain('young');
    expect(claimCalls).not.toContain('recent');
  });

  it('the candidate query only reads open (CONFIRMED / PROCESSING), code-less, Hubble-handed, non-manual orders', async () => {
    await service.sweepHubbleOrders(NOW);
    const sql = (tx.$queryRaw.mock.calls[1][0] as TemplateStringsArray).join('?');
    expect(sql).toContain(`"status"::text IN ('CONFIRMED', 'PROCESSING')`);
    expect(sql).toContain('"voucherCode" IS NULL');
    expect(sql).toContain(`'hubblePlaceAttemptAt'`);
    expect(sql).toContain(`NOT IN ('MANUAL_OVERRIDE', 'RELEASED')`);
    expect(sql).toContain(`ORDER BY ("metadata"->>'hubbleLastSweepAt') ASC NULLS FIRST`);
  });

  it('another instance holds the advisory lock → skipped, nothing claimed or checked', async () => {
    locked = false;
    candidates = [cand('d0', 10 * MIN)];
    const rec = jest.spyOn(service, 'reconcileHubbleOrder');
    const res = await service.sweepHubbleOrders(NOW);
    expect(res.skipped).toBe('LOCKED');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });

  it('an order whose CAS claim is lost (another instance took it) is not checked', async () => {
    candidates = [cand('d0', 10 * MIN), cand('d1', 10 * MIN)];
    tx.$executeRaw.mockImplementationOnce(async () => 0); // d0 lost
    const rec = jest.spyOn(service, 'reconcileHubbleOrder').mockResolvedValue('PROCESSING');
    await service.sweepHubbleOrders(NOW);
    expect(rec.mock.calls.map((c) => c[0])).toEqual(['d1']);
  });

  it('one order failing does not stop the rest, and the sweep never throws', async () => {
    candidates = [cand('d0', 10 * MIN), cand('d1', 10 * MIN), cand('d2', 10 * MIN)];
    const rec = jest
      .spyOn(service, 'reconcileHubbleOrder')
      .mockResolvedValueOnce('PROCESSING')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('DELIVERED');
    const res = await service.sweepHubbleOrders(NOW);
    expect(rec).toHaveBeenCalledTimes(3);
    expect(res.errors).toBe(1);
    expect(res.outcomes).toEqual({ PROCESSING: 1, DELIVERED: 1 });
  });

  it('a claim-phase DB error is swallowed (skipped: ERROR), never thrown', async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(service.sweepHubbleOrders(NOW)).resolves.toMatchObject({ skipped: 'ERROR', claimed: 0 });
  });

  it('Hubble not configured (e.g. Deoleo-only env) → no DB work at all', async () => {
    mockHubble.isConfigured.mockReturnValue(false);
    const res = await service.sweepHubbleOrders(NOW);
    expect(res.skipped).toBe('NOT_CONFIGURED');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('no Hubble-handed orders (a Deoleo-like tenant) → ONE read, no claims, no Hubble calls', async () => {
    candidates = [];
    const rec = jest.spyOn(service, 'reconcileHubbleOrder');
    const res = await service.sweepHubbleOrders(NOW);
    expect(res.claimed).toBe(0);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2); // lock + one candidate read
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });

  it('STALE: still open ≥ 1 h after hand-off and unflagged → flagged HUBBLE_PROCESSING_STALE + audited', async () => {
    candidates = [cand('old', 70 * MIN), cand('new', 30 * MIN), cand('flagged', 90 * MIN)];
    orderNow = {
      old: openOrder(70 * MIN),
      new: openOrder(30 * MIN),
      flagged: openOrder(90 * MIN, { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' }),
    };
    jest.spyOn(service, 'reconcileHubbleOrder').mockResolvedValue('PROCESSING');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flag = jest.spyOn(service as any, 'markHubblePendingReconcile').mockResolvedValue(undefined);
    const res = await service.sweepHubbleOrders(NOW);
    expect(res.flaggedStale).toBe(1);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(flag).toHaveBeenCalledWith('old', HUBBLE_PROCESSING_STALE_REASON);
    expect(auditCreate.mock.calls[0][0].data.metadata).toMatchObject({ event: 'HUBBLE_PROCESSING_STALE', orderNumber: 'ORD-old' });
  });

  it('a stale candidate that got DELIVERED by this very check is NOT flagged', async () => {
    candidates = [cand('old', 70 * MIN)];
    orderNow = { old: { ...openOrder(70 * MIN), status: 'DELIVERED', voucherCode: 'CARD-1' } };
    jest.spyOn(service, 'reconcileHubbleOrder').mockResolvedValue('DELIVERED');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flag = jest.spyOn(service as any, 'markHubblePendingReconcile').mockResolvedValue(undefined);
    await service.sweepHubbleOrders(NOW);
    expect(flag).not.toHaveBeenCalled();
  });
});

describe('HubbleOrderSweep (the @Interval driver)', () => {
  it('calls the sweep, honours the kill switch, and never throws', async () => {
    const rewards = { sweepHubbleOrders: jest.fn().mockRejectedValue(new Error('x')) };
    const d = new HubbleOrderSweep(rewards as never);
    await expect(d.tick()).resolves.toBeUndefined();
    expect(rewards.sweepHubbleOrders).toHaveBeenCalledTimes(1);
    process.env.HUBBLE_ORDER_SWEEP_ENABLED = 'false';
    try {
      await d.tick();
      expect(rewards.sweepHubbleOrders).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.HUBBLE_ORDER_SWEEP_ENABLED;
    }
  });
});
