import { buildStatementWindow, orderStatementRows, StatementTx } from './points-statement.helper';

/** Tiny fixture factory: only the fields a test cares about. */
function tx(p: {
  id: string;
  at: string | Date;
  type?: string;
  points: number;
  before: number;
  after: number;
}): StatementTx {
  return {
    id: p.id,
    createdAt: typeof p.at === 'string' ? new Date(p.at) : p.at,
    transactionType: p.type ?? (p.points >= 0 ? 'CREDIT_POINTS_EARNED' : 'DEBIT_REDEMPTION'),
    points: p.points,
    balanceBefore: p.before,
    balanceAfter: p.after,
    description: null,
    referenceType: null,
    referenceId: null,
  };
}

describe('orderStatementRows', () => {
  it('sorts by createdAt ascending regardless of input order', () => {
    const a = tx({ id: 'c', at: '2026-01-01T00:00:00Z', points: 100, before: 0, after: 100 });
    const b = tx({ id: 'a', at: '2026-02-01T00:00:00Z', points: 50, before: 100, after: 150 });
    const c = tx({ id: 'b', at: '2026-03-01T00:00:00Z', points: -30, before: 150, after: 120 });
    expect(orderStatementRows([c, a, b]).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('drops LOCK_HOLDING and UNLOCK_HOLDING rows (they move the locked bucket, not the balance)', () => {
    const rows = [
      tx({ id: '1', at: '2026-01-01T00:00:00Z', points: 100, before: 0, after: 100 }),
      tx({ id: '2', at: '2026-01-02T00:00:00Z', type: 'LOCK_HOLDING', points: -10, before: 100, after: 90 }),
      tx({ id: '3', at: '2026-01-03T00:00:00Z', type: 'UNLOCK_HOLDING', points: 10, before: 90, after: 100 }),
    ];
    expect(orderStatementRows(rows).map((r) => r.id)).toEqual(['1']);
  });

  it('orders a same-timestamp group in balance-chain order, not id order', () => {
    const prior = tx({ id: 'p', at: '2026-01-01T00:00:00Z', points: 100, before: 0, after: 100 });
    const same = '2026-01-05T10:00:00Z';
    // B has the LOWER id but chains after A (B.before 150 == A.after 150).
    const B = tx({ id: 'b1', at: same, points: -50, before: 150, after: 100 });
    const A = tx({ id: 'z9', at: same, points: 50, before: 100, after: 150 });
    expect(orderStatementRows([B, A, prior]).map((r) => r.id)).toEqual(['p', 'z9', 'b1']);
  });

  it('orders a same-timestamp group at the very start of history by finding the chain head', () => {
    const same = '2026-01-05T10:00:00Z';
    const second = tx({ id: 'a', at: same, points: 20, before: 100, after: 120 });
    const first = tx({ id: 'b', at: same, points: 100, before: 0, after: 100 });
    expect(orderStatementRows([second, first]).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('falls back to id order for a same-timestamp group with no chain match, without dropping rows', () => {
    const prior = tx({ id: 'p', at: '2026-01-01T00:00:00Z', points: 100, before: 0, after: 100 });
    const same = '2026-01-05T10:00:00Z';
    const x = tx({ id: 'x', at: same, points: 5, before: 999, after: 1004 });
    const w = tx({ id: 'w', at: same, points: 7, before: 555, after: 562 });
    const out = orderStatementRows([x, prior, w]);
    expect(out.map((r) => r.id)).toEqual(['p', 'w', 'x']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      tx({ id: '2', at: '2026-02-01T00:00:00Z', points: 1, before: 1, after: 2 }),
      tx({ id: '1', at: '2026-01-01T00:00:00Z', points: 1, before: 0, after: 1 }),
    ];
    orderStatementRows(rows);
    expect(rows.map((r) => r.id)).toEqual(['2', '1']);
  });
});

describe('buildStatementWindow', () => {
  const history = [
    tx({ id: '1', at: '2026-01-10T00:00:00Z', points: 100, before: 0, after: 100 }),
    tx({ id: '2', at: '2026-02-10T00:00:00Z', points: 150, before: 100, after: 250 }),
    tx({ id: '3', at: '2026-03-10T00:00:00Z', points: -50, before: 250, after: 200 }),
  ];

  it('with no window returns all rows, opening 0 and closing = the last balanceAfter', () => {
    const w = buildStatementWindow(history, {});
    expect(w.rows).toHaveLength(3);
    expect(w.openingBalance).toBe(0);
    expect(w.closingBalance).toBe(200);
  });

  it('with no window and history that does not start at 0, opening is the first row balanceBefore', () => {
    const w = buildStatementWindow(
      [tx({ id: '1', at: '2026-01-10T00:00:00Z', points: 10, before: 40, after: 50 })],
      {},
    );
    expect(w.openingBalance).toBe(40);
    expect(w.closingBalance).toBe(50);
  });

  it("opening balance is the first in-range row's balanceBefore", () => {
    const w = buildStatementWindow(history, {
      start: new Date('2026-03-01T00:00:00Z'),
      endExclusive: new Date('2026-04-01T00:00:00Z'),
    });
    expect(w.openingBalance).toBe(250);
    expect(w.closingBalance).toBe(200);
    expect(w.rows.map((r) => r.id)).toEqual(['3']);
  });

  it('a window after all activity is empty with opening = closing = the last prior balanceAfter', () => {
    const w = buildStatementWindow(history, {
      start: new Date('2026-06-01T00:00:00Z'),
      endExclusive: new Date('2026-07-01T00:00:00Z'),
    });
    expect(w.rows).toEqual([]);
    expect(w.openingBalance).toBe(200);
    expect(w.closingBalance).toBe(200);
  });

  it('a window before all activity is empty with opening = closing = 0', () => {
    const w = buildStatementWindow(history, {
      start: new Date('2025-01-01T00:00:00Z'),
      endExclusive: new Date('2025-02-01T00:00:00Z'),
    });
    expect(w.rows).toEqual([]);
    expect(w.openingBalance).toBe(0);
    expect(w.closingBalance).toBe(0);
  });

  it('an empty wallet history gives opening = closing = 0', () => {
    expect(buildStatementWindow([], {})).toEqual({ openingBalance: 0, closingBalance: 0, rows: [] });
  });

  it('keeps a debit row signed and closes on its stored balanceAfter', () => {
    const w = buildStatementWindow(
      [tx({ id: 'd', at: '2026-01-01T00:00:00Z', points: -50, before: 200, after: 150 })],
      {},
    );
    expect(w.rows[0].points).toBe(-50);
    expect(w.closingBalance).toBe(150);
  });

  it('expiry and reversal rows carry their stored balances', () => {
    const w = buildStatementWindow(
      [
        tx({ id: 'e', at: '2026-01-01T00:00:00Z', type: 'DEBIT_EXPIRY', points: -20, before: 100, after: 80 }),
        tx({ id: 'r', at: '2026-01-02T00:00:00Z', type: 'CREDIT_REVERSAL', points: 80, before: 80, after: 160 }),
      ],
      {},
    );
    expect(w.rows.map((r) => r.balanceAfter)).toEqual([80, 160]);
    expect(w.closingBalance).toBe(160);
  });

  it('a clawback shortfall closes on the stored balance (0), never the sum of points (-200)', () => {
    const w = buildStatementWindow(
      [
        tx({ id: '1', at: '2026-01-01T00:00:00Z', points: 300, before: 0, after: 300 }),
        tx({ id: '2', at: '2026-01-02T00:00:00Z', type: 'DEBIT_ADJUSTMENT', points: -500, before: 300, after: 0 }),
      ],
      {},
    );
    expect(w.closingBalance).toBe(0);
  });

  it('window bounds are start <= createdAt < endExclusive', () => {
    const rows = [
      tx({ id: 'atStart', at: '2026-03-01T00:00:00Z', points: 10, before: 0, after: 10 }),
      tx({ id: 'atEnd', at: '2026-04-01T00:00:00Z', points: 10, before: 10, after: 20 }),
    ];
    const w = buildStatementWindow(rows, {
      start: new Date('2026-03-01T00:00:00Z'),
      endExclusive: new Date('2026-04-01T00:00:00Z'),
    });
    expect(w.rows.map((r) => r.id)).toEqual(['atStart']);
    expect(w.closingBalance).toBe(10);
  });

  it('orders and windows 5,000 shuffled rows correctly and quickly', () => {
    const rows: StatementTx[] = [];
    let bal = 0;
    const t0 = Date.UTC(2024, 0, 1);
    for (let i = 0; i < 5000; i++) {
      const pts = i % 2 === 0 ? 100 : -40;
      rows.push(
        tx({
          id: `id${String(i).padStart(5, '0')}`,
          // pairs share a timestamp so the chain tie-break is exercised at scale
          at: new Date(t0 + Math.floor(i / 2) * 60_000),
          points: pts,
          before: bal,
          after: bal + pts,
        }),
      );
      bal += pts;
    }
    const shuffled = [...rows].reverse();
    const start = performance.now();
    const ordered = orderStatementRows(shuffled);
    const w = buildStatementWindow(ordered, {});
    const ms = performance.now() - start;
    expect(ordered.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(w.closingBalance).toBe(bal);
    expect(ms).toBeLessThan(200);
  });
});
