import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RedemptionStatus } from '@prisma/client';
import {
  recordStockEdit,
  returnStockForOrder,
  STOCK_BASELINE_REASON,
  takeStockForOrder,
} from './reward-stock';
import { transitionOrderStatus, transitionOrderStatusOrConflict, supersedePendingOrders } from './order-status-transition';
import { RewardStockService } from './reward-stock.service';

/**
 * REWARD STOCK HISTORY (owner 2026-11-26) — behaviour against a small in-memory DB that mirrors the Prisma calls
 * the code makes (incl. the two partial unique indexes: one REDEEMED + one RETURNED row per order).
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tick = () => new Promise((r) => setImmediate(r)); // yield so concurrent flows really interleave

function makeDb() {
  const rewards: Row[] = [];
  const orders: Row[] = [];
  const moves: Row[] = [];
  const reviews: Row[] = [];
  const history: Row[] = [];
  let seq = 0;
  let clock = Date.parse('2026-11-26T10:00:00Z');
  const now = () => new Date((clock += 1000));

  const matchVal = (v: unknown, cond: unknown): boolean => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('gte' in c) return v != null && (v as number) >= c.gte;
      if ('not' in c) return c.not === null ? v != null : v !== c.not;
      if ('notIn' in c) return !c.notIn.includes(v);
      if ('in' in c) return c.in.includes(v);
    }
    return v === cond;
  };
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, cond]) => {
      if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
      if (k === 'AND') return (cond as Row[]).every((w) => matches(row, w));
      return matchVal(row[k], cond);
    });
  const applyData = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && 'decrement' in v) row[k] = row[k] - v.decrement;
      else if (v && typeof v === 'object' && 'increment' in v) row[k] = row[k] + v.increment;
      else row[k] = v;
    }
  };
  const sortBy = (rows: Row[], orderBy?: Row | Row[]) => {
    const ob = Array.isArray(orderBy) ? orderBy[0] : orderBy;
    if (!ob) return rows;
    const [k, dir] = Object.entries(ob)[0];
    return [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  };

  const tx = {
    rewardCatalog: {
      findFirst: async ({ where }: Row) => { await tick(); const r = rewards.find((x) => matches(x, where)); return r ? { ...r } : null; },
      findMany: async ({ where }: Row) => rewards.filter((x) => matches(x, where)).map((r) => ({ ...r })),
      updateMany: async ({ where, data }: Row) => {
        await tick();
        const hit = rewards.filter((x) => matches(x, where));
        hit.forEach((r) => applyData(r, data));
        return { count: hit.length };
      },
      update: async ({ where, data }: Row) => { const r = rewards.find((x) => x.id === where.id)!; applyData(r, data); return { ...r }; },
    },
    rewardStockMovement: {
      findFirst: async ({ where, orderBy }: Row) => { await tick(); return sortBy(moves.filter((m) => matches(m, where)), orderBy)[0] ?? null; },
      findMany: async ({ where, orderBy, take }: Row) => {
        await tick();
        return sortBy(moves.filter((m) => matches(m, where)), orderBy).slice(0, take ?? undefined).map((m) => ({ ...m }));
      },
      count: async ({ where }: Row) => moves.filter((m) => matches(m, where)).length,
      groupBy: async ({ where }: Row) => {
        const by = new Map<string, number>();
        moves.filter((m) => matches(m, where)).forEach((m) => by.set(m.type, (by.get(m.type) ?? 0) + m.quantity));
        return [...by].map(([type, q]) => ({ type, _sum: { quantity: q } }));
      },
      create: async ({ data }: Row) => {
        if ((data.type === 'REDEEMED' || data.type === 'RETURNED') &&
          moves.some((m) => m.orderId === data.orderId && m.type === data.type)) {
          throw new Error(`unique violation reward_stock_movements_order_${data.type.toLowerCase()}_key`);
        }
        const row = { id: `m${++seq}`, orderId: null, reason: null, actorId: null, ...data, createdAt: now() };
        moves.push(row);
        return row;
      },
    },
    rewardStockReview: {
      createMany: async ({ data }: Row) => {
        let count = 0;
        for (const d of data as Row[]) {
          if (reviews.some((r) => r.orderId === d.orderId)) continue;
          reviews.push({ id: `rv${++seq}`, status: 'OPEN', createdAt: now(), ...d });
          count++;
        }
        return { count };
      },
      findMany: async ({ where }: Row) => reviews.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      findFirst: async ({ where }: Row) => reviews.find((r) => matches(r, where)) ?? null,
      count: async ({ where }: Row) => reviews.filter((r) => matches(r, where)).length,
      updateMany: async ({ where, data }: Row) => {
        await tick();
        const hit = reviews.filter((r) => matches(r, where));
        hit.forEach((r) => applyData(r, data));
        return { count: hit.length };
      },
    },
    redemptionOrder: {
      findFirst: async ({ where, select }: Row) => {
        await tick();
        const o = orders.find((x) => matches(x, where));
        if (!o) return null;
        return select?.reward ? { ...o, reward: { ...rewards.find((r) => r.id === o.rewardId) } } : { ...o };
      },
      findMany: async ({ where }: Row) => orders.filter((x) => matches(x, where)).map((o) => ({ ...o })),
      updateMany: async ({ where, data }: Row) => {
        await tick();
        const hit = orders.filter((x) => matches(x, where));
        hit.forEach((o) => applyData(o, data));
        return { count: hit.length };
      },
      update: async ({ where, data }: Row) => { const o = orders.find((x) => x.id === where.id)!; applyData(o, data); return { ...o }; },
      findUniqueOrThrow: async ({ where }: Row) => ({ ...orders.find((x) => x.id === where.id)! }),
    },
    redemptionStatusHistory: { create: async ({ data }: Row) => { history.push(data); return data; } },
    user: { findMany: async () => [{ id: 'admin1', name: 'Asha Admin' }] },
    $executeRaw: async () => 1,
    $queryRaw: async (_s: unknown, id: string) => {
      const r = rewards.find((x) => x.id === id);
      return r ? [{ stockQuantity: r.stockQuantity }] : [];
    },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  };

  return {
    tx, rewards, orders, moves, reviews, history, now,
    addReward: (r: Row) => { rewards.push({ status: 'ACTIVE', clientId: 'bajaj', code: r.id.toUpperCase(), name: r.id, deletedAt: null, ...r }); },
    addOrder: (o: Row) => { orders.push({ quantity: 1, status: 'CONFIRMED', orderNumber: `ORD-${o.id}`, createdAt: now(), ...o }); },
  };
}

/** Confirm an order the way confirmRedeem does it (status claim + stock take, same tx). */
async function confirm(db: ReturnType<typeof makeDb>, orderId: string) {
  const o = db.orders.find((x) => x.id === orderId)!;
  const claim = await transitionOrderStatus(db.tx as never, {
    orderId, guard: { status: 'PENDING' }, fromStatus: RedemptionStatus.PENDING, toStatus: RedemptionStatus.CONFIRMED, changedById: 'member1',
  });
  if (claim.count === 0) throw new ConflictException('lost');
  await takeStockForOrder(db.tx as never, { rewardId: o.rewardId, orderId, orderNumber: o.orderNumber, quantity: o.quantity, actorId: 'member1' });
}

