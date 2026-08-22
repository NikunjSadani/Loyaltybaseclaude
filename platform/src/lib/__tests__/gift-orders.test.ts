/// <reference types="vitest/globals" />
/**
 * Gift dispatch — pure logic (lib/gift-orders).
 *
 * Covers the transition edge-map guard (incl. the Gifsy-only DELIVERED→RETURNED
 * reversal), the confirm-copy for wallet/value-touching edges, the list-filter query
 * builder, the fulfilment-payload builder, and the status-timeline derivation.
 */
import { describe, it, expect } from 'vitest';
import {
  nextStatusOptions,
  isTerminalStatus,
  canTransition,
  isReversal,
  isWalletTouching,
  confirmCopyFor,
  buildListQuery,
  isFiltersEmpty,
  emptyGiftOrderFilters,
  buildFulfilmentPayload,
  resetNonApplicableFields,
  validateFulfilment,
  emptyFulfilmentDraft,
  isVoucherChannel,
  channelLabel,
  buildTimeline,
  type GiftOrderDetail,
} from '../gift-orders';

describe('transition edge-map', () => {
  it('offers forward + cancel edges from live states', () => {
    expect(nextStatusOptions('PENDING')).toEqual(['CONFIRMED', 'CANCELLED']);
    expect(nextStatusOptions('PROCESSING')).toEqual(['DISPATCHED', 'FAILED', 'CANCELLED']);
    expect(nextStatusOptions('DISPATCHED')).toEqual(['DELIVERED', 'RETURNED']);
  });

  it('allows the Gifsy-only DELIVERED→RETURNED reversal edge', () => {
    expect(nextStatusOptions('DELIVERED')).toEqual(['RETURNED']);
    expect(canTransition('DELIVERED', 'RETURNED')).toBe(true);
    expect(isReversal('DELIVERED', 'RETURNED')).toBe(true);
  });

  it('treats terminal states as having no outgoing edges', () => {
    for (const s of ['CANCELLED', 'RETURNED', 'FAILED', 'REVERSED']) {
      expect(nextStatusOptions(s)).toEqual([]);
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it('rejects an illegal transition', () => {
    expect(canTransition('PENDING', 'DELIVERED')).toBe(false);
    expect(canTransition('DELIVERED', 'DISPATCHED')).toBe(false);
  });
});

describe('confirm copy', () => {
  it('flags DELIVERED→RETURNED as a dangerous value reversal', () => {
    const c = confirmCopyFor('DELIVERED', 'RETURNED');
    expect(c.danger).toBe(true);
    expect(c.description.toLowerCase()).toContain('194r');
    expect(isWalletTouching('RETURNED')).toBe(true);
  });

  it('flags CANCELLED / FAILED as dangerous (points refund)', () => {
    expect(confirmCopyFor('PENDING', 'CANCELLED').danger).toBe(true);
    expect(confirmCopyFor('PROCESSING', 'FAILED').danger).toBe(true);
  });

  it('treats a routine forward step as non-dangerous', () => {
    const c = confirmCopyFor('PROCESSING', 'DISPATCHED');
    expect(c.danger).toBe(false);
    expect(isWalletTouching('DISPATCHED')).toBe(false);
  });
});

describe('list-filter query builder', () => {
  it('emits only active constraints (drops the "all" sentinel)', () => {
    const q = buildListQuery({ clientId: 'deoleo', status: 'DISPATCHED', channel: 'all', q: 'DEO-26-1' });
    expect(q).toContain('clientId=deoleo');
    expect(q).toContain('status=DISPATCHED');
    expect(q).not.toContain('channel=');
    expect(q).toContain('q=DEO-26-1');
  });

  it('always paginates and starts with ?', () => {
    const q = buildListQuery(emptyGiftOrderFilters());
    expect(q.startsWith('?')).toBe(true);
    expect(q).toContain('page=1');
    expect(q).toContain('limit=100');
  });

  it('detects an empty filter set', () => {
    expect(isFiltersEmpty(emptyGiftOrderFilters())).toBe(true);
    expect(isFiltersEmpty({ ...emptyGiftOrderFilters(), status: 'DELIVERED' })).toBe(false);
  });
});

describe('fulfilment payload', () => {
  it('requires a channel', () => {
    expect(validateFulfilment(emptyFulfilmentDraft()).ok).toBe(false);
    expect(validateFulfilment({ ...emptyFulfilmentDraft(), fulfilmentChannel: 'GIFSY_WAREHOUSE' }).ok).toBe(true);
  });

  it('sends the FULL editable field set, trimming values and nulling blanks so the backend clears them', () => {
    const body = buildFulfilmentPayload({
      fulfilmentChannel: 'FULFILLED_BY_AMAZON',
      logisticsPartner: '  Amazon Logistics  ',
      trackingNumber: 'TRK1',
      trackingUrl: '',
      supplierOrderRef: '403-123',
      voucherCode: '',
      voucherProvider: '',
    });
    // Every field is present; a blanked field is null (not omitted) so a stale value can
    // be cleared. null (not '') keeps the backend's @IsOptional() @IsUrl() on trackingUrl happy.
    expect(body).toEqual({
      fulfilmentChannel: 'FULFILLED_BY_AMAZON',
      logisticsPartner: 'Amazon Logistics',
      trackingNumber: 'TRK1',
      trackingUrl: null,
      supplierOrderRef: '403-123',
      voucherCode: null,
      voucherProvider: null,
    });
  });

  it('knows a digital-voucher channel', () => {
    expect(isVoucherChannel('DIGITAL_VOUCHER')).toBe(true);
    expect(isVoucherChannel('GIFSY_WAREHOUSE')).toBe(false);
    expect(channelLabel('DIGITAL_VOUCHER')).toBe('Digital voucher');
  });
});

describe('channel toggle field reset', () => {
  const physical = {
    fulfilmentChannel: 'GIFSY_WAREHOUSE',
    logisticsPartner: 'Delhivery',
    trackingNumber: 'TRK1',
    trackingUrl: 'https://t.example/TRK1',
    supplierOrderRef: '403-123',
    voucherCode: 'AMZ-1',
    voucherProvider: 'Amazon Pay',
  };

  it('switching to DIGITAL_VOUCHER drops the shipping fields (keeps voucher fields)', () => {
    const out = resetNonApplicableFields({ ...physical, fulfilmentChannel: 'DIGITAL_VOUCHER' });
    expect(out.logisticsPartner).toBe('');
    expect(out.trackingNumber).toBe('');
    expect(out.trackingUrl).toBe('');
    expect(out.supplierOrderRef).toBe('');
    expect(out.voucherCode).toBe('AMZ-1');
    expect(out.voucherProvider).toBe('Amazon Pay');
  });

  it('switching to a physical channel drops the voucher fields (keeps shipping fields)', () => {
    const out = resetNonApplicableFields(physical);
    expect(out.voucherCode).toBe('');
    expect(out.voucherProvider).toBe('');
    expect(out.trackingNumber).toBe('TRK1');
    expect(out.logisticsPartner).toBe('Delhivery');
  });

  it('a cleared shipping field then rides the payload as null (backend clears it)', () => {
    const toggled = resetNonApplicableFields({ ...physical, fulfilmentChannel: 'DIGITAL_VOUCHER' });
    const body = buildFulfilmentPayload(toggled);
    expect(body.trackingNumber).toBeNull();
    expect(body.trackingUrl).toBeNull();
    expect(body.voucherCode).toBe('AMZ-1');
  });
});

describe('timeline', () => {
  it('prefers backend statusHistory, ordered ascending', () => {
    const o = {
      id: 'o1',
      status: 'DELIVERED',
      createdAt: '2026-01-01T00:00:00Z',
      statusHistory: [
        { status: 'DELIVERED', at: '2026-01-03T00:00:00Z', byName: 'Ops' },
        { status: 'PENDING', at: '2026-01-01T00:00:00Z' },
      ],
    } as GiftOrderDetail;
    const t = buildTimeline(o);
    expect(t[0].status).toBe('Pending');
    expect(t[t.length - 1].status).toBe('Delivered');
    expect(t[t.length - 1].note).toContain('by Ops');
  });

  it('falls back to timestamps when no history', () => {
    const o = {
      id: 'o2',
      status: 'DISPATCHED',
      createdAt: '2026-01-01T00:00:00Z',
      dispatchedAt: '2026-01-02T00:00:00Z',
      trackingNumber: 'TRK9',
    } as GiftOrderDetail;
    const t = buildTimeline(o);
    expect(t.map((s) => s.status)).toContain('Dispatched');
    expect(t.find((s) => s.status === 'Dispatched')?.note).toContain('TRK9');
  });
});
