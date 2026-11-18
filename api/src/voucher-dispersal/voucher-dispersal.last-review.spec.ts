/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — last full review of ab1dbbbb..4428f734 (2026-11-18): H1 settle failures on a finished
 * campaign are retried by the drain, H2 one settle-failure alert even under concurrency, M1 over-budget excludes
 * queued (queued-at-risk shown apart), M2 late events gated on a guarded write + counted per row, M4 an unknown
 * Hubble status on a failed row is an anomaly (row left), L1 an unchanged failed row is not touched, L2 the webhook
 * re-settle is short and never counted as a failure, L3 batch confirm honours a failing settle.
 */
import { ADMIN, CODE, confirmBody, file, finished, setup } from './dispersal-test-kit.test-spec';
import { WEBHOOK_SETTLE_TX } from './voucher-dispersal.processor';
import { SETTLE_FAILING_REASON } from './voucher-dispersal.service';

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

async function oneFailed(source: 'REJECTED' | 'HUBBLE_FAILED', budget = 2000) {
  const t = setup();
  const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], budget);
  const b = t.rows[1];
  Object.assign(b, { status: 'BUY_FAILED', buyFailureSource: source, buyFailureReason: 'x', referenceSentAt: new Date(), voucherCode: null, boughtAt: null, messageClaimedAt: null, whatsappReceiptId: null, sentAt: null, messageStatus: null });
  t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
  return { t, id, b };
}

describe('H1: a finished campaign with settle failures is re-settled by the drain (never blocked forever)', () => {
  it('COMPLETED_WITH_ERRORS + settleFailures 3 → the next drain settles it and clears the failures', async () => {
    const { t, id } = await oneFailed('HUBBLE_FAILED');
    Object.assign(t.campaigns[0], { settleFailures: 3, settleError: 'P2028' });
    expect((await t.svc.detail(ADMIN, id)).campaign.addPeopleBlockedReason).toBe(SETTLE_FAILING_REASON);
    await t.processor.drain();
    expect(t.campaigns[0]).toMatchObject({ settleFailures: 0, settleError: null, status: 'COMPLETED_WITH_ERRORS' });
    expect((await t.svc.detail(ADMIN, id)).campaign.addPeopleBlockedReason).toBeNull();
  });

  it('a finished campaign with a row back in flight (its webhook re-settle failed) is re-settled by the drain', async () => {
    const { t, b } = await oneFailed('HUBBLE_FAILED');
    Object.assign(b, { status: 'PENDING_RECONCILE', pendingReason: 'HUBBLE_PROCESSING', lastReconcileAt: new Date() });
    await t.processor.drain();
    expect(t.campaigns[0].status).toBe('PROCESSING');
  });
});

describe('H2: exactly one settle-failure alert, even with concurrent failures', () => {
  it('5 concurrent failures from 0 → settleFailures 5 and ONE audit row', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    await Promise.all(Array.from({ length: 5 }, () => (t.processor as any).noteSettleFailure(id, new Error('P2028'))));
    expect(t.campaigns[0].settleFailures).toBe(5);
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_SETTLE_FAILING').length).toBe(1);
  });

  it('crossing from 2 to 4 in one go still alerts once (old < 3 <= new)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    t.campaigns[0].settleFailures = 2;
    await Promise.all([0, 1].map(() => (t.processor as any).noteSettleFailure(id, new Error('x'))));
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_SETTLE_FAILING').length).toBe(1);
  });
});

describe('M1: over budget never counts QUEUED rows; queued vouchers at risk are shown apart', () => {
  it('budget ₹10,000: spent ₹9,500 + queued ₹1,000 → over ₹0, ₹500 of queued at risk; no over-budget audit', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'A', 9500, 'Amazon Pay']], 10000);
    t.rows.push({ ...t.rows[0], id: 'q1', rowNumber: 9, phone: '9000000001', dedupePhone: null, hubbleReferenceId: 'vdq1', status: 'QUEUED', amountPaise: 100000n, voucherCode: null, boughtAt: null });
    await t.processor.checkOverBudget(id);
    expect(t.audits.some((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_OVER_BUDGET')).toBe(false);
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary).toMatchObject({ overBudgetRupees: 0, queuedAtRiskRupees: 500 });
  });

  it('spent + with Hubble + failed-may-complete over the budget → over-budget figure and audit (queued excluded)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'A', 9500, 'Amazon Pay']], 10000);
    t.rows.push({ ...t.rows[0], id: 'p1', rowNumber: 9, phone: '9000000001', dedupePhone: null, hubbleReferenceId: 'vdp1', status: 'PENDING_RECONCILE', amountPaise: 100000n, voucherCode: null, boughtAt: null });
    t.rows.push({ ...t.rows[0], id: 'q1', rowNumber: 10, phone: '9000000002', dedupePhone: null, hubbleReferenceId: 'vdq1', status: 'QUEUED', amountPaise: 30000n, voucherCode: null, boughtAt: null });
    await t.processor.checkOverBudget(id);
    expect(t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_OVER_BUDGET')!.metadata).toMatchObject({ overByRupees: 500, committedRupees: 10500 });
    expect((await t.svc.detail(ADMIN, id)).summary).toMatchObject({ overBudgetRupees: 500, queuedAtRiskRupees: 300 });
  });
});

