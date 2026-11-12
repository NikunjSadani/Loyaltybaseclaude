import { BadRequestException } from '@nestjs/common';
import {
  extractHubbleDenominations,
  isAmountIssuable,
  memberHubbleFields,
  normaliseHubbleDenominations,
  validateHubbleItemAmounts,
} from './hubble-catalog.helpers';
import type { HubbleProduct } from '../hubble/hubble.service';

const FIXED: HubbleProduct = {
  productId: 'fk', name: 'Flipkart', denominationType: 'FIXED',
  denominations: [150, 175, 300, 1250, 2500, 5000, 7500, 10000], minValue: 150, maxValue: 10000, maxVouchersPerOrder: 10,
};
const FLEX: HubbleProduct = {
  productId: 'amz', name: 'Amazon Pay', denominationType: 'FLEXIBLE',
  denominations: [], minValue: 500, maxValue: 10000, maxVouchersPerOrder: 10,
};
const base = {
  denominations: null as number[] | null,
  minRedemptionPoints: null as number | null,
  maxRedemptionPoints: null as number | null,
  sellingValuePaise: null as number | null,
  conversionRate: 1,
  minVoucherFreeAmount: 0,
};

describe('hubble-catalog helpers', () => {
  it('extractHubbleDenominations keeps only whole positive numbers', () => {
    expect(extractHubbleDenominations({ hubbleDenominations: [150, 300.5, -1, '500', 1250] })).toEqual([150, 1250]);
    expect(extractHubbleDenominations(null)).toEqual([]);
    expect(extractHubbleDenominations({ hubbleProductId: 'x' })).toEqual([]);
  });

  it('normaliseHubbleDenominations sorts + de-dupes; rejects decimals / empty', () => {
    expect(normaliseHubbleDenominations([300, 150, 300])).toEqual([150, 300]);
    expect(() => normaliseHubbleDenominations([150.5])).toThrow(BadRequestException);
    expect(() => normaliseHubbleDenominations([])).toThrow(/at least one/);
  });

  it('memberHubbleFields exposes amountOptions only for a GIFT_CARD with a list (never the productId)', () => {
    expect(memberHubbleFields({ hubbleProductId: 'fk', hubbleDenominations: [150, 300] }, 'GIFT_CARD')).toEqual({ amountOptions: [150, 300] });
    expect(memberHubbleFields({ hubbleProductId: 'amz' }, 'GIFT_CARD')).toEqual({});
    expect(memberHubbleFields(null, 'GIFT_CARD')).toEqual({});
    expect(memberHubbleFields({ hubbleDenominations: [150] }, 'BANK_TRANSFER')).toEqual({});
  });

  it('isAmountIssuable: FIXED = in list; FLEXIBLE = whole rupee within min–max', () => {
    expect(isAmountIssuable(FIXED, 300)).toBe(true);
    expect(isAmountIssuable(FIXED, 277)).toBe(false);
    expect(isAmountIssuable(FLEX, 277)).toBe(false); // below Amazon's ₹500 min
    expect(isAmountIssuable(FLEX, 750)).toBe(true);
    expect(isAmountIssuable(FLEX, 750.5)).toBe(false);
    expect(isAmountIssuable(FLEX, 10001)).toBe(false);
  });

  it('M1: a FIXED brand with an UNKNOWN list accepts any whole rupee within its known bounds', () => {
    const unknown = { ...FIXED, denominations: [] };
    expect(isAmountIssuable(unknown, 277)).toBe(true);
    expect(isAmountIssuable(unknown, 277.5)).toBe(false);
    expect(isAmountIssuable(unknown, 100)).toBe(false); // below minValue 150
    expect(validateHubbleItemAmounts(unknown, { ...base, denominations: [200, 400] }))
      .toEqual({ minRedemptionPoints: 200, maxRedemptionPoints: 400 });
  });

  describe('validateHubbleItemAmounts', () => {
    it('FIXED + chosen subset → band derived from min/max × rate', () => {
      expect(validateHubbleItemAmounts(FIXED, { ...base, denominations: [150, 300, 1250], conversionRate: 2 }))
        .toEqual({ minRedemptionPoints: 300, maxRedemptionPoints: 2500 });
    });

    it('FIXED + an amount Hubble does not issue → 400 naming the allowed values', () => {
      expect(() => validateHubbleItemAmounts(FIXED, { ...base, denominations: [150, 277] }))
        .toThrow(/can't issue ₹277.*fixed amounts only: ₹150/);
    });

    it('chosen amount below the tenant minimum voucher amount → 400', () => {
      expect(() => validateHubbleItemAmounts(FIXED, { ...base, denominations: [150, 300], minVoucherFreeAmount: 200 }))
        .toThrow(/below this program's minimum/);
    });

    it('FLEXIBLE + chosen amounts inside the range → ok; outside → 400', () => {
      expect(validateHubbleItemAmounts(FLEX, { ...base, denominations: [500, 1000] }))
        .toEqual({ minRedemptionPoints: 500, maxRedemptionPoints: 1000 });
      expect(() => validateHubbleItemAmounts(FLEX, { ...base, denominations: [100] })).toThrow(BadRequestException);
    });

    it('FIXED product + a free range (no list) → 400 (must choose amounts)', () => {
      expect(() => validateHubbleItemAmounts(FIXED, { ...base, minRedemptionPoints: 100, maxRedemptionPoints: 10000 }))
        .toThrow(/choose which amounts/);
    });

    it('FLEXIBLE + free range: inside → null; outside (₹ = points ÷ rate) → 400', () => {
      expect(validateHubbleItemAmounts(FLEX, { ...base, minRedemptionPoints: 1000, maxRedemptionPoints: 20000, conversionRate: 2 })).toBeNull();
      expect(() => validateHubbleItemAmounts(FLEX, { ...base, minRedemptionPoints: 100, maxRedemptionPoints: 5000 }))
        .toThrow(/must sit inside/);
      expect(() => validateHubbleItemAmounts(FLEX, { ...base, minRedemptionPoints: 500, maxRedemptionPoints: 20000 }))
        .toThrow(/must sit inside/);
    });

    it('fixed-price item: selling value must be an issuable whole rupee', () => {
      expect(validateHubbleItemAmounts(FIXED, { ...base, sellingValuePaise: 30000 })).toBeNull();
      expect(() => validateHubbleItemAmounts(FIXED, { ...base, sellingValuePaise: 27700 })).toThrow(/can't issue a ₹277/);
      expect(() => validateHubbleItemAmounts(FLEX, { ...base, sellingValuePaise: 75050 })).toThrow(BadRequestException);
    });
  });
});
