/// <reference types="vitest/globals" />
/**
 * AFF — the single shared "can the partner afford this?" rule on the partner Rewards page.
 *
 * Used by BOTH the card dimming and the "Within my points" filter. It deliberately does NOT
 * use the backend `isAffordable` flag: FREE_AMOUNT vouchers have pointsCost 0, so the backend
 * flag reads "affordable" even when the partner cannot meet the voucher minimum.
 *
 *   FIXED / physical → balance >= item.points
 *   FREE_AMOUNT      → balance >= ceil(minVoucherFreeAmount × pointsConversionRate)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { isWithinPoints } from '../page';

const RATE_1 = { minVoucherFreeAmount: 100, pointsConversionRate: 1 };

describe('AFF — isWithinPoints affordability rule', () => {
  it('AFF1: a FIXED item costing exactly the balance is within points', () => {
    expect(isWithinPoints({ points: 500, voucherType: 'FIXED' }, 500, RATE_1)).toBe(true);
  });

  it('AFF2: a FIXED item costing one point more than the balance is not within points', () => {
    expect(isWithinPoints({ points: 501, voucherType: 'FIXED' }, 500, RATE_1)).toBe(false);
  });

  it('AFF3: a physical item (no voucherType) below the balance is within points', () => {
    expect(isWithinPoints({ points: 300 }, 500, RATE_1)).toBe(true);
  });

  it('AFF4: a FREE_AMOUNT voucher (pointsCost 0) needs the minimum in points, not 0', () => {
    const item = { points: 0, voucherType: 'FREE_AMOUNT' as const };
    expect(isWithinPoints(item, 99, RATE_1)).toBe(false);
    expect(isWithinPoints(item, 100, RATE_1)).toBe(true);
  });

  it('AFF5: a FREE_AMOUNT minimum with a fractional rate is rounded UP (₹100 × 1.5 = 150 pts)', () => {
    const item = { points: 0, voucherType: 'FREE_AMOUNT' as const };
    const settings = { minVoucherFreeAmount: 100, pointsConversionRate: 1.5 };
    expect(isWithinPoints(item, 149, settings)).toBe(false);
    expect(isWithinPoints(item, 150, settings)).toBe(true);
  });
});