describe('reward stock history — take on confirm', () => {
  it('decrements the stock and writes ONE REDEEMED row (−qty, balance after, order, actor)', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 5 });
    db.moves.push({ id: 'b', rewardId: 'r1', clientId: 'bajaj', type: 'OPENING', quantity: 5, balanceAfter: 5, reason: STOCK_BASELINE_REASON, createdAt: new Date('2026-11-01') });
    db.addOrder({ id: 'o1', rewardId: 'r1', status: 'PENDING', quantity: 2 });
    await confirm(db, 'o1');
    expect(db.rewards[0].stockQuantity).toBe(3);
    const redeemed = db.moves.filter((m) => m.type === 'REDEEMED');
    expect(redeemed).toEqual([
      expect.objectContaining({ orderId: 'o1', quantity: -2, balanceAfter: 3, actorId: 'member1', clientId: 'bajaj', reason: 'Redeemed on order ORD-o1' }),
    ]);
  });

  it('the last unit flips the item to OUT_OF_STOCK and the history row says so', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 1 });
    db.addOrder({ id: 'o1', rewardId: 'r1', status: 'PENDING' });
    await confirm(db, 'o1');
    expect(db.rewards[0]).toMatchObject({ stockQuantity: 0, status: 'OUT_OF_STOCK' });
    expect(db.moves.find((m) => m.type === 'REDEEMED')!.reason).toContain('status set to Out of stock');
  });

  it('not enough stock → 400 "Reward is out of stock" and NO history row', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 1 });
    db.addOrder({ id: 'o1', rewardId: 'r1', status: 'PENDING', quantity: 2 });
    await expect(confirm(db, 'o1')).rejects.toBeInstanceOf(BadRequestException);
    expect(db.moves).toHaveLength(0);
    expect(db.rewards[0].stockQuantity).toBe(1);
  });

  it('a tracked reward with no ledger row yet gets its OPENING (stock before) first, so the history adds up', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 4 });
    db.addOrder({ id: 'o1', rewardId: 'r1', status: 'PENDING' });
    await confirm(db, 'o1');
    expect(db.moves.map((m) => [m.type, m.quantity, m.balanceAfter])).toEqual([['OPENING', 4, 4], ['REDEEMED', -1, 3]]);
  });
});

