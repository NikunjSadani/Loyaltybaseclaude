/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — owner decision (SIMPLIFY, 2026-11-18): "Mark as not bought" is FINAL (closed: no Retry, no
 * lookups); a new reference only after Hubble's definitive FAILED / a canary-verified "no order"; Hubble activity on an
 * EARLIER (retired) order is a loud alert — once per reference + status, counted on the page and in the digest — and
 * never touches the budget. Drain time caps kept.
 */
import { ConflictException } from '@nestjs/common';
import { ADMIN, CODE, finished, setup } from './dispersal-test-kit.test-spec';
import { SUPERSEDED_ALERT_EVENT } from './voucher-dispersal.processor';

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
const byRef = (t: any, map: Record<string, any>) =>
  t.hubble.getOrderByReference.mockImplementation(async (ref: string) => (ref in map ? map[ref] : null));
const alerts = (t: any) => t.audits.filter((a: any) => a.metadata?.event === SUPERSEDED_ALERT_EVENT);

describe('"Mark as not bought" is FINAL', () => {
  it('marked → closed: no Retry offered (closed note instead), the retry endpoint answers 409, Hubble is never asked', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', lastReconcileResult: 'HUBBLE_ON_HOLD' });
    const row = await t.svc.markNotBought(ADMIN, id, b.id, { reason: 'Hubble support confirmed' });
    expect(row).toMatchObject({ canRetryBuy: false, canMarkNotBought: false });
    expect(row.closedNote).toBe('Marked as not bought by Admin One — closed. Arrange any replacement with Hubble outside this campaign.');
    t.hubble.getOrderByReference.mockClear();
    const err = await t.svc.retryBuy(ADMIN, id, b.id).then(() => new Error('resolved'), (e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('Marked as not bought by Admin One — closed. Arrange any replacement with Hubble outside this campaign.');
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalled();
    expect(b.previousReferenceIds).toEqual([]);
    // No lookups by the drain either.
    b.lastReconcileAt = null;
    await t.processor.drain();
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalledWith(b.hubbleReferenceId);
  });

  it('a webhook on a marked row never changes it (alerted once per status instead)', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'MARKED_NOT_BOUGHT', buyFailureReason: 'Marked as not bought by Admin One: x' });
    byRef(t, { [b.hubbleReferenceId]: { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } });
    expect(await t.processor.reconcileByReference(b.hubbleReferenceId)).toBe('SKIPPED');
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(b).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT', voucherCode: null });
    expect(alerts(t).map((a: any) => [a.metadata.kind, a.metadata.hubbleStatus])).toEqual([['MARKED_NOT_BOUGHT', 'SUCCESS']]);
    expect((await t.svc.detail(ADMIN, id)).summary.budgetUsage.spentRupees).toBe(1000);
  });
});

describe('a new reference is issued only after a definitive FAILED / canary-verified no order (pre-existing rules)', () => {
  it('HUBBLE_FAILED + Hubble still FAILED → new reference; earlier references are NOT looked up first', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', previousReferenceIds: ['vdOLD'] });
    const oldRef = b.hubbleReferenceId;
    byRef(t, { [oldRef]: { id: 'H', status: 'FAILED' }, vdOLD: { id: 'O', status: 'SUCCESS' } });
    const r = await t.svc.retryBuy(ADMIN, id, b.id);
    expect(r.row.status).toBe('QUEUED');
    expect(b.previousReferenceIds).toEqual(['vdOLD', oldRef]);
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalledWith('vdOLD');
  });
});

