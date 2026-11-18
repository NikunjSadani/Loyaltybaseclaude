/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — final review of ce4bb272, HIGH: a retry under a NEW reference must never risk a second voucher
 * unseen. (1) every new-reference retry first looks the OLD reference(s) up; (2) activity on a superseded reference
 * counts as SPENT (budget, page, digest) and is alerted; (3) an hourly sweep re-checks old references of released /
 * retried rows (14 days); (4) mark-not-bought idempotent + Retry hidden where always refused; (5) drain time caps.
 */
import { ConflictException } from '@nestjs/common';
import { ADMIN, CODE, confirmBody, file, finished, setup } from './dispersal-test-kit.test-spec';
import { SUPERSEDED_RECHECK_MS } from './voucher-dispersal.processor';

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
const MARKED = { buyFailureSource: 'MARKED_NOT_BOUGHT', buyFailureReason: 'Marked as not bought by an admin: x', lastReconcileResult: 'HUBBLE_ON_HOLD' };
const byRef = (t: any, map: Record<string, any>) =>
  t.hubble.getOrderByReference.mockImplementation(async (ref: string) => (ref in map ? map[ref] : null));

describe('1. every new-reference retry looks the OLD reference(s) up first', () => {
  it('marked row, old reference now SUCCESS → applied (bought late, counted), nothing bought again', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', MARKED);
    byRef(t, { [b.hubbleReferenceId]: { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } });
    const before = t.hubble.placeOrder.mock.calls.length;
    const r = await t.svc.retryBuy(ADMIN, id, b.id);
    expect(r.message).toMatch(/Hubble had bought it after all/);
    expect(b.status).toBe('BOUGHT');
    expect(b.previousReferenceIds).toEqual([]);
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder.mock.calls.length).toBe(before);
  });

  it('marked row, old reference PROCESSING → back to pending, retry refused', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', MARKED);
    byRef(t, { [b.hubbleReferenceId]: { id: 'H', status: 'PROCESSING' } });
    await expect(t.svc.retryBuy(ADMIN, id, b.id)).rejects.toThrow(/still processing the earlier order/);
    expect(b.status).toBe('PENDING_RECONCILE');
  });

  it.each([
    ['FAILED', { id: 'H', status: 'FAILED' }],
    ['no order', null],
  ])('marked row, old reference %s → new reference', async (_l, body) => {
    const { t, id, b } = await rowIn('BUY_FAILED', MARKED);
    const oldRef = b.hubbleReferenceId;
    byRef(t, body ? { [oldRef]: body } : {});
    const r = await t.svc.retryBuy(ADMIN, id, b.id);
    expect(r.row.status).toBe('QUEUED');
    expect(b.previousReferenceIds).toEqual([oldRef]);
  });

  it('marked row, old reference still unrecognised → proceeds (admin decision) and records it', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', MARKED);
    byRef(t, { [b.hubbleReferenceId]: { id: 'H', status: 'ON_HOLD' } });
    const r = await t.svc.retryBuy(ADMIN, id, b.id);
    expect(r.row.status).toBe('QUEUED');
    expect(t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_RETRY_BUY' && a.metadata.outcome === 'REQUEUED_NEW_REFERENCE')!.metadata)
      .toMatchObject({ oldReferenceStatus: 'ON_HOLD', afterMarkNotBought: true });
  });

  it('an EARLIER reference (previousReferenceIds) that Hubble completed → retry refused, recorded as spent', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', previousReferenceIds: ['vdOLD1'] });
    byRef(t, { [b.hubbleReferenceId]: { id: 'H', status: 'FAILED' }, vdOLD1: { id: 'H-old', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } });
    const err = await t.svc.retryBuy(ADMIN, id, b.id).then(() => new Error('resolved'), (e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/an earlier order for this row \(reference vdOLD1\) was completed by Hubble/);
    expect(b.supersededActiveRefs).toEqual(['vdOLD1']);
    const d = await t.svc.detail(ADMIN, id);
    // spent ₹1,000 (row 2) + superseded ₹1,000 + the HUBBLE_FAILED row itself still counting ₹1,000.
    expect(d.summary.budgetUsage).toMatchObject({ spentRupees: 1000, supersededRupees: 1000, failedMayCompleteRupees: 1000, floorRupees: 3000 });
    expect(d.summary.supersededRows).toEqual([{ batchNumber: 1, rowNumber: 3 }]);
  });
});

