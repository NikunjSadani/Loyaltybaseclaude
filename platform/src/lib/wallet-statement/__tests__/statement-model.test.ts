/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import type { PayoutLedgerEntry } from '@/types';
import {
  buildStatementDoc,
  periodLabel,
  STATEMENT_TITLE,
  type StatementApiResponse,
  type StatementApiRow,
} from '../statement-model';

function row(p: Partial<StatementApiRow> & { id: string; date: string; points: number; after: number }): StatementApiRow {
  return {
    transactionType: p.points >= 0 ? 'CREDIT_POINTS_EARNED' : 'DEBIT_REDEMPTION',
    description: p.points >= 0 ? 'Points earned' : 'Points redeemed',
    narration: null,
    fieldName: null,
    balanceBefore: p.after - p.points,
    balanceAfter: p.after,
    referenceType: null,
    referenceId: null,
    ...p,
  };
}

function api(rows: StatementApiRow[], opening = 0, closing?: number): StatementApiResponse {
  return {
    openingBalance: opening,
    closingBalance: closing ?? (rows.length ? rows[rows.length - 1].balanceAfter : opening),
    currentBalance: closing ?? 0,
    rows,
  };
}

function payout(p: Partial<PayoutLedgerEntry> & { id: string }): PayoutLedgerEntry {
  return {
    period: '2026-05',
    kpiLabel: 'Visibility',
    achievedPct: 100,
    payoutAmountPaise: 123_450,
    uploadedAt: '2026-05-02T06:00:00.000Z',
    status: 'PAID',
    utr: 'UTR1',
    paidAt: '2026-05-10T06:00:00.000Z',
    ...p,
  };
}

const meta = { outletName: 'Anil Traders', outletCode: 'OUT-1', from: '2026-04', to: '2026-06' };

describe('B-L1: the downloaded statement carries the SAME TDS context as the screen row', () => {
  it('a partly withheld payout: net amount + "TDS ₹X withheld from ₹Y" in the description, UTR kept', () => {
    const doc = buildStatementDoc(api([]), [payout({ id: 'p1', payoutAmountPaise: 27_000, grossAmountPaise: 30_000, tdsWithheldPaise: 3_000 })], meta);
    const l = doc.lines[0];
    expect(l.kind === 'payout' && l.amountInr).toBe(270);
    expect(l.description).toContain('TDS ₹30 withheld from ₹300');
    expect(l.kind === 'payout' && l.utr).toBe('UTR1');
  });

  it('a fully withheld payout: ₹0, "Withheld as TDS ₹X — ₹0 paid to you", NO UTR (the internal reference never leaks)', () => {
    const doc = buildStatementDoc(
      api([]),
      [payout({ id: 'p2', payoutAmountPaise: 0, grossAmountPaise: 50_000, tdsWithheldPaise: 50_000, settledByTds: true, utr: undefined })],
      meta,
    );
    const l = doc.lines[0];
    expect(l.kind === 'payout' && l.amountInr).toBe(0);
    expect(l.description).toContain('Withheld as TDS ₹500 — ₹0 paid to you');
    expect(l.kind === 'payout' && l.utr).toBe('');
  });
});

