import { describe, it, expect } from 'vitest';
import { formatInrPaise } from '../money-format';
import { PAID_ENTRY_OUTCOME, HELD_NOTICE, TDS_CREDIT_NOTICE, TDS_ADJUSTMENT_NOTICE } from '../payout-reversal-copy';

describe('formatInrPaise', () => {
  it('always 2 decimals with en-IN grouping', () => {
    expect(formatInrPaise(123450)).toBe('₹1,234.50');
    expect(formatInrPaise(80000)).toBe('₹800.00');
    expect(formatInrPaise(5)).toBe('₹0.05');
    expect(formatInrPaise(0)).toBe('₹0.00');
    expect(formatInrPaise(1234567890)).toBe('₹1,23,45,678.90');
  });
  it('accepts numeric strings and bigint (no precision loss)', () => {
    expect(formatInrPaise('80000')).toBe('₹800.00');
    expect(formatInrPaise('900719925474099312')).toBe('₹9,00,71,99,25,47,40,993.12');
    expect(formatInrPaise(BigInt(150))).toBe('₹1.50');
  });
  it('negatives put the sign before ₹', () => {
    expect(formatInrPaise(-150)).toBe('-₹1.50');
    expect(formatInrPaise('-123450')).toBe('-₹1,234.50');
  });
  it('unparseable input → ₹0.00', () => {
    expect(formatInrPaise(NaN)).toBe('₹0.00');
    expect(formatInrPaise('abc')).toBe('₹0.00');
    expect(formatInrPaise(null)).toBe('₹0.00');
  });
});

describe('payout-reversal-copy', () => {
  it('PAID_ENTRY_OUTCOME: net of TDS + credit; honest when fully withheld', () => {
    expect(PAID_ENTRY_OUTCOME(980000, 20000, 20000)).toBe('Owed back · ₹9,800.00 (net of ₹200.00 TDS withheld) · ₹200.00 TDS credit');
    expect(PAID_ENTRY_OUTCOME(500000, 0, 0)).toBe('Owed back · ₹5,000.00');
    expect(PAID_ENTRY_OUTCOME(0, 300000, 300000)).toBe('₹0.00 owed back — the whole amount was withheld as TDS; ₹3,000.00 TDS credit');
  });
  it('notices pluralise and format', () => {
    expect(HELD_NOTICE(1, 50000)).toMatch(/^1 payout entry \(₹500\.00\) was held/);
    expect(HELD_NOTICE(2, 80000)).toMatch(/^2 payout entries \(₹800\.00\) were held/);
    expect(TDS_CREDIT_NOTICE(2, 20000)).toMatch(/^₹200\.00 of TDS on 2 payout entries were adjusted/);
    expect(TDS_ADJUSTMENT_NOTICE(1, 4500)).toMatch(/^₹45\.00 less TDS on 1 payout entry: adjusted after a reversal/);
  });
});