describe('2. activity on a superseded reference counts as SPENT and is alerted', () => {
  it('webhook SUCCESS / unrecognised on an old reference → counted once per reference; LOOKUP_FAILED alerts only', async () => {
    const { t, id, b } = await rowIn('BOUGHT', { voucherCode: CODE, previousReferenceIds: ['vdA', 'vdB', 'vdC'] });
    byRef(t, { vdA: { id: 'x', status: 'SUCCESS' }, vdB: { id: 'y', status: 'ON_HOLD' } });
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdB');
    t.hubble.getOrderByReference.mockImplementationOnce(async () => { throw new Error('timeout'); });
    await t.processor.reconcileByReference('vdC');
    expect(b.supersededActiveRefs.sort()).toEqual(['vdA', 'vdB']);
    expect((await t.svc.detail(ADMIN, id)).summary.budgetUsage.supersededRupees).toBe(2000);
    const alerts = t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY').map((a) => a.metadata.hubbleStatus);
    expect(alerts).toEqual(expect.arrayContaining(['SUCCESS', 'ON_HOLD', 'LOOKUP_FAILED']));
  });

  it('the buy-time guard counts superseded spend (nothing bought past the budget)', async () => {
    const { t, id } = await rowIn('BOUGHT', { voucherCode: CODE, supersededActiveRefs: ['vdZ'] }, 3000);
    t.campaigns[0].status = 'COMPLETED';
    const up = await t.svc.uploadBatch(ADMIN, id, file([['9000000001', 'N', 500, 'Amazon Pay']]));
    expect(up.summary).toMatchObject({ alreadyCommittedRupees: 3000, remainingBudgetRupees: 0, overBudget: true });
    t.campaigns[0].budgetPaise = 400000n; // raise to ₹4,000 → it fits
    const up2 = await t.svc.uploadBatch(ADMIN, id, file([['9000000001', 'N', 500, 'Amazon Pay']]));
    await t.svc.confirmBatch(ADMIN, id, up2.batchNumber, confirmBody(up2));
    t.campaigns[0].budgetPaise = 300000n; // the guard re-checks under the lock at buy time
    await t.processor.drain({ campaignId: id });
    expect(t.rows.find((r) => r.phone === '9000000001')!).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'BUDGET' });
  });
});

describe('3. the sweep re-checks old references of released / retried rows (hourly, 14 days)', () => {
  it('a released row whose CURRENT reference Hubble later completes is caught without a webhook; not re-asked within the hour', async () => {
    const { t, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'MARKED_NOT_BOUGHT', buyFailureReason: 'x', previousReferenceIds: ['vdP'] });
    byRef(t, { [b.hubbleReferenceId]: { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] }, vdP: { id: 'P', status: 'SUCCESS' } });
    await t.processor.drain();
    expect(b.status).toBe('BOUGHT');
    expect(b.lateCompletedAt).toBeInstanceOf(Date);
    expect(b.supersededActiveRefs).toEqual(['vdP']);
    const n = t.hubble.getOrderByReference.mock.calls.length;
    await t.processor.drain();
    expect(t.hubble.getOrderByReference.mock.calls.length).toBe(n);
    expect(SUPERSEDED_RECHECK_MS).toBe(60 * 60 * 1000);
  });

  it('rows older than 14 days are not re-checked', async () => {
    const { t, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'MARKED_NOT_BOUGHT', buyFailureReason: 'x', updatedAt: new Date(Date.now() - 15 * 86_400_000) });
    t.hubble.getOrderByReference.mockClear();
    await t.processor.drain();
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalledWith(b.hubbleReferenceId);
  });
});

describe('4. mark-not-bought repeat is idempotent; Retry hidden where it would always be refused', () => {
  it('a second mark returns the current row (one audit); canRetryBuy false while canMarkNotBought', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', lastReconcileResult: 'HUBBLE_ON_HOLD' });
    const before = (await t.svc.rows(ADMIN, id, {})).rows.find((r) => r.id === b.id)!;
    expect(before).toMatchObject({ canMarkNotBought: true, canRetryBuy: false });
    await t.svc.markNotBought(ADMIN, id, b.id, { reason: 'Hubble support confirmed' });
    const again = await t.svc.markNotBought(ADMIN, id, b.id, { reason: 'double click' });
    expect(again).toMatchObject({ buyFailureSource: 'MARKED_NOT_BOUGHT', canRetryBuy: true });
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_MARKED_NOT_BOUGHT').length).toBe(1);
  });
});

describe('5. drain time caps', () => {
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
    expect(settle.mock.calls.map((c) => c[0])).toContain(id); // the carried-over touched campaign
  });
});
