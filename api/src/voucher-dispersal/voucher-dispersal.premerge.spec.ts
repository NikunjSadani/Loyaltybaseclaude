/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — pre-merge review of ab1dbbbb..2ae8092d (2026-11-18): M-1 honest retry refusal on an
 * unrecognised Hubble status, M-2 one anomaly audit per status, L-1 "completed later" = BOUGHT after a failure
 * (once), L-2 guarded updatedAt restore, L-4 settle loop deadline + short counter lock, L-5 in-flight grouping.
 */
import { ConflictException } from '@nestjs/common';
import { ADMIN, CODE, finished, setup } from './dispersal-test-kit.test-spec';
import { WEBHOOK_SETTLE_TX } from './voucher-dispersal.processor';

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

async function oneFailed(source: string, extra: Record<string, unknown> = {}) {
  const t = setup();
  const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], 5000);
  const b = t.rows[1];
  Object.assign(b, {
    status: 'BUY_FAILED', buyFailureSource: source, buyFailureReason: 'x', referenceSentAt: new Date(), voucherCode: null, boughtAt: null,
    messageClaimedAt: null, whatsappReceiptId: null, sentAt: null, messageStatus: null, ...extra,
  });
  t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
  return { t, id, b };
}

const LATE = 'VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER';
const ANOMALY = 'VOUCHER_DISPERSAL_UNKNOWN_STATUS_ON_FAILED_ROW';

describe('M-1: retry on an unrecognised Hubble status is refused honestly', () => {
  it('lookup says CANCELLED → 409 "it was not bought — contact Gifsy tech"; anomaly audit kept; no HUBBLE_HAS_ORDER_* claim', async () => {
    const { t, id, b } = await oneFailed('HUBBLE_FAILED');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H-c', status: 'CANCELLED' });
    const err = await t.svc.retryBuy(ADMIN, id, b.id).then(() => new Error('resolved'), (e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('Hubble reports this order as CANCELLED — it was not bought. Contact Gifsy tech before retrying.');
    expect(b.status).toBe('BUY_FAILED');
    expect(t.audits.some((a) => a.metadata?.event === ANOMALY)).toBe(true);
    const retryAudits = t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_RETRY_BUY').map((a) => a.metadata.outcome);
    expect(retryAudits).toEqual(['REFUSED_UNRECOGNISED_HUBBLE_STATUS']);
  });
});

describe('M-2: the sweep audits an unrecognised status once, not every pass', () => {
  it('3 sweep passes with the same "WEIRD" answer → 1 anomaly audit', async () => {
    const { t, b } = await oneFailed('BUDGET'); // a local failure whose reference reached Hubble → in the sweep
    t.hubble.getOrderByReference.mockResolvedValue({ id: 'H', status: 'WEIRD' });
    for (let i = 0; i < 3; i++) {
      b.lastReconcileAt = null; // due again
      await t.processor.drain();
    }
    expect(t.hubble.getOrderByReference.mock.calls.filter((c) => c[0] === b.hubbleReferenceId).length).toBe(3);
    expect(t.audits.filter((a) => a.metadata?.event === ANOMALY).length).toBe(1);
    expect(b.status).toBe('BUY_FAILED');
  });
});

describe('L-1: "completed later" = Hubble BOUGHT a row that had failed — counted once', () => {
  it('failed → PROCESSING is informational only (no late mark); then → BOUGHT is the late completion (once)', async () => {
    const { t, id, b } = await oneFailed('REJECTED');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'PROCESSING' });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(b.status).toBe('PENDING_RECONCILE');
    expect(b.lateCompletedAt).toBeNull();
    expect(t.audits.some((a) => a.metadata?.event === LATE)).toBe(false);
    expect(t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_FAILED_ROW_PENDING_AGAIN')!.metadata).toMatchObject({ campaignId: id, fromSource: 'REJECTED' });
    t.hubble.getOrderByReference.mockResolvedValue({ id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(b.status).toBe('BOUGHT');
    expect(b.lateCompletedAt).toBeInstanceOf(Date);
    expect(t.audits.filter((a) => a.metadata?.event === LATE).map((a) => a.metadata.to)).toEqual(['BOUGHT']);
    expect((await t.svc.detail(ADMIN, id)).summary.lateCompletedRows).toBe(1);
  });

  it('a normal pending row (never failed) bought later is NOT a late completion', async () => {
    const { t, b } = await oneFailed('HUBBLE_FAILED', { status: 'PENDING_RECONCILE', buyFailureSource: null, pendingReason: 'HUBBLE_INDETERMINATE' });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(b.status).toBe('BOUGHT');
    expect(b.lateCompletedAt).toBeNull();
  });

  it('a retry that issues a NEW reference clears lateCompletedAt', async () => {
    const { t, id, b } = await oneFailed('HUBBLE_FAILED', { lateCompletedAt: new Date(0) });
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H', status: 'FAILED' });
    await t.svc.retryBuy(ADMIN, id, b.id);
    expect(b.previousReferenceIds.length).toBe(1);
    expect(b.lateCompletedAt).toBeNull();
  });
});

describe('L-2: noteReconcile restores updatedAt only if the row has not changed since it was read', () => {
  it('a row that moved on meanwhile keeps its new updatedAt', async () => {
    const { t, b } = await oneFailed('HUBBLE_FAILED');
    const snap = { ...b };
    const newer = new Date(Date.now() + 60_000);
    Object.assign(b, { status: 'PENDING_RECONCILE', updatedAt: newer });
    await (t.processor as any).noteReconcile(snap, 'HUBBLE_FAILED');
    expect(b.updatedAt).toEqual(newer);
  });
});

describe('L-4: the settle loop respects the drain deadline; the failure counter uses a short lock wait', () => {
  it('deadline already passed → no settle in this pass', async () => {
    const t = setup();
    const settle = jest.spyOn(t.processor, 'settleCampaign');
    await t.processor.finishCampaigns(undefined, ['a', 'b'], Date.now() - 1);
    expect(settle).not.toHaveBeenCalled();
  });

  it('noteSettleFailure runs in a short transaction (WEBHOOK_SETTLE_TX)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    await (t.processor as any).noteSettleFailure(id, new Error('x'));
    expect(t.prisma.$transaction.mock.calls.at(-1)[1]).toEqual(WEBHOOK_SETTLE_TX);
    expect(t.campaigns[0].settleFailures).toBe(1);
  });
});

describe('L-5: the "finished but in flight" grouping only looks at finished campaigns', () => {
  it('the row grouping is filtered to COMPLETED / COMPLETED_WITH_ERRORS campaigns', async () => {
    const t = setup();
    await t.processor.finishCampaigns();
    const g = t.prisma.voucherDispersalRow.groupBy.mock.calls.find((c: any[]) => c[0]?.by?.[0] === 'campaignId')![0];
    expect(g.where.campaign).toEqual({ status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } });
  });
});
