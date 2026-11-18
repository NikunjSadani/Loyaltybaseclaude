/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — final full review of ab1dbbbb..5b512945 (2026-11-18): H1 late completion of a failed
 * purchase is loud + over-budget shown, H2 a settle that keeps failing is surfaced, M1 a terminal campaign is
 * re-settled when a row goes back in flight, M2 "left" never negative, L2 lock options, L3 settle order.
 */
import { ADMIN, CODE, confirmBody, file, finished, setup } from './dispersal-test-kit.test-spec';
import { CAMPAIGN_LOCK_TX, SETTLE_FAILURES_BEFORE_ALERT } from './voucher-dispersal.processor';

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

/** Budget 2,000: row A bought ₹1,000, row B failed ₹1,000 with `source` (its reference reached Hubble). */
async function oneFailed(source: 'REJECTED' | 'HUBBLE_FAILED', budget = 2000) {
  const t = setup();
  const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], budget);
  const b = t.rows[1];
  Object.assign(b, { status: 'BUY_FAILED', buyFailureSource: source, buyFailureReason: 'x', referenceSentAt: new Date(), voucherCode: null, boughtAt: null, messageClaimedAt: null, whatsappReceiptId: null, sentAt: null, messageStatus: null });
  t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
  return { t, id, b };
}

