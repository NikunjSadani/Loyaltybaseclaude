/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — owner decision 2026-11-18: Hubble CANCELLED / RETURNED = NOT BOUGHT (released from the
 * budget, Retry with a NEW reference); any OTHER unrecognised status → Retry refused + a GIFSY_ADMIN-only, audited
 * "Mark as not bought" (reason required). Plus review fixes F2 (pending row), F3 (settle time reserve), F5 (over-budget
 * causes), F6 (bought audit fromStatus).
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ADMIN, CODE, finished, setup } from './dispersal-test-kit.test-spec';
import { HUBBLE_NOT_BOUGHT_STATUSES } from './voucher-dispersal.processor';

const STAFF = { sub: 's', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '', name: 'S' } as never;

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

async function rowIn(status: string, extra: Record<string, unknown> = {}, budget = 2000) {
  const t = setup();
  const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], budget);
  const b = t.rows[1];
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  Object.assign(b, {
    status, referenceSentAt: old, placeAttemptAt: old, pendingSince: old, voucherCode: null, boughtAt: null, messageClaimedAt: null,
    whatsappReceiptId: null, sentAt: null, messageStatus: null, ...extra,
  });
  t.campaigns[0].status = status === 'PENDING_RECONCILE' ? 'PROCESSING' : 'COMPLETED_WITH_ERRORS';
  return { t, id, b };
}
const usage = async (t: any, id: string) => (await t.svc.detail(ADMIN, id)).summary.budgetUsage;

describe('owner rule: Hubble CANCELLED / RETURNED = not bought', () => {
  it('the set is CANCELLED + RETURNED (+ FAILED); REFUNDED is not a Hubble order status anywhere in the code', () => {
    expect([...HUBBLE_NOT_BOUGHT_STATUSES].sort()).toEqual(['CANCELLED', 'FAILED', 'RETURNED']);
  });

  for (const st of ['CANCELLED', 'RETURNED']) {
    it(`a pending row reported ${st} → BUY_FAILED HUBBLE_CANCELLED, released from the budget; Retry issues a NEW reference`, async () => {
      const { t, id, b } = await rowIn('PENDING_RECONCILE', { pendingReason: 'HUBBLE_INDETERMINATE' });
      expect((await usage(t, id)).withHubbleRupees).toBe(1000);
      t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: st });
      await t.processor.reconcileByReference(b.hubbleReferenceId);
      expect(b).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'HUBBLE_CANCELLED' });
      expect(b.buyFailureReason).toMatch(new RegExp(`Hubble reported ${st} — not bought`));
      expect(await usage(t, id)).toMatchObject({ withHubbleRupees: 0, failedMayCompleteRupees: 0, floorRupees: 1000 });
      // Retry: Hubble asked again (still CANCELLED) → a new reference, old one kept.
      const oldRef = b.hubbleReferenceId;
      t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: st });
      const r = await t.svc.retryBuy(ADMIN, id, b.id);
      expect(r.row.status).toBe('QUEUED');
      expect(b.hubbleReferenceId).not.toBe(oldRef);
      expect(b.previousReferenceIds).toContain(oldRef);
    });
  }

  it('the report says it in words: "Hubble reported CANCELLED — not bought" / "Marked as not bought by an admin: …"', async () => {
    const { t, id, b } = await rowIn('PENDING_RECONCILE', { pendingReason: 'HUBBLE_INDETERMINATE' });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'CANCELLED' });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    const XLSX = await import('xlsx');
    const wb = XLSX.read((await t.svc.report(ADMIN, id)).buffer);
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
    expect(json.find((r) => r.Phone === '9876543211')).toMatchObject({ 'Voucher status': 'BUY_FAILED', 'Failure reason': 'Hubble reported CANCELLED — not bought' });
  });

  it('a HUBBLE_FAILED row later reported CANCELLED stops counting (FAILED keeps counting)', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x' });
    expect((await usage(t, id)).failedMayCompleteRupees).toBe(1000);
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'CANCELLED' });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(b.buyFailureSource).toBe('HUBBLE_CANCELLED');
    expect((await usage(t, id)).failedMayCompleteRupees).toBe(0);
  });
});

