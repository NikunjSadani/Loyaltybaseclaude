/// <reference types="vitest/globals" />
/**
 * The console's NEXT_STATUS must equal the backend's guarded edge-map in
 * RewardsService.transitionOrder (api/src/rewards/rewards.service.ts — the `allowed` table).
 * If the backend table changes, update BOTH and this literal.
 */
import { describe, it, expect } from 'vitest';
import { NEXT_STATUS, nextStatusOptions } from '../redemption-order-transitions';

const BACKEND_ALLOWED = {
  PENDING: ['CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED', 'RETURNED'],
  PROCESSING: ['DISPATCHED', 'FAILED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
};

describe('redemption-order transitions', () => {
  it('NEXT_STATUS matches the backend allowed-transition table exactly', () => {
    expect(NEXT_STATUS).toEqual(BACKEND_ALLOWED);
  });

  it('PENDING never offers CONFIRMED (the member OTP confirms, not the console)', () => {
    expect(nextStatusOptions({ status: 'PENDING', redemptionMode: 'GIFT_CARD' })).toEqual(['CANCELLED']);
  });

  it('terminal statuses offer nothing', () => {
    for (const s of ['CANCELLED', 'RETURNED', 'FAILED', 'REVERSED']) {
      expect(nextStatusOptions({ status: s, redemptionMode: 'PHYSICAL_GIFT' })).toEqual([]);
    }
  });

  it('cash orders (UPI / BANK_TRANSFER) offer no manual moves — backend blocks refund + forward-dispatch targets', () => {
    for (const mode of ['UPI', 'BANK_TRANSFER']) {
      for (const status of Object.keys(BACKEND_ALLOWED)) {
        expect(nextStatusOptions({ status, redemptionMode: mode })).toEqual([]);
      }
    }
  });

  it('a Hubble-issued voucher offers no refund targets', () => {
    expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', voucherProvider: 'Hubble' }))
      .toEqual(['PROCESSING']);
    expect(nextStatusOptions({ status: 'DELIVERED', redemptionMode: 'GIFT_CARD', voucherProvider: 'Hubble' }))
      .toEqual([]);
  });

  it('ANY issued voucher code hides every refund target (owner rule, all providers)', () => {
    for (const status of Object.keys(BACKEND_ALLOWED)) {
      const opts = nextStatusOptions({ status, redemptionMode: 'GIFT_CARD', voucherProvider: 'Gifsy', voucherCode: '••••WXYZ' });
      expect(opts.filter((s) => ['CANCELLED', 'RETURNED', 'FAILED'].includes(s))).toEqual([]);
    }
    expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', voucherCode: 'X' })).toEqual(['PROCESSING']);
    // Cleared code ('' / null) → refund targets are back.
    expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', voucherCode: '' }))
      .toEqual(['PROCESSING', 'CANCELLED', 'RETURNED']);
  });

  it('Hubble "never placed" reasons keep refund targets; every other reconcile reason hides them', () => {
    for (const r of ['HUBBLE_NOT_CONFIGURED', 'HUBBLE_INVALID_AMOUNT']) {
      expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', hubbleNeedsReconcile: true, hubbleReconcileReason: r }))
        .toEqual(['PROCESSING', 'CANCELLED', 'RETURNED']);
    }
    for (const r of ['HUBBLE_INDETERMINATE', 'HUBBLE_PROCESSING_NOT_FOUND', 'HUBBLE_SUCCESS_NO_CODE', 'HUBBLE_UNKNOWN_STATUS:X', 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT', 'HUBBLE_UNEXPECTED', null]) {
      expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', hubbleNeedsReconcile: true, hubbleReconcileReason: r }))
        .toEqual(['PROCESSING']);
    }
    // A never-placed reason with a code or a Hubble provider is still blocked.
    expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_NOT_CONFIGURED', voucherCode: 'X' }))
      .toEqual(['PROCESSING']);
    expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_NOT_CONFIGURED', voucherProvider: 'Hubble' }))
      .toEqual(['PROCESSING']);
  });

  it('a physical gift gets the full edge set', () => {
    expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'PHYSICAL_GIFT' }))
      .toEqual(['PROCESSING', 'CANCELLED', 'RETURNED']);
  });
});