describe('Hubble activity on an EARLIER (retired) order: one loud alert per reference + status; budget unchanged', () => {
  it('webhook SUCCESS twice + PROCESSING on another old reference → 2 alerts, page count, wording; FAILED / no order → none', async () => {
    const { t, id, b } = await rowIn('BOUGHT', { voucherCode: CODE, previousReferenceIds: ['vdA', 'vdB', 'vdC', 'vdD'] });
    const errLog = jest.spyOn((t.processor as any).logger, 'error');
    byRef(t, { vdA: { id: 'x', status: 'SUCCESS' }, vdB: { id: 'y', status: 'PROCESSING' }, vdC: { id: 'z', status: 'FAILED' } });
    const before = (await t.svc.detail(ADMIN, id)).summary.budgetUsage;
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdB');
    await t.processor.reconcileByReference('vdC');
    await t.processor.reconcileByReference('vdD'); // no order
    expect(alerts(t).map((a: any) => [a.entityType, a.entityId, a.metadata.referenceId, a.metadata.hubbleStatus, a.metadata.rowNumber]))
      .toEqual([['VOUCHER_DISPERSAL_CAMPAIGN', id, 'vdA', 'SUCCESS', 3], ['VOUCHER_DISPERSAL_CAMPAIGN', id, 'vdB', 'PROCESSING', 3]]);
    expect(errLog.mock.calls.filter((c) => /EARLIER order/.test(String(c[0]))).length).toBe(2);
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.budgetUsage).toEqual(before); // never counted
    expect(d.summary.earlierOrderAlerts.total).toBe(2);
    expect(d.summary.earlierOrderAlerts.items.map((x: any) => [x.batchNumber, x.rowNumber, x.hubbleStatus]).sort()).toEqual([[1, 3, 'PROCESSING'], [1, 3, 'SUCCESS']]);
    expect(b.status).toBe('BOUGHT');
  });

  it('the page COUNT is the total, not just the latest 20', async () => {
    const { t, id } = await rowIn('BOUGHT', { voucherCode: CODE });
    for (let i = 0; i < 25; i++) {
      await t.prisma.voucherDispersalOrderAlert.create({ data: { campaignId: id, rowId: 'r', batchNumber: 1, rowNumber: 3, referenceId: `vd${i}`, kind: 'SUPERSEDED', hubbleStatus: 'SUCCESS', statusHistory: ['SUCCESS'] } });
    }
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.earlierOrderAlerts.total).toBe(25);
    expect(d.summary.earlierOrderAlerts.items.length).toBe(20);
  });
});

describe('drain time caps (kept)', () => {
  it('a pass already past its deadline (+ grace) does no reconcile / message / settle work; touched campaigns carry over', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const rec = jest.spyOn(t.processor, 'reconcilePending');
    const msg = jest.spyOn(t.processor, 'sendPendingMessages');
    const settle = jest.spyOn(t.processor, 'settleCampaign');
    await t.processor.finishCampaigns(undefined, [id], Date.now() - 60_000);
    expect(settle).not.toHaveBeenCalled();
    await t.processor.drain({ budgetMs: -60_000 });
    expect(rec).not.toHaveBeenCalled();
    expect(msg).not.toHaveBeenCalled();
    settle.mockClear();
    await t.processor.drain();
    expect(settle.mock.calls.map((c) => c[0])).toContain(id);
  });
});

describe('mark-not-bought idempotent; Retry hidden where it would always be refused (kept)', () => {
  it('a second mark returns the current row (one audit); canRetryBuy false while canMarkNotBought', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', lastReconcileResult: 'HUBBLE_ON_HOLD' });
    const before = (await t.svc.rows(ADMIN, id, {})).rows.find((r) => r.id === b.id)!;
    expect(before).toMatchObject({ canMarkNotBought: true, canRetryBuy: false, closedNote: null });
    await t.svc.markNotBought(ADMIN, id, b.id, { reason: 'Hubble support confirmed' });
    const again = await t.svc.markNotBought(ADMIN, id, b.id, { reason: 'double click' });
    expect(again).toMatchObject({ buyFailureSource: 'MARKED_NOT_BOUGHT', canRetryBuy: false });
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_MARKED_NOT_BOUGHT').length).toBe(1);
  });
});