describe('reward stock history — return on cancel / fail / return (every status-write form)', () => {
  const setup = (opts: { stock?: number; status?: string; qty?: number } = {}) => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: opts.stock ?? 3, status: opts.status ?? 'ACTIVE' });
    db.addOrder({ id: 'o1', rewardId: 'r1', status: 'PENDING', quantity: opts.qty ?? 1 });
    return db;
  };

  it.each([
    ['admin / vendor compare-and-set → CANCELLED', RedemptionStatus.CANCELLED, 'cas'],
    ['admin compare-and-set → RETURNED', RedemptionStatus.RETURNED, 'cas'],
    ['payout UTR=FAILED guarded claim → FAILED', RedemptionStatus.FAILED, 'guarded'],
    ['Hubble refund unguarded (fromStatus unknown) → FAILED', RedemptionStatus.FAILED, 'unguarded'],
  ])('%s gives the stock back once + RETURNED row', async (_l, to, form) => {
    const db = setup({ qty: 2 });
    await confirm(db, 'o1');
    expect(db.rewards[0].stockQuantity).toBe(1);
    if (form === 'cas') {
      await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'o1', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: to, changedById: 'admin1' });
    } else if (form === 'guarded') {
      await transitionOrderStatus(db.tx as never, { orderId: 'o1', guard: { status: { not: RedemptionStatus.FAILED } }, fromStatus: RedemptionStatus.CONFIRMED, toStatus: to, changedById: 'admin1' });
    } else {
      await transitionOrderStatus(db.tx as never, { orderId: 'o1', fromStatus: null, toStatus: to, changedById: null });
    }
    expect(db.rewards[0].stockQuantity).toBe(3);
    const ret = db.moves.filter((m) => m.type === 'RETURNED');
    expect(ret).toHaveLength(1);
    expect(ret[0]).toMatchObject({ orderId: 'o1', quantity: 2, balanceAfter: 3 });
    expect(ret[0].reason).toContain(`Order ORD-o1 ${to.toLowerCase()}`);
  });

  it('double cancel / CANCELLED then a late UTR=FAILED: stock returned ONCE', async () => {
    const db = setup();
    await confirm(db, 'o1');
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'o1', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    // the same cancel again loses its compare-and-set (409) — no second return
    await expect(
      transitionOrderStatusOrConflict(db.tx as never, { orderId: 'o1', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED }),
    ).rejects.toBeInstanceOf(ConflictException);
    // a different refund status landing later (payout guard is only "not FAILED")
    await transitionOrderStatus(db.tx as never, { orderId: 'o1', guard: { status: { not: 'FAILED' } }, fromStatus: RedemptionStatus.CANCELLED, toStatus: RedemptionStatus.FAILED });
    // and a direct second call of the return itself
    await returnStockForOrder(db.tx as never, { orderId: 'o1', fromStatus: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.RETURNED, actorId: null });
    expect(db.rewards[0].stockQuantity).toBe(3);
    expect(db.moves.filter((m) => m.type === 'RETURNED')).toHaveLength(1);
  });

  it('CONCURRENCY: two cancels of the SAME order racing → one wins, stock returned once', async () => {
    const db = setup();
    await confirm(db, 'o1');
    const run = () => transitionOrderStatus(db.tx as never, {
      orderId: 'o1', guard: { status: 'CONFIRMED' }, fromStatus: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED,
    });
    const res = await Promise.all([run(), run()]);
    expect(res.map((r) => r.count).sort()).toEqual([0, 1]);
    expect(db.rewards[0].stockQuantity).toBe(3);
    expect(db.moves.filter((m) => m.type === 'RETURNED')).toHaveLength(1);
  });

  it('CONCURRENCY: returns of two DIFFERENT orders on one reward both land (+2, distinct balances)', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 2 });
    db.addOrder({ id: 'o1', rewardId: 'r1', status: 'PENDING' });
    db.addOrder({ id: 'o2', rewardId: 'r1', status: 'PENDING' });
    await confirm(db, 'o1');
    await confirm(db, 'o2');
    expect(db.rewards[0].stockQuantity).toBe(0);
    await Promise.all(['o1', 'o2'].map((id) => transitionOrderStatusOrConflict(db.tx as never, {
      orderId: id, expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED,
    })));
    expect(db.rewards[0].stockQuantity).toBe(2);
    expect(db.moves.filter((m) => m.type === 'RETURNED').map((m) => m.quantity)).toEqual([1, 1]);
  });

  it('the unique index is the backstop: a second RETURNED row for one order is refused by the DB', async () => {
    const db = setup();
    await db.tx.rewardStockMovement.create({ data: { orderId: 'o1', type: 'RETURNED', rewardId: 'r1', clientId: 'bajaj', quantity: 1 } });
    await expect(
      db.tx.rewardStockMovement.create({ data: { orderId: 'o1', type: 'RETURNED', rewardId: 'r1', clientId: 'bajaj', quantity: 1 } }),
    ).rejects.toThrow(/unique/);
  });

  it('a PENDING order cancelled (OTP not completed / superseded) never touches stock', async () => {
    const db = setup();
    await supersedePendingOrders(db.tx as never, 'p1', null, new Date());
    await transitionOrderStatus(db.tx as never, { orderId: 'o1', guard: { status: 'PENDING' }, fromStatus: RedemptionStatus.PENDING, toStatus: RedemptionStatus.CANCELLED });
    expect(db.rewards[0].stockQuantity).toBe(3);
    expect(db.moves).toHaveLength(0);
    expect(db.reviews).toHaveLength(0);
  });

  it('a sold-out item comes BACK IN STOCK (OUT_OF_STOCK → ACTIVE) and the RETURNED row says so', async () => {
    const db = setup({ stock: 1 });
    await confirm(db, 'o1');
    expect(db.rewards[0].status).toBe('OUT_OF_STOCK');
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'o1', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    expect(db.rewards[0]).toMatchObject({ stockQuantity: 1, status: 'ACTIVE' });
    expect(db.moves.find((m) => m.type === 'RETURNED')!.reason).toContain('Back in stock');
  });

  it('a manually paused item (OUT_OF_STOCK with stock left) or a DISCONTINUED one is never re-activated by a return', async () => {
    for (const status of ['OUT_OF_STOCK', 'DISCONTINUED', 'INACTIVE']) {
      const db = setup({ stock: 3 });
      await confirm(db, 'o1');
      db.rewards[0].status = status;
      await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'o1', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
      expect(db.rewards[0]).toMatchObject({ stockQuantity: 3, status });
    }
  });

  it('a reward switched to unlimited since the redemption gets no return (nothing to return into)', async () => {
    const db = setup();
    await confirm(db, 'o1');
    db.rewards[0].stockQuantity = null;
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'o1', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    expect(db.rewards[0].stockQuantity).toBeNull();
    expect(db.moves.filter((m) => m.type === 'RETURNED')).toHaveLength(0);
  });
});

