import {
  aggregateLedgerToRow,
  LedgerEntry,
  ReportMonth,
  OutletMeta,
} from './report-helpers';
import { istMonthKey } from '../../common/ist-date';

/**
 * Regression suite for the Points-Ledger report balance reconstruction.
 *
 * Ledger `points` is SIGNED (credits +, debits −). The prior code did `totalBurn += points`
 * on already-negative rows and then `closing = … − totalBurn`, which ADDED burn back into the
 * balance — overstating every redeemed outlet (proven on staging: Chakradhar true 20,516 vs
 * report 91,516). It also silently dropped REVERSE/ADJUST rows. These tests lock the fix:
 * earn/burn/expired are positive magnitudes, all balance-affecting types are counted, and the
 * closing balance equals opening + Σ signed points (which equals wallet.redeemablePoints).
 */
describe('aggregateLedgerToRow — signed-points balance reconstruction', () => {
  const meta: OutletMeta = { outletId: 'o1', outletName: 'Test Outlet' };
  // One IST month so every row lands in a single cell (simplifies magnitude assertions).
  const when = new Date(2026, 5, 15); // June 2026
  const months: ReportMonth[] = [{ monthKey: istMonthKey(when), label: 'Jun 2026' }];
  const e = (type: string, points: number): LedgerEntry => ({ type, points, createdAt: when });

  it('subtracts redemptions instead of adding them (the headline sign bug)', () => {
    // earn 100, redeem 80 → balance 20, NOT 180.
    const row = aggregateLedgerToRow(meta, 0, [e('EARN', 100), e('REDEEM', -80)], months);
    expect(row.totalEarn).toBe(100);
    expect(row.totalBurn).toBe(80); // positive magnitude
    expect(row.totalExpired).toBe(0);
    expect(row.closingBalance).toBe(20);
    expect(row.months[0].earn).toBe(100);
    expect(row.months[0].burn).toBe(80);
  });

  it('counts REVERSE and credit/debit ADJUST (previously dropped) with correct direction', () => {
    const entries = [
      e('EARN', 100),
      e('REDEEM', -80),
      e('EXPIRE', -20),
      e('REVERSE', 50), // refund → credit
      e('ADJUST', 30), // credit-adjust
      e('ADJUST', -10), // debit-adjust
    ];
    const row = aggregateLedgerToRow(meta, 0, entries, months);
    expect(row.totalEarn).toBe(180); // 100 + 50 + 30
    expect(row.totalBurn).toBe(90); // |−80| + |−10|
    expect(row.totalExpired).toBe(20); // |−20|
    // opening 0 + 180 − 90 − 20 = 70
    expect(row.closingBalance).toBe(70);
  });

  it('closing == opening + Σ signed points (matches wallet.redeemablePoints) for any mix', () => {
    const opening = 1234;
    const entries = [
      e('EARN', 500),
      e('REDEEM', -321),
      e('EXPIRE', -17),
      e('REVERSE', 44),
      e('ADJUST', 200),
      e('ADJUST', -5),
      e('LOCK', -999), // must be ignored (locked bucket, not redeemable)
      e('UNLOCK', 999), // must be ignored
    ];
    const signedSumRedeemable = 500 - 321 - 17 + 44 + 200 - 5; // LOCK/UNLOCK excluded
    const row = aggregateLedgerToRow(meta, opening, entries, months);
    expect(row.closingBalance).toBe(opening + signedSumRedeemable);
  });

  it('ignores LOCK/UNLOCK in the earn/burn/expired totals', () => {
    const row = aggregateLedgerToRow(meta, 0, [e('LOCK', -100), e('UNLOCK', 100)], months);
    expect(row.totalEarn).toBe(0);
    expect(row.totalBurn).toBe(0);
    expect(row.totalExpired).toBe(0);
    expect(row.closingBalance).toBe(0);
  });
});
