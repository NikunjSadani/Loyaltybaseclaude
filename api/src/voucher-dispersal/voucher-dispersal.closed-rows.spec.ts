/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — review of e0513abc: H1 honest wording after "Mark as not bought" (the row is closed for good);
 * M1 a marked row is never bought / moved by a racing write; M2 a failed earlier-order lookup is alerted + the webhook
 * is told to retry; M3 a SUCCESS that could not be applied is a counted alert; M4 a definitive later lookup clears the
 * "unrecognised" marker; L1 one alert per earlier REFERENCE (race-safe unique key; status changes update it).
 */
import { ConflictException } from '@nestjs/common';
import { ADMIN, CODE, finished, setup } from './dispersal-test-kit.test-spec';

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

async function rowIn(status: string, extra: Record<string, unknown> = {}, budget = 3000) {
  const t = setup();
  const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], budget);
  const b = t.rows[1];
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  Object.assign(b, {
    status, referenceSentAt: old, placeAttemptAt: old, pendingSince: old, voucherCode: null, boughtAt: null, messageClaimedAt: null,
    whatsappReceiptId: null, sentAt: null, messageStatus: null, ...extra,
  });
  t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
  return { t, id, b };
}
const MARK = (b: any) => Object.assign(b, { buyFailureSource: 'MARKED_NOT_BOUGHT', buyFailureReason: 'Marked as not bought by Admin One: x', updatedAt: new Date() });

describe('H1: the retry refusal for an unrecognised answer never promises a retry after a mark', () => {
  it('says the mark CLOSES the row', async () => {
    const { t, id, b } = await rowIn('PENDING_RECONCILE', { pendingReason: 'HUBBLE_INDETERMINATE' });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'ON_HOLD' });
    const err = await t.svc.retryBuy(ADMIN, id, b.id).then(() => new Error('resolved'), (e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(
      'Hubble reports this order with a status we do not recognise (ON_HOLD) — we cannot tell whether it was bought. Contact Gifsy tech; if it was not bought, "Mark as not bought" closes the row (no voucher will be bought for this person in this campaign).',
    );
    expect(err.message).not.toMatch(/then retry|new reference/i);
  });
});

describe('M1: a row marked "not bought" between a read and a write is never bought or moved', () => {
  it('SUCCESS applied from a stale (pre-mark) snapshot → row untouched; a counted alert instead', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x' });
    const stale = { ...b };
    MARK(b); // the mark commits between the read and the write
    await t.processor.applyBody(stale as any, { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } as any);
    expect(b).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT', voucherCode: null, lateCompletedAt: null });
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.earlierOrderAlerts.total).toBe(1);
    expect(d.summary.earlierOrderAlerts.items[0]).toMatchObject({ kind: 'MARKED_NOT_BOUGHT', hubbleStatus: 'SUCCESS', rowNumber: 3 });
  });

  it('PROCESSING from a stale snapshot → not moved to pending; alerted', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x' });
    const stale = { ...b };
    MARK(b);
    await t.processor.applyBody(stale as any, { id: 'H', status: 'PROCESSING' } as any);
    expect(b).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT' });
    expect((await t.svc.detail(ADMIN, id)).summary.earlierOrderAlerts.items[0]).toMatchObject({ kind: 'MARKED_NOT_BOUGHT', hubbleStatus: 'PROCESSING' });
  });

  it('a retry re-queue racing a mark never re-queues the marked row', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x' });
    t.hubble.getOrderByReference.mockImplementationOnce(async () => {
      MARK(b); // the mark commits while the retry is asking Hubble
      return { id: 'H', status: 'FAILED' };
    });
    await expect(t.svc.retryBuy(ADMIN, id, b.id)).rejects.toBeInstanceOf(ConflictException);
    expect(b).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT' });
  });
});