describe('buildStatementDoc', () => {
  it('has the fixed title "Wallet Statement" and the outlet + period header', () => {
    const doc = buildStatementDoc(api([]), [], meta);
    expect(doc.title).toBe('Wallet Statement');
    expect(STATEMENT_TITLE).toBe('Wallet Statement');
    expect(doc.outletName).toBe('Anil Traders');
    expect(doc.outletCode).toBe('OUT-1');
    expect(doc.periodLabel).toBe('Apr 2026 – Jun 2026');
  });

  it('lists lines OLDEST first, keeping the API chain order for points rows', () => {
    const doc = buildStatementDoc(
      api([
        row({ id: 'a', date: '2026-04-01T00:00:00.000Z', points: 100, after: 100 }),
        // same timestamp as c, but the API put it first (balance-chain order) — keep it
        row({ id: 'b', date: '2026-05-01T00:00:00.000Z', points: 50, after: 150 }),
        row({ id: 'c', date: '2026-05-01T00:00:00.000Z', points: -20, after: 130 }),
      ]),
      [],
      meta,
    );
    expect(doc.lines.map((l) => (l.kind === 'points' ? l.balance : null))).toEqual([100, 150, 130]);
  });

  it('interleaves payouts by date, with points before a payout at the same instant', () => {
    const doc = buildStatementDoc(
      api([
        row({ id: 'a', date: '2026-05-01T00:00:00.000Z', points: 100, after: 100 }),
        row({ id: 'b', date: '2026-05-10T06:00:00.000Z', points: 10, after: 110 }),
        row({ id: 'c', date: '2026-06-01T00:00:00.000Z', points: 10, after: 120 }),
      ]),
      [payout({ id: 'p1', paidAt: '2026-05-10T06:00:00.000Z' })],
      meta,
    );
    expect(doc.lines.map((l) => l.kind)).toEqual(['points', 'points', 'payout', 'points']);
  });

  it("keeps debit points as negative NUMBERS (never the string '--50')", () => {
    const doc = buildStatementDoc(
      api([row({ id: 'd', date: '2026-04-02T00:00:00.000Z', points: -50, after: 150 })], 200),
      [],
      meta,
    );
    const l = doc.lines[0];
    expect(l.kind).toBe('points');
    if (l.kind === 'points') {
      expect(l.points).toBe(-50);
      expect(typeof l.points).toBe('number');
    }
  });

  it.each([
    ['CREDIT_POINTS_EARNED', 'Earned'],
    ['CREDIT_BONUS', 'Bonus'],
    ['CREDIT_REVERSAL', 'Reversal'],
    ['CREDIT_ADJUSTMENT', 'Credit adjustment'],
    ['DEBIT_REDEMPTION', 'Redeemed'],
    ['DEBIT_EXPIRY', 'Expired'],
    ['DEBIT_ADJUSTMENT', 'Debit adjustment'],
  ])('labels %s as "%s"', (transactionType, label) => {
    const doc = buildStatementDoc(
      api([row({ id: 'x', date: '2026-04-02T00:00:00.000Z', points: 1, after: 1, transactionType })]),
      [],
      meta,
    );
    expect(doc.lines[0].type).toBe(label);
  });

  it('describes a credit row as "<fieldName> · <narration>", or just the field name without a narration', () => {
    const doc = buildStatementDoc(
      api([
        row({ id: 'a', date: '2026-04-02T00:00:00.000Z', points: 10, after: 10, fieldName: 'Visibility', narration: 'Apr display' }),
        row({ id: 'b', date: '2026-04-03T00:00:00.000Z', points: 10, after: 20, fieldName: 'Volume', narration: null }),
        row({ id: 'c', date: '2026-04-04T00:00:00.000Z', points: -5, after: 15, description: 'Redeemed a voucher' }),
      ]),
      [],
      meta,
    );
    expect(doc.lines.map((l) => l.description)).toEqual([
      'Visibility · Apr display',
      'Volume',
      'Redeemed a voucher',
    ]);
  });

  it('filters payouts to the IST month window, drops FAILED, converts paise to rupees and carries no balance', () => {
    const doc = buildStatementDoc(
      api([]),
      [
        payout({ id: 'in', paidAt: '2026-05-10T06:00:00.000Z', payoutAmountPaise: 123_450, utr: 'U1' }),
        // 31 Mar 2026 19:00Z = 1 Apr 2026 00:30 IST → inside an Apr–Jun window
        payout({ id: 'edge', paidAt: '2026-03-31T19:00:00.000Z' }),
        // 30 Jun 2026 19:00Z = 1 Jul IST → outside
        payout({ id: 'out', paidAt: '2026-06-30T19:00:00.000Z' }),
        payout({ id: 'failed', status: 'FAILED', paidAt: '2026-05-11T06:00:00.000Z' }),
        payout({ id: 'pending', status: 'PENDING', paidAt: undefined, utr: undefined, uploadedAt: '2026-05-20T06:00:00.000Z' }),
      ],
      meta,
    );
    const lines = doc.lines.filter((l) => l.kind === 'payout');
    expect(lines.map((l) => l.kind === 'payout' && l.id)).toEqual(['edge', 'in', 'pending']);
    const first = lines[1];
    if (first.kind !== 'payout') throw new Error('expected payout');
    expect(first.amountInr).toBe(1234.5);
    expect(first.utr).toBe('U1');
    expect(first.type).toBe('Payout');
    expect(first.description).toBe('Visibility · May 2026');
    expect('balance' in first).toBe(false);
    const pending = lines[2];
    expect(pending.type).toBe('Payout (Pending)');
    if (pending.kind === 'payout') expect(pending.utr).toBe('');
  });

  it('an empty API and no payouts → no lines, opening = closing from the API', () => {
    const doc = buildStatementDoc(api([], 340, 340), [], meta);
    expect(doc.lines).toEqual([]);
    expect(doc.openingBalance).toBe(340);
    expect(doc.closingBalance).toBe(340);
  });

  it('builds 5,000 rows without pathological slowdown (linear, not O(n²) / hang)', () => {
    const rows: StatementApiRow[] = [];
    let bal = 0;
    for (let i = 0; i < 5000; i++) {
      const pts = i % 3 === 0 ? -10 : 25;
      bal += pts;
      rows.push(row({ id: `r${i}`, date: new Date(Date.UTC(2026, 3, 1) + i * 60_000).toISOString(), points: pts, after: bal }));
    }
    const t0 = performance.now();
    const doc = buildStatementDoc(api(rows), [payout({ id: 'p' })], meta);
    const elapsed = performance.now() - t0;
    // Functional outcome is the real assertion (it completed, all rows present). The time check is
    // only a regression guard against O(n²)/hang — a TIGHT wall-clock budget (was 100ms) is
    // machine/load-dependent and flakes red under full-suite CPU contention (same class as the
    // statement-pdf sibling, see memory rtl-suite-load-flakes). A generous ceiling still catches a
    // true blow-up (a quadratic on 5k rows would be seconds+) without false-failing under load.
    expect(doc.lines).toHaveLength(5001);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('periodLabel', () => {
  it('collapses a single month', () => {
    expect(periodLabel('2026-04', '2026-04')).toBe('Apr 2026');
  });
  it('spans a range with an en dash', () => {
    expect(periodLabel('2025-11', '2026-02')).toBe('Nov 2025 – Feb 2026');
  });
});
