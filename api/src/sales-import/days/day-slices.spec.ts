import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { dayOfDate, decodeDays, encodeDays, slicesMatchTotals } from './day-slices';
import { currentMonthKey } from '../../targets/targets.helpers';
import { shiftMonthKey } from '../months/month-state';
import { historyCutoffMonth, historyRetentionMonths, isBeyondHistoryRetention } from '../retention-window';

describe('day slices (stored JSON of the per-day split)', () => {
  it('round-trips BigInts beyond 2^53 exactly, sorted by day', () => {
    const big = 9_000_000n * 1_000_000_000_000n; // 9 M cases in pico-cases
    const json = encodeDays([
      { day: 20, amountPaise: -4000n, qtyPico: big, lines: 1 },
      { day: 3, amountPaise: 10500n, qtyPico: 1n, lines: 2 },
    ]);
    expect(json).toEqual([[3, '10500', '1', 2], [20, '-4000', big.toString(), 1]]);
    expect(decodeDays(JSON.parse(JSON.stringify(json)))).toEqual([
      { day: 3, amountPaise: 10500n, qtyPico: 1n, lines: 2 },
      { day: 20, amountPaise: -4000n, qtyPico: big, lines: 1 },
    ]);
  });

  it.each([
    [null], [undefined], [[]], [{}], [[[0, '1', '1', 1]]], [[[32, '1', '1', 1]]], [[[1.5, '1', '1', 1]]], [[[1, 1, '1', 1]]],
    [[[1, '1.5', '1', 1]]], [[[1, '1', '1', -1]]], [[[1, '1', '1']]],
  ])('anything absent or malformed decodes to null (never a guess): %p', (raw) => {
    expect(decodeDays(raw as never)).toBeNull();
  });

  it('slicesMatchTotals: exact sums of amount / quantity / lines, each day once', () => {
    const s = [{ day: 1, amountPaise: 5n, qtyPico: 2n, lines: 1 }, { day: 2, amountPaise: -3n, qtyPico: 0n, lines: 2 }];
    expect(slicesMatchTotals(s, { amountPaise: 2n, qtyPico: 2n, lines: 3 })).toBe(true);
    expect(slicesMatchTotals(s, { amountPaise: 3n, qtyPico: 2n, lines: 3 })).toBe(false);
    expect(slicesMatchTotals(s, { amountPaise: 2n, qtyPico: 2n, lines: 2 })).toBe(false);
    expect(slicesMatchTotals([...s, { day: 2, amountPaise: 0n, qtyPico: 0n, lines: 0 }], { amountPaise: 2n, qtyPico: 2n, lines: 3 })).toBe(false);
    expect(dayOfDate('2026-11-07')).toBe(7);
  });
});

describe('retention window (current IST month + 3 previous; computed from now)', () => {
  const OLD_ENV = process.env.SALES_HISTORY_RETENTION_MONTHS;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.SALES_HISTORY_RETENTION_MONTHS;
    else process.env.SALES_HISTORY_RETENTION_MONTHS = OLD_ENV;
  });

  it('keeps the current month and the 3 before it by default', () => {
    delete process.env.SALES_HISTORY_RETENTION_MONTHS;
    const cur = currentMonthKey();
    expect(historyRetentionMonths()).toBe(4);
    expect(historyCutoffMonth()).toBe(shiftMonthKey(cur, -3));
    expect(isBeyondHistoryRetention(shiftMonthKey(cur, -3))).toBe(false);
    expect(isBeyondHistoryRetention(shiftMonthKey(cur, -4))).toBe(true);
    expect(isBeyondHistoryRetention(cur)).toBe(false);
    expect(historyCutoffMonth(shiftMonthKey(cur, 12))).toBe(shiftMonthKey(cur, 9)); // moves with the month
  });

  it('the setting SALES_HISTORY_RETENTION_MONTHS overrides it (whole number 1..120; anything else → 4)', () => {
    expect(historyRetentionMonths({ SALES_HISTORY_RETENTION_MONTHS: '6' })).toBe(6);
    for (const bad of ['0', '-1', '121', '4.5', 'abc', ' ']) expect(historyRetentionMonths({ SALES_HISTORY_RETENTION_MONTHS: bad })).toBe(4);
  });
});

/**
 * Non-salesImport tenants are untouched: the day tables are WRITTEN only inside src/sales-import (whose every write path
 * is behind the features.salesImport gate — apply / recalculate controllers, the worker, the owner-run one-off).
 */
describe('day-level tables have no writer outside the Sales Import module', () => {
  const SRC = join(__dirname, '..', '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
    }
  };
  walk(SRC);
  it('no INSERT / UPDATE / DELETE / upsert / create / delete on outlet_sales_days or sales_day_sets elsewhere', () => {
    const offenders: string[] = [];
    const write = /(INSERT INTO|UPDATE|DELETE FROM)\s+"(outlet_sales_days|sales_day_sets)"|\b(outletSalesDay|salesDaySet)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
    for (const f of files) {
      const rel = relative(SRC, f).replace(/\\/g, '/');
      if (rel.startsWith('sales-import/')) continue;
      if (write.test(readFileSync(f, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
