/// <reference types="vitest/globals" />
/**
 * redemptionModeLabel / canonicalRedemptionMode — the shared mapping that unifies
 * the two cash modes (UPI / BANK_TRANSFER) into a single "Cash Payout" label while
 * keeping BOTH enum values valid (no enum/data migration).
 */
import { describe, it, expect } from 'vitest';
import {
  redemptionModeLabel,
  canonicalRedemptionMode,
  CASH_REDEMPTION_MODES,
  CANONICAL_CASH_MODE,
} from '@/lib/redemption-mode';

describe('redemptionModeLabel', () => {
  it('maps BOTH cash modes to "Cash Payout"', () => {
    expect(redemptionModeLabel('UPI')).toBe('Cash Payout');
    expect(redemptionModeLabel('BANK_TRANSFER')).toBe('Cash Payout');
  });

  it('maps the non-cash modes', () => {
    expect(redemptionModeLabel('GIFT_CARD')).toBe('Gift Card / Voucher');
    expect(redemptionModeLabel('PHYSICAL_GIFT')).toBe('Physical Gift');
  });

  it('renders "—" for null/undefined and passes an unknown value through unchanged', () => {
    expect(redemptionModeLabel(null)).toBe('—');
    expect(redemptionModeLabel(undefined)).toBe('—');
    expect(redemptionModeLabel('FUTURE_MODE')).toBe('FUTURE_MODE');
  });
});

describe('canonicalRedemptionMode / cash recognition', () => {
  it('collapses UPI → BANK_TRANSFER (canonical stored value), leaves the rest', () => {
    expect(canonicalRedemptionMode('UPI')).toBe('BANK_TRANSFER');
    expect(canonicalRedemptionMode('BANK_TRANSFER')).toBe('BANK_TRANSFER');
    expect(canonicalRedemptionMode('GIFT_CARD')).toBe('GIFT_CARD');
    expect(CANONICAL_CASH_MODE).toBe('BANK_TRANSFER');
  });

  it('still recognises BOTH stored cash values (existing UPI items behave as cash)', () => {
    expect(CASH_REDEMPTION_MODES.has('UPI')).toBe(true);
    expect(CASH_REDEMPTION_MODES.has('BANK_TRANSFER')).toBe(true);
    expect(CASH_REDEMPTION_MODES.has('GIFT_CARD')).toBe(false);
  });
});
