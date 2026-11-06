/// <reference types="vitest/globals" />
/**
 * AFF — the single shared "how many points does this need / can the partner afford it?" rule
 * on the partner Rewards page.
 *
 * Used by the card dimming, the "Need N more" badge AND the "Within my points" filter. It
 * deliberately does NOT use the backend `isAffordable` flag: FREE_AMOUNT vouchers have
 * pointsCost 0, so the backend flag reads "affordable" even when the partner cannot meet the
 * voucher minimum.
 *
 * pointsRequired mirrors what the BACKEND enforces at redeem time (rewards.service.ts):
 *   FIXED / physical → item.points
 *   FREE_AMOUNT      → max(item.minRedemptionPoints ?? 0, Math.round(minVoucherFreeAmount × rate))
 *                      (Math.round — the backend rounds, it does not ceil)
 * isWithinPoints = balance >= pointsRequired.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { isWithinPoints, pointsRequired } from '../page';

const RATE_1 = { minVoucherFreeAmount: 100, pointsConversionRate: 1 };

describe('AFF — isWithinPoints / pointsRequired affordability rule', () => {
  it('AFF1: a FIXED item costing exactly the balance is within points', () => {
    expect(isWithinPoints({ points: 500, voucherType: 'FIXED' }, 500, RATE_1)).toBe(true);
  });

  it('AFF2: a FIXED item costing one point more than the balance is not within points', () => {
    expect(isWithinPoints({ points: 501, voucherType: 'FIXED' }, 500, RATE_1)).toBe(false);
  });

  it('AFF3: a physical item (no voucherType) below the balance is within points', () => {
    expect(isWithinPoints({ points: 300 }, 500, RATE_1)).toBe(true);
  });

  it('AFF4: a FREE_AMOUNT voucher (pointsCost 0) needs the tenant floor in points, not 0', () => {
    const item = { points: 0, voucherType: 'FREE_AMOUNT' as const };
    expect(pointsRequired(item, RATE_1)).toBe(100);
    expect(isWithinPoints(item, 99, RATE_1)).toBe(false);
    expect(isWithinPoints(item, 100, RATE_1)).toBe(true);
  });

  it('AFF5: the FREE_AMOUNT floor is Math.round-ed like the backend (₹101 × 1.2 = 121.2 → 121, not 122)', () => {
    const item = { points: 0, voucherType: 'FREE_AMOUNT' as const };
    const settings = { minVoucherFreeAmount: 101, pointsConversionRate: 1.2 };
    expect(pointsRequired(item, settings)).toBe(121);
    expect(isWithinPoints(item, 120, settings)).toBe(false);
    expect(isWithinPoints(item, 121, settings)).toBe(true);
  });

  it('AFF6: a FREE_AMOUNT item minimum above the tenant floor wins (floor 250, item min 1000)', () => {
    const item = { points: 0, voucherType: 'FREE_AMOUNT' as const, minRedemptionPoints: 1000 };
    const settings = { minVoucherFreeAmount: 250, pointsConversionRate: 1 };
    expect(pointsRequired(item, settings)).toBe(1000);
    expect(isWithinPoints(item, 500, settings)).toBe(false);
    expect(isWithinPoints(item, 1000, settings)).toBe(true);
  });

  it('AFF7: with a rate of 0 the floor collapses to 0, so the threshold is the item minimum (or 0)', () => {
    // Documented behaviour, not a real tenant config: the page always passes a rate > 0
    // (effectiveRate falls back to the settings rate when the live one is 0/invalid).
    const settings = { minVoucherFreeAmount: 250, pointsConversionRate: 0 };
    expect(pointsRequired({ points: 0, voucherType: 'FREE_AMOUNT', minRedemptionPoints: 300 }, settings)).toBe(300);
    expect(pointsRequired({ points: 0, voucherType: 'FREE_AMOUNT' }, settings)).toBe(0);
  });

  it('AFF8: FIXED / physical items need exactly their points cost regardless of the rate', () => {
    expect(pointsRequired({ points: 750, voucherType: 'FIXED' }, { minVoucherFreeAmount: 250, pointsConversionRate: 3 })).toBe(750);
    expect(pointsRequired({ points: 750 }, { minVoucherFreeAmount: 250, pointsConversionRate: 3 })).toBe(750);
  });
});