describe('unrecognised status: Retry refused honestly (F2 too) + "Mark as not bought"', () => {
  it('F2: a PENDING row whose retry lookup returns "WEIRD" → 409 (never "applied"), anomaly audit, row left; canMarkNotBought', async () => {
    const { t, id, b } = await rowIn('PENDING_RECONCILE', { pendingReason: 'HUBBLE_INDETERMINATE' });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'WEIRD' });
    const err = await t.svc.retryBuy(ADMIN, id, b.id).then(() => new Error('resolved'), (e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(
      'Hubble reports this order with a status we do not recognise (WEIRD) — we cannot tell whether it was bought. Contact Gifsy tech; if it was not bought, use "Mark as not bought", then retry.',
    );
    expect(b.status).toBe('PENDING_RECONCILE');
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_UNKNOWN_STATUS_ON_FAILED_ROW').length).toBe(1);
    expect(t.audits.some((a) => String(a.metadata?.outcome ?? '').startsWith('HUBBLE_HAS_ORDER'))).toBe(false);
    const rows = await t.svc.rows(ADMIN, id, {});
    expect(rows.rows.find((r) => r.id === b.id)!.canMarkNotBought).toBe(true);
    expect(rows.rows.find((r) => r.id !== b.id)!.canMarkNotBought).toBe(false);
  });

  it('Mark as not bought: GIFSY_ADMIN only, reason required, audited; terminal failed state off the budget and out of the 2-min lookups; Retry then uses a NEW reference', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', lastReconcileResult: 'HUBBLE_WEIRD' });
    await expect(t.svc.markNotBought(STAFF, id, b.id, { reason: 'Hubble support confirmed' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t.svc.markNotBought(ADMIN, id, b.id, { reason: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    const row = await t.svc.markNotBought(ADMIN, id, b.id, { reason: 'Hubble support confirmed on ticket 123' });
    expect(row).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT', canRetryBuy: true, canMarkNotBought: false });
    expect(row.buyFailureReason).toBe('Marked as not bought by an admin: Hubble support confirmed on ticket 123');
    expect(t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_MARKED_NOT_BOUGHT')).toMatchObject({
      actorId: 'admin-1', entityId: b.id, metadata: expect.objectContaining({ campaignId: id, reason: 'Hubble support confirmed on ticket 123', fromStatus: 'BUY_FAILED' }),
    });
    expect((await usage(t, id)).failedMayCompleteRupees).toBe(0);
    // Out of the sweep: a drain asks Hubble nothing about it.
    t.hubble.getOrderByReference.mockClear();
    b.lastReconcileAt = null;
    await t.processor.drain();
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalledWith(b.hubbleReferenceId);
    // Retry → new reference, no lookup needed (the admin's decision).
    const oldRef = b.hubbleReferenceId;
    const r = await t.svc.retryBuy(ADMIN, id, b.id);
    expect(r.row.status).toBe('QUEUED');
    expect(b.previousReferenceIds).toContain(oldRef);
  });

  it('Mark as not bought is refused on a row whose last lookup was recognised (with the reason)', async () => {
    const { t, id, b } = await rowIn('BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x', lastReconcileResult: 'HUBBLE_FAILED' });
    await expect(t.svc.markNotBought(ADMIN, id, b.id, { reason: 'just because' })).rejects.toThrow(/only for a row whose last Hubble answer was a status we do not recognise/);
  });
});

describe('F3: the pass reserves time for settling (a backlog never starves the settle)', () => {
  it('45 queued rows, 1 s per buy, 45 s pass → buying stops ~10 s early and the campaign IS settled in the same pass', async () => {
    const t = setup();
    const rows = Array.from({ length: 45 }, (_, i) => [`98765${(10000 + i).toString()}`, `P${i}`, 100, 'Amazon Pay']);
    const c = await t.svc.createCampaign(ADMIN, { name: 'Big', programLabel: 'P', budgetRupees: 100000 });
    const p = await t.svc.upload(ADMIN, c.id, (await import('./dispersal-test-kit.test-spec')).file(rows));
    await t.svc.confirm(ADMIN, c.id, { previewId: p.previewId, expectedValidCount: 45, expectedTotalRupees: 4500 });
    let clock = Date.now();
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    t.processor.sleep = async () => { clock += 1000; };
    const settle = jest.spyOn(t.processor, 'settleCampaign');
    try {
      const s = await t.processor.drain({ budgetMs: 45_000, maxBuys: 100 });
      expect(s.bought).toBeGreaterThan(0);
      expect(s.bought).toBeLessThanOrEqual(37); // stopped with ~10 s left for the settle step (45 without the reserve)
      expect(settle.mock.calls.map((x) => x[0])).toContain(c.id);
    } finally {
      (Date.now as any).mockRestore?.();
      Date.now = realNow;
    }
  });

  it('touched campaigns (alsoIds) are settled even past the deadline; others stop after a minimum', async () => {
    const t = setup();
    const settle = jest.spyOn(t.processor, 'settleCampaign').mockResolvedValue(false);
    await t.processor.finishCampaigns(undefined, ['t1', 't2'], Date.now() - 1);
    expect(settle.mock.calls.map((x) => x[0]).sort()).toEqual(['t1', 't2']);
  });
});

describe('F5: the over-budget figure comes with its actual causes', () => {
  it('a failed row back with Hubble (not bought later) → cause FAILED_BACK_WITH_HUBBLE, no "bought later" claim', async () => {
    const { t, id } = await rowIn('PENDING_RECONCILE', { buyFailureSource: 'REJECTED', pendingReason: 'HUBBLE_PROCESSING' }, 2000);
    t.campaigns[0].budgetPaise = 150000n; // ₹1,500 — spent ₹1,000 + the row back with Hubble ₹1,000
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary).toMatchObject({ overBudgetRupees: 500, lateCompletedRows: 0, failedBackWithHubbleRows: 1 });
  });
});

describe('F6: the BOUGHT audit records the real previous status', () => {
  it.each([
    ['BUYING', {}],
    ['PENDING_RECONCILE', { pendingReason: 'HUBBLE_INDETERMINATE', buyFailureSource: null }],
    ['PENDING_RECONCILE', { pendingReason: 'HUBBLE_PROCESSING', buyFailureSource: 'HUBBLE_FAILED' }],
    ['BUY_FAILED', { buyFailureSource: 'HUBBLE_FAILED' }],
  ])('from %s', async (from, extra) => {
    const { t, b } = await rowIn(from, extra, 5000);
    const stale = { ...b, status: 'BUY_FAILED' }; // a stale snapshot never decides it
    await t.processor.applyBody(stale as any, { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } as any);
    const bought = t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_BOUGHT' && a.entityId === b.id);
    expect(bought.at(-1)!.metadata.fromStatus).toBe(from); // the last one (the first is the original purchase)
  });
});