describe('reward stock history — orders confirmed BEFORE stock history (pre-release)', () => {
  it('confirmed before the go-live baseline → NOT auto-returned; listed for review (once)', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 7 });
    db.addOrder({ id: 'old', rewardId: 'r1', status: 'CONFIRMED', quantity: 2 }); // placed first …
    db.moves.push({ id: 'b', rewardId: 'r1', clientId: 'bajaj', type: 'OPENING', quantity: 7, balanceAfter: 7, reason: STOCK_BASELINE_REASON, createdAt: db.now() }); // … then go-live
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'old', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    await transitionOrderStatus(db.tx as never, { orderId: 'old', fromStatus: null, toStatus: RedemptionStatus.FAILED });
    expect(db.rewards[0].stockQuantity).toBe(7);
    expect(db.moves.filter((m) => m.type === 'RETURNED')).toHaveLength(0);
    expect(db.reviews).toEqual([
      expect.objectContaining({ orderId: 'old', rewardId: 'r1', clientId: 'bajaj', quantity: 2, orderStatus: 'CANCELLED', status: 'OPEN' }),
    ]);
  });

  it('placed AFTER the reward’s history began but with no REDEEMED row (reward was unlimited then) → nothing to return, no review', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 7 });
    db.moves.push({ id: 'b', rewardId: 'r1', clientId: 'bajaj', type: 'OPENING', quantity: 7, balanceAfter: 7, reason: STOCK_BASELINE_REASON, createdAt: db.now() });
    db.addOrder({ id: 'new', rewardId: 'r1', status: 'CONFIRMED' });
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'new', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    expect(db.rewards[0].stockQuantity).toBe(7);
    expect(db.moves).toHaveLength(1);
    expect(db.reviews).toHaveLength(0);
  });

  it('an untracked reward never produces a review', async () => {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: null });
    db.addOrder({ id: 'old', rewardId: 'r1', status: 'CONFIRMED' });
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'old', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    expect(db.reviews).toHaveLength(0);
  });
});