describe('M2: an earlier-order lookup that fails is alerted (once) and reported as failed (the webhook still acks 200 — review of 4d8454ad M3)', () => {
  it('lookup error on a superseded reference → outcome LOOKUP_FAILED + one alert "could not check"', async () => {
    const { t, id } = await rowIn('BOUGHT', { voucherCode: CODE, previousReferenceIds: ['vdA'] });
    t.hubble.getOrderByReference.mockRejectedValue(new Error('timeout'));
    expect(await t.processor.reconcileByReference('vdA')).toBe('LOOKUP_FAILED');
    expect(await t.processor.reconcileByReference('vdA')).toBe('LOOKUP_FAILED');
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.earlierOrderAlerts.total).toBe(1);
    expect(d.summary.earlierOrderAlerts.items[0]).toMatchObject({ referenceId: 'vdA', hubbleStatus: 'LOOKUP_FAILED' });
  });
});

describe('M3: a Hubble SUCCESS that could not be applied is a counted alert', () => {
  it('stale snapshot whose reference was superseded meanwhile → page count 1 (kind NOT_APPLIED)', async () => {
    const { t, id, b } = await rowIn('PENDING_RECONCILE', { pendingReason: 'HUBBLE_INDETERMINATE' });
    const stale = { ...b };
    b.hubbleReferenceId = 'vdnewreference000000000000';
    b.previousReferenceIds = [stale.hubbleReferenceId];
    expect(await t.processor.applyBody(stale as any, { id: 'H9', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } as any)).toBe('SKIPPED');
    await t.processor.applyBody(stale as any, { id: 'H9', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } as any);
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.earlierOrderAlerts.total).toBe(1);
    expect(d.summary.earlierOrderAlerts.items[0]).toMatchObject({ referenceId: stale.hubbleReferenceId, hubbleStatus: 'SUCCESS', kind: 'SUPERSEDED' });
  });
});

describe('M4: a definitive later lookup clears the "unrecognised" marker', () => {
  it('pending HUBBLE_UNKNOWN_STATUS:X, then the sweep finds no order → marker cleared; Retry follows the normal rules again', async () => {
    const { t, id, b } = await rowIn('PENDING_RECONCILE', { pendingReason: 'HUBBLE_UNKNOWN_STATUS:ON_HOLD', lastReconcileResult: 'HUBBLE_ON_HOLD', lastReconcileAt: null });
    t.campaigns[0].status = 'PROCESSING';
    let row = (await t.svc.rows(ADMIN, id, {})).rows.find((r) => r.id === b.id)!;
    expect(row).toMatchObject({ canMarkNotBought: true, canRetryBuy: false });
    t.hubble.getOrderByReference.mockResolvedValueOnce(null);
    await t.processor.drain({ campaignId: id });
    expect(b.pendingReason).toBe('NO_ORDER_AT_HUBBLE_YET');
    row = (await t.svc.rows(ADMIN, id, {})).rows.find((r) => r.id === b.id)!;
    expect(row).toMatchObject({ canMarkNotBought: false, canRetryBuy: true });
  });
});

describe('L1: one alert per earlier REFERENCE — a status change updates it (race-safe unique key)', () => {
  it('PROCESSING then SUCCESS on the same reference → count 1, latest status SUCCESS, history kept', async () => {
    const { t, id } = await rowIn('BOUGHT', { voucherCode: CODE, previousReferenceIds: ['vdA'] });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'x', status: 'PROCESSING' });
    await t.processor.reconcileByReference('vdA');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'x', status: 'SUCCESS' });
    await t.processor.reconcileByReference('vdA');
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.earlierOrderAlerts.total).toBe(1);
    expect(d.summary.earlierOrderAlerts.items[0]).toMatchObject({ referenceId: 'vdA', hubbleStatus: 'SUCCESS', statusHistory: ['PROCESSING', 'SUCCESS'] });
  });

  it('two webhooks racing on the same reference → still one alert (the unique key decides)', async () => {
    const { t, id } = await rowIn('BOUGHT', { voucherCode: CODE, previousReferenceIds: ['vdA'] });
    t.hubble.getOrderByReference.mockResolvedValue({ id: 'x', status: 'SUCCESS' });
    await Promise.all([t.processor.reconcileByReference('vdA'), t.processor.reconcileByReference('vdA')]);
    expect((await t.svc.detail(ADMIN, id)).summary.earlierOrderAlerts.total).toBe(1);
  });
});