describe('H1: a failed purchase that Hubble completes later is never silent', () => {
  it('REJECTED → BOUGHT (webhook): loud audit naming campaign / row / amount, error log, and the over-budget figure on the detail', async () => {
    const { t, id, b } = await oneFailed('REJECTED');
    // The REJECTED ₹1,000 was released; a new batch used it.
    const up = await t.svc.uploadBatch(ADMIN, id, file([['9000000001', 'N', 1000, 'Amazon Pay']]));
    await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(up));
    await t.processor.drain({ campaignId: id });
    expect(t.campaigns[0].status).toBe('COMPLETED_WITH_ERRORS');
    const errLog = jest.spyOn((t.processor as any).logger, 'error');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H-late', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    expect(await t.processor.reconcileByReference(b.hubbleReferenceId)).toBe('BOUGHT');
    const late = t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER')!;
    expect(late).toMatchObject({ entityType: 'VOUCHER_DISPERSAL_ROW', entityId: b.id });
    expect(late.metadata).toMatchObject({ campaignId: id, rowNumber: b.rowNumber, amountRupees: 1000, fromSource: 'REJECTED', to: 'BOUGHT' });
    const over = t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_OVER_BUDGET')!;
    expect(over).toMatchObject({ entityType: 'VOUCHER_DISPERSAL_CAMPAIGN', entityId: id });
    expect(over.metadata).toMatchObject({ budgetRupees: 2000, committedRupees: 3000, overByRupees: 1000 });
    expect(errLog.mock.calls.some((c) => /completed LATER/.test(String(c[0])) && String(c[0]).includes(id))).toBe(true);
    expect(errLog.mock.calls.some((c) => /OVER BUDGET/.test(String(c[0])))).toBe(true);
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary).toMatchObject({ overBudgetRupees: 1000, lateCompletedRows: 1 });
  });

  it('HUBBLE_FAILED → PENDING_RECONCILE (Hubble says PROCESSING) is audited as informational (not a late completion — pre-merge L-1)', async () => {
    const { t, id, b } = await oneFailed('HUBBLE_FAILED');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H-p', status: 'PROCESSING' });
    expect(await t.processor.reconcileByReference(b.hubbleReferenceId)).toBe('PENDING');
    expect(t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_FAILED_ROW_PENDING_AGAIN')!.metadata)
      .toMatchObject({ campaignId: id, fromSource: 'HUBBLE_FAILED', amountRupees: 1000 });
    expect(t.audits.some((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER')).toBe(false);
    expect(t.audits.some((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_OVER_BUDGET')).toBe(false);
    expect((await t.svc.detail(ADMIN, id)).summary).toMatchObject({ overBudgetRupees: 0 });
  });
});

describe('M1: a row going back in flight on a finished campaign re-settles it', () => {
  it('webhook PROCESSING on a HUBBLE_FAILED row of a COMPLETED_WITH_ERRORS campaign → campaign PROCESSING; later SUCCESS → COMPLETED', async () => {
    const { t, id, b } = await oneFailed('HUBBLE_FAILED');
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H-p', status: 'PROCESSING' });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(t.campaigns[0].status).toBe('PROCESSING');
    expect((await t.svc.detail(ADMIN, id)).campaign.addPeopleBlockedReason).toMatch(/still being bought/);
    t.hubble.getOrderByReference.mockResolvedValueOnce({ id: 'H-p', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    b.lastReconcileAt = null;
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(b.status).toBe('BOUGHT');
    expect(t.campaigns[0].status).toBe('COMPLETED');
  });
});

describe('H2: a settle that keeps failing is surfaced (audit + settleError + blocked reason)', () => {
  it(`after ${3} consecutive failures: one audit row, settleError on detail + list, add-people reason says to contact tech; a success clears it`, async () => {
    expect(SETTLE_FAILURES_BEFORE_ALERT).toBe(3);
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    t.campaigns[0].status = 'PROCESSING';
    const settle = jest.spyOn(t.processor, 'settleCampaign').mockRejectedValue(new Error('P2028 Transaction API error'));
    for (let i = 0; i < 4; i++) await t.processor.finishCampaigns(id);
    expect(t.campaigns[0].settleFailures).toBe(4);
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_SETTLE_FAILING').length).toBe(1);
    const d = await t.svc.detail(ADMIN, id);
    expect(d.campaign.settleError).toMatch(/P2028/);
    expect(d.campaign.addPeopleBlockedReason).toBe("This campaign's status update keeps failing — contact Gifsy tech.");
    expect((await t.svc.list(ADMIN, {})).find((c) => c.id === id)!.settleError).toMatch(/P2028/);
    settle.mockRestore();
    await t.processor.finishCampaigns(id);
    expect(t.campaigns[0]).toMatchObject({ settleFailures: 0, settleError: null });
    expect((await t.svc.detail(ADMIN, id)).campaign.settleError).toBeNull();
  });

  it('two failures are not yet an alert (settleError stays null)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    t.campaigns[0].status = 'PROCESSING';
    jest.spyOn(t.processor, 'settleCampaign').mockRejectedValue(new Error('boom'));
    await t.processor.finishCampaigns(id);
    await t.processor.finishCampaigns(id);
    expect((await t.svc.detail(ADMIN, id)).campaign.settleError).toBeNull();
  });
});

describe('M2: a batch preview never says a negative amount is left', () => {
  it('spending over budget → remaining ₹0 and overBudgetRupees states by how much', async () => {
    const { t, id } = await oneFailed('REJECTED', 2000);
    // Make the campaign over budget (e.g. a refused purchase completed later), then preview a batch.
    Object.assign(t.rows[1], { status: 'BOUGHT', voucherCode: CODE, boughtAt: new Date() });
    t.campaigns[0].budgetPaise = 150000n;
    t.campaigns[0].status = 'COMPLETED';
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9000000001', 'N', 300, 'Flipkart']]));
    expect(b.summary).toMatchObject({ remainingBudgetRupees: 0, overBudgetRupees: 500, overBudget: true });
  });
});

describe('L2 + L3: lock options and settle order', () => {
  it('CAMPAIGN_LOCK_TX: maxWait (pool wait) 5 s, timeout (incl. row-lock wait) 30 s', () => {
    expect(CAMPAIGN_LOCK_TX).toEqual({ timeout: 30_000, maxWait: 5_000 });
  });

  it('finishCampaigns settles the LONGEST-waiting campaigns first (updatedAt asc) so > 50 all get their turn', async () => {
    const t = setup();
    await t.processor.finishCampaigns();
    const call = t.prisma.voucherDispersalCampaign.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.status === 'PROCESSING');
    expect(call).toMatchObject({ where: { status: 'PROCESSING' }, orderBy: { updatedAt: 'asc' }, take: 50 });
  });
});