describe('M2: the late event is gated on a guarded write and counted once per row', () => {
  it('two webhooks for the same late completion → one audit, lateCompletedRows 1 (row marked lateCompletedAt)', async () => {
    const { t, id, b } = await oneFailed('REJECTED', 5000);
    const body = { id: 'H-late', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] };
    const stale = { ...b };
    t.hubble.getOrderByReference.mockResolvedValue(body);
    await Promise.all([t.processor.applyBody(stale as any, body as any), t.processor.applyBody({ ...stale } as any, body as any)]);
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER').length).toBe(1);
    expect(b.lateCompletedAt).toBeInstanceOf(Date);
    expect((await t.svc.detail(ADMIN, id)).summary.lateCompletedRows).toBe(1);
  });

  it('a stale snapshot that says BUY_FAILED while the row is already PENDING → no late event', async () => {
    const { t, b } = await oneFailed('HUBBLE_FAILED');
    const stale = { ...b };
    Object.assign(b, { status: 'PENDING_RECONCILE', pendingReason: 'HUBBLE_PROCESSING' });
    await t.processor.applyBody(stale as any, { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] } as any);
    expect(b.status).toBe('BOUGHT');
    expect(t.audits.some((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER')).toBe(false);
  });
});

describe('M4: an unrecognised Hubble status on a FAILED row is an anomaly — the row is left as it is', () => {
  it('status "WEIRD" → anomaly audit + error log; row stays BUY_FAILED; no late event', async () => {
    const { t, id, b } = await oneFailed('HUBBLE_FAILED');
    const err = jest.spyOn((t.processor as any).logger, 'error');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'WEIRD' });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(b).toMatchObject({ status: 'BUY_FAILED', buyFailureSource: 'HUBBLE_FAILED' });
    expect(t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_UNKNOWN_STATUS_ON_FAILED_ROW')!.metadata).toMatchObject({ campaignId: id, hubbleStatus: 'WEIRD' });
    expect(t.audits.some((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER')).toBe(false);
    expect(err.mock.calls.some((c) => /unrecognised Hubble status/.test(String(c[0])))).toBe(true);
  });
});

describe('L1: a webhook that changes nothing on a failed row touches nothing', () => {
  it('FAILED again on a HUBBLE_FAILED row → updatedAt unchanged, no re-settle', async () => {
    const { t, b } = await oneFailed('HUBBLE_FAILED');
    const before = b.updatedAt;
    const settle = jest.spyOn(t.processor, 'settleCampaign');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'FAILED', failureReason: 'out of stock' });
    expect(await t.processor.reconcileByReference(b.hubbleReferenceId)).toBe('UNCHANGED');
    expect(b.updatedAt).toEqual(before);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('L2: the webhook-path re-settle is short and never counted as a settle failure', () => {
  it('uses WEBHOOK_SETTLE_TX (3 s); a failure leaves it to the drain without bumping settleFailures', async () => {
    expect(WEBHOOK_SETTLE_TX).toEqual({ timeout: 3_000, maxWait: 3_000 });
    const { t, b } = await oneFailed('HUBBLE_FAILED');
    const realTx = t.prisma.$transaction.getMockImplementation()!;
    t.prisma.$transaction.mockImplementation(async (fn: any, opts: any) => {
      if (opts && opts.timeout === WEBHOOK_SETTLE_TX.timeout) throw new Error('Transaction API error: timeout (campaign busy)');
      return realTx(fn, opts);
    });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H-p', status: 'PROCESSING' });
    expect(await t.processor.reconcileByReference(b.hubbleReferenceId)).toBe('PENDING');
    expect(t.campaigns[0]).toMatchObject({ settleFailures: 0, status: 'COMPLETED_WITH_ERRORS' });
    // The drain picks it up (finished campaign, row back in flight).
    t.prisma.$transaction.mockImplementation(realTx);
    b.lastReconcileAt = new Date();
    await t.processor.drain();
    expect(t.campaigns[0].status).toBe('PROCESSING');
  });
});

describe('L3: batch confirm honours a failing settle like the upload does', () => {
  it('settleFailures ≥ 3 → confirm refused with the settle reason', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    Object.assign(t.campaigns[0], { settleFailures: 3, settleError: 'x' });
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))).rejects.toThrow(SETTLE_FAILING_REASON);
  });
});
