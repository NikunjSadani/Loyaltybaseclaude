/// <reference types="vitest/globals" />
/**
 * Offer tiles — pure formatters + the partner fetcher's shape coercion (OFFER-TILES-PLAN F1).
 * Run: npx vitest run src/lib/__tests__/offers.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (url: string) => get(url), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  authHeader: () => ({}),
}));

import {
  formatOfferValue, groupOffers, sectionValidTill, OFFER_GROUP_LABEL, formatOfferDay,
  formatOfferDayShort, formatMonthLabel, monthBounds, previousMonth, fetchPartnerOffers,
  type OfferGroup, type OfferTilePartner,
} from '@/lib/offers';

function tile(group: OfferGroup, validTo = '2026-11-30', id = Math.random().toString(36)): OfferTilePartner {
  return {
    id, group, valueType: 'POINTS', valueNumber: 10, valueText: null, unitLabel: null,
    product: null, label: 'L', details: null, validTo, progress: null,
  };
}
const t = (validTo: string) => tile('TARGET_REWARD', validTo);

beforeEach(() => get.mockReset());

describe('offers lib', () => {
  it('formats the big value', () => {
    expect(formatOfferValue({ valueType: 'POINTS', valueNumber: 35, valueText: null })).toBe('+35 pts');
    expect(formatOfferValue({ valueType: 'POINTS', valueNumber: 1, valueText: null })).toBe('+1 pt');
    expect(formatOfferValue({ valueType: 'PERCENT', valueNumber: 2.5, valueText: null })).toBe('+2.5%');
    expect(formatOfferValue({ valueType: 'RUPEES', valueNumber: 1500, valueText: null })).toBe('₹1,500');
    expect(formatOfferValue({ valueType: 'TEXT', valueNumber: null, valueText: 'Free kit' })).toBe('Free kit');
  });

  it('groups in fixed order and drops empty groups', () => {
    const g = groupOffers([tile('EXTRA_SCHEME'), tile('TARGET_REWARD')]);
    expect(g.map((x) => x.group)).toEqual(['TARGET_REWARD', 'EXTRA_SCHEME']);
    expect(groupOffers([tile('EXTRA_SCHEME')]).map((x) => x.group)).toEqual(['EXTRA_SCHEME']);
    expect(OFFER_GROUP_LABEL.TARGET_REWARD).toBe('Earn on your targets');
    expect(OFFER_GROUP_LABEL.EXTRA_SCHEME).toBe('Extra schemes this month');
  });

  it('section "Valid till" only when all tiles share validTo', () => {
    expect(sectionValidTill([t('2026-11-30'), t('2026-11-30')])).toBe('30 Nov 2026');
    expect(sectionValidTill([t('2026-11-30'), t('2026-11-15')])).toBeNull();
    expect(sectionValidTill([])).toBeNull();
  });

  it('day/month formatters are pure string math', () => {
    expect(formatOfferDay('2026-02-01')).toBe('1 Feb 2026');
    expect(formatOfferDayShort('2026-11-15')).toBe('15 Nov');
    expect(formatMonthLabel('2026-10')).toBe('October 2026');
    expect(formatOfferDay('garbage')).toBe('garbage');
  });

  it('monthBounds + previousMonth (leap year, year rollover)', () => {
    expect(monthBounds('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(monthBounds('2026-11')).toEqual({ first: '2026-11-01', last: '2026-11-30' });
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-11')).toBe('2026-10');
  });

  it('fetchPartnerOffers returns tiles, and coerces errors / bad shapes to []', async () => {
    get.mockResolvedValueOnce({ success: true, data: { asOf: 'x', month: 'y', tiles: [tile('EXTRA_SCHEME')] } });
    expect(await fetchPartnerOffers()).toHaveLength(1);
    expect(get).toHaveBeenCalledWith('/api/partner/offers');
    get.mockResolvedValueOnce({ success: false, error: 'nope' });
    expect(await fetchPartnerOffers()).toEqual([]);
    get.mockResolvedValueOnce({ success: true, data: { banners: [] } });
    expect(await fetchPartnerOffers()).toEqual([]);
    get.mockResolvedValueOnce({ success: true, data: undefined });
    expect(await fetchPartnerOffers()).toEqual([]);
  });
});
