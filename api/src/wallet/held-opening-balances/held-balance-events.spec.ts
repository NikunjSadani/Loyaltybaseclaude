import { planHeldPassbook, totalsOf } from './held-balance-events';
import { SAMPLE_EVENTS } from './held-fixtures.test-spec';

describe('planHeldPassbook — the bulk Earn & Burn import posting plan, reproduced', () => {
  it('orders by date then EARN<ADJUST<REDEEM<EXPIRE, dates each row day+seq seconds, chains balances from 0', () => {
    // manifest order deliberately scrambled
    const events = [SAMPLE_EVENTS[3], SAMPLE_EVENTS[2], SAMPLE_EVENTS[1], SAMPLE_EVENTS[0]];
    const r = planHeldPassbook('50100001', 600, events);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.plan.movements;
    expect(m.map((x) => [x.type, x.points, x.balanceBefore, x.balanceAfter])).toEqual([
      ['EARN', 500, 0, 500],
      ['EARN', 400, 500, 900],
      ['REDEEM', -200, 900, 700],
      ['EXPIRE', -100, 700, 600],
    ]);
    expect(m.map((x) => x.createdAt.toISOString())).toEqual([
      '2025-04-01T00:00:01.000Z',
      '2025-06-30T00:00:02.000Z',
      '2025-06-30T00:00:03.000Z',
      '2026-06-30T00:00:04.000Z',
    ]);
    expect(m.map((x) => x.sourceId)).toEqual(['50100001:tl:1', '50100001:tl:2', '50100001:tl:3', '50100001:tl:4']);
    expect(m.map((x) => x.walletTxType)).toEqual(['CREDIT_POINTS_EARNED', 'CREDIT_POINTS_EARNED', 'DEBIT_REDEMPTION', 'DEBIT_EXPIRY']);
    // FIFO: the 200 redeem + 100 lapse both come out of the OLDEST lot (500 → 200)
    expect(m.map((x) => x.remainingPoints)).toEqual([200, 400, 0, 0]);
    expect(r.plan.counters).toEqual({
      redeemablePoints: 600,
      earnedPoints: 900,
      redeemedPoints: 200,
      expiredPoints: 100,
      lastTransactionAt: new Date('2026-06-30T00:00:04.000Z'),
    });
  });

  it('a mid-history dip below zero becomes debt that later lots absorb (Σ remaining = max(net, 0)); ADJUST moves balance only', () => {
    const events = [
      { d: '2025-04-01', t: 'ADJUST', p: -300, l: "Last year's over-redemption recovered" },
      { d: '2025-05-01', t: 'EARN', p: 200, l: 'Points earned' },
      { d: '2025-06-01', t: 'EARN', p: 250, l: 'Points earned' },
    ];
    const r = planHeldPassbook('X1', 150, events);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.minBalance).toBe(-300);
    expect(r.plan.movements.map((x) => x.remainingPoints)).toEqual([0, 0, 150]);
    expect(r.plan.counters.earnedPoints).toBe(450);
    expect(r.plan.movements[0].walletTxType).toBe('DEBIT_ADJUSTMENT');
  });

  it('a negative closing is kept (vendor sales returns) — no lots remain', () => {
    const r = planHeldPassbook('X2', -50, [
      { d: '2025-04-01', t: 'EARN', p: 100, l: 'Points earned' },
      { d: '2025-05-01', t: 'REDEEM', p: -150, l: 'Points redeemed' },
    ]);
    expect(r.ok && r.plan.movements.map((x) => x.remainingPoints)).toEqual([0, 0]);
    expect(r.ok && r.plan.counters.redeemablePoints).toBe(-50);
  });

  it.each([
    ['sum ≠ closing', 601, SAMPLE_EVENTS, /adds up to 600 pts but the closing balance is 601/],
    ['no events', 0, [], /no events/],
    ['EARN with negative points', -5, [{ d: '2025-04-01', t: 'EARN', p: -5, l: 'x' }], /EARN with negative/],
    ['debit with positive points', 5, [{ d: '2025-04-01', t: 'REDEEM', p: 5, l: 'x' }], /positive points/],
    ['fractional points', 1, [{ d: '2025-04-01', t: 'EARN', p: 1.5, l: 'x' }], /whole number/],
    ['bad date', 1, [{ d: '2025-13-40', t: 'EARN', p: 1, l: 'x' }], /invalid date/],
    ['unknown type', 1, [{ d: '2025-04-01', t: 'BONUS', p: 1, l: 'x' }], /unknown type/],
    ['missing label', 1, [{ d: '2025-04-01', t: 'EARN', p: 1, l: ' ' }], /no label/],
  ])('refuses (never repairs): %s', (_n, closing, events, re) => {
    const r = planHeldPassbook('X', closing as number, events);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(re as RegExp);
  });

  it('declared totals must agree with the events', () => {
    const t = totalsOf(SAMPLE_EVENTS as never);
    expect(t).toEqual({ earn: 900, adjust: 0, redeem: 200, expire: 100, net: 600, count: 4 });
    expect(planHeldPassbook('X', 600, SAMPLE_EVENTS, t).ok).toBe(true);
    const bad = planHeldPassbook('X', 600, SAMPLE_EVENTS, { ...t, redeem: 201 });
    expect(bad.ok).toBe(false);
  });
});