describe('reward stock history — admin / vendor edits (recordStockEdit)', () => {
  const edit = (db: ReturnType<typeof makeDb>, oldQty: number | null, newQty: number | null, reason?: string) =>
    recordStockEdit(db.tx as never, { rewardId: 'r1', clientId: 'bajaj', oldQty, newQty, actorId: 'admin1', source: 'catalogue edit', reason });

  it('first figure ever → OPENING; then N → M → ADJUSTED (M − N) with actor + reason', async () => {
    const db = makeDb();
    await edit(db, null, 10);
    await edit(db, 10, 6, 'Damaged in transit');
    expect(db.moves.map((m) => [m.type, m.quantity, m.balanceAfter, m.actorId])).toEqual([
      ['OPENING', 10, 10, 'admin1'],
      ['ADJUSTED', -4, 6, 'admin1'],
    ]);
    expect(db.moves[1].reason).toBe('Stock changed 10 → 6 (catalogue edit). Reason: Damaged in transit');
  });

  it('unchanged stock → no row; untracked → untracked → no row', async () => {
    const db = makeDb();
    await edit(db, 5, 5);
    await edit(db, null, null);
    expect(db.moves).toHaveLength(0);
  });

  it('a tracked reward with no ledger row (pre-baseline) records its old figure as OPENING, then the ADJUSTED', async () => {
    const db = makeDb();
    await edit(db, 3, 8);
    expect(db.moves.map((m) => [m.type, m.quantity, m.balanceAfter])).toEqual([['OPENING', 3, 3], ['ADJUSTED', 5, 8]]);
  });

  it('tracking turned off / on is recorded (balanceAfter null = unlimited)', async () => {
    const db = makeDb();
    await edit(db, null, 4);
    await edit(db, 4, null);
    await edit(db, null, 9);
    expect(db.moves.map((m) => [m.type, m.quantity, m.balanceAfter])).toEqual([
      ['OPENING', 4, 4], ['ADJUSTED', 0, null], ['ADJUSTED', 9, 9],
    ]);
    expect(db.moves[1].reason).toContain('tracking turned off');
    expect(db.moves[2].reason).toContain('tracking turned on');
  });
});

