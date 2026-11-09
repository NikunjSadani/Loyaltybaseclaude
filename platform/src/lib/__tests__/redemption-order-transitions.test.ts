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

  it('a physical gift gets the full edge set', () => {
    expect(nextStatusOptions({ status: 'CONFIRMED', redemptionMode: 'PHYSICAL_GIFT' }))
      .toEqual(['PROCESSING', 'CANCELLED', 'RETURNED']);
  });
});