describe('RewardStockService — history read, review decisions, tenant scoping', () => {
  const bajajAdmin = { sub: 'admin1', role: 'CLIENT_ADMIN', clientId: 'bajaj' } as never;
  const deoleoAdmin = { sub: 'admin2', role: 'CLIENT_ADMIN', clientId: 'deoleo' } as never;

  function seeded() {
    const db = makeDb();
    db.addReward({ id: 'r1', stockQuantity: 5, clientId: 'bajaj' });
    db.addOrder({ id: 'old', rewardId: 'r1', status: 'CONFIRMED', quantity: 1 });
    db.moves.push({ id: 'b', rewardId: 'r1', clientId: 'bajaj', type: 'OPENING', quantity: 5, balanceAfter: 5, orderId: null, reason: STOCK_BASELINE_REASON, actorId: null, createdAt: db.now() });
    db.addOrder({ id: 'o1', rewardId: 'r1', status: 'PENDING' });
    return { db, svc: new RewardStockService(db.tx as never) };
  }

  it('summary: baseline opening, redeemed, returned, current + who/when/order per row', async () => {
    const { db, svc } = seeded();
    await confirm(db, 'o1');
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'o1', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED, changedById: 'admin1' });
    const h = await svc.getHistory(bajajAdmin, 'r1');
    expect(h.summary).toMatchObject({ opening: 5, openingIsBaseline: true, redeemed: 1, returned: 1, adjusted: 0, current: 5 });
    expect(h.movements[0]).toMatchObject({ type: 'RETURNED', orderNumber: 'ORD-o1', actorName: 'Asha Admin' });
    expect(h.movements.at(-1)).toMatchObject({ type: 'OPENING', isBaseline: true });
  });

  it('TENANT SCOPING: another tenant cannot read the history, list or resolve its reviews', async () => {
    const { db, svc } = seeded();
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'old', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    await expect(svc.getHistory(deoleoAdmin, 'r1')).rejects.toBeInstanceOf(NotFoundException);
    expect((await svc.listReviews(deoleoAdmin)).items).toHaveLength(0);
    const id = db.reviews[0].id;
    await expect(svc.resolveReview(deoleoAdmin, id, 'RETURN')).rejects.toBeInstanceOf(NotFoundException);
    expect((await svc.listReviews(bajajAdmin)).items).toEqual([expect.objectContaining({ orderNumber: 'ORD-old', rewardName: 'r1' })]);
  });

  it('review RETURN adds the unit back with a RETURNED row (actor + note); deciding twice → 409', async () => {
    const { db, svc } = seeded();
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'old', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    const id = db.reviews[0].id;
    const res = await svc.resolveReview(bajajAdmin, id, 'RETURN', 'Unit is back on the shelf');
    expect(res).toMatchObject({ status: 'RETURNED', stockAfter: 6 });
    expect(db.rewards[0].stockQuantity).toBe(6);
    expect(db.moves.find((m) => m.type === 'RETURNED')).toMatchObject({ orderId: 'old', quantity: 1, actorId: 'admin1' });
    expect(db.reviews[0]).toMatchObject({ status: 'RETURNED', resolvedById: 'admin1', resolutionNote: 'Unit is back on the shelf' });
    await expect(svc.resolveReview(bajajAdmin, id, 'RETURN')).rejects.toBeInstanceOf(ConflictException);
    expect(db.rewards[0].stockQuantity).toBe(6);
  });

  it('review KEEP needs a note, leaves stock unchanged and records the decision', async () => {
    const { db, svc } = seeded();
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'old', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    const id = db.reviews[0].id;
    await expect(svc.resolveReview(bajajAdmin, id, 'KEEP')).rejects.toBeInstanceOf(BadRequestException);
    await svc.resolveReview(bajajAdmin, id, 'KEEP', 'Unit was never in stock');
    expect(db.rewards[0].stockQuantity).toBe(5);
    expect(db.reviews[0]).toMatchObject({ status: 'KEPT', resolutionNote: 'Unit was never in stock' });
  });

  it('CONCURRENCY: two admins deciding the same review at once → exactly one applies', async () => {
    const { db, svc } = seeded();
    await transitionOrderStatusOrConflict(db.tx as never, { orderId: 'old', expectedFrom: RedemptionStatus.CONFIRMED, toStatus: RedemptionStatus.CANCELLED });
    const id = db.reviews[0].id;
    const out = await Promise.allSettled([svc.resolveReview(bajajAdmin, id, 'RETURN'), svc.resolveReview(bajajAdmin, id, 'RETURN')]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(db.rewards[0].stockQuantity).toBe(6);
  });

  it('download: an .xlsx with the movements + a summary sheet', async () => {
    const { svc } = seeded();
    const { buffer, filename } = await svc.exportHistory(bajajAdmin, 'r1');
    expect(buffer.length).toBeGreaterThan(100);
    expect(filename).toMatch(/^stock-history-R1-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});
