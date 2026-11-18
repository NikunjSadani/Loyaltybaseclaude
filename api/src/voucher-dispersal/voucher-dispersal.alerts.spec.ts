/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — earlier-order alert subsystem (coordinator review of 4d8454ad):
 * H1 a lookup failure never overwrites a real Hubble status · H2 FAILED / no order RESOLVES an alert · M2 no lost
 * update · L1 only the unique violation means "already alerted" · L2 history capped + deduped, audits only on real
 * changes · L3 kind upgrades to SUPERSEDED · L4 no false NOT_APPLIED alert for a re-queued row with the same reference ·
 * L7 marked rows are "closed", not "buy failed".
 */
import { ADMIN, CODE, finished, setup } from './dispersal-test-kit.test-spec';
import { SUPERSEDED_ALERT_EVENT } from './voucher-dispersal.processor';

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

async function bought(fakeOpts: { serializeTransactions?: boolean } = {}) {
  const t = setup(fakeOpts);
  const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], 3000);
  const b: any = t.rows[1];
  Object.assign(b, { status: 'BOUGHT', voucherCode: CODE, previousReferenceIds: ['vdA', 'vdB'] });
  t.campaigns[0].status = 'COMPLETED';
  return { t, id, b };
}
const answers = (t: any, seq: Record<string, any[]>) =>
  t.hubble.getOrderByReference.mockImplementation(async (ref: string) => {
    const next = seq[ref]?.shift();
    if (next instanceof Error) throw next;
    return next === undefined ? null : next;
  });
const alertAudits = (t: any) => t.audits.filter((a: any) => a.metadata?.event === SUPERSEDED_ALERT_EVENT);
const alertOf = (t: any, ref: string) => t.orderAlerts.find((a: any) => a.referenceId === ref);

describe('H1 — a lookup failure never overwrites a real Hubble status', () => {
  it('SUCCESS, then the lookup fails → still SUCCESS; lastCheckFailedAt + history; no second audit; outcome LOOKUP_FAILED', async () => {
    const { t } = await bought();
    answers(t, { vdA: [{ id: 'x', status: 'SUCCESS' }, new Error('timeout')] });
    expect(await t.processor.reconcileByReference('vdA')).toBe('SKIPPED');
    expect(await t.processor.reconcileByReference('vdA')).toBe('LOOKUP_FAILED');
    const a = alertOf(t, 'vdA');
    expect(a).toMatchObject({ hubbleStatus: 'SUCCESS', statusHistory: ['SUCCESS', 'LOOKUP_FAILED'], resolvedAt: null });
    expect(a.lastCheckFailedAt).toBeInstanceOf(Date);
    expect(alertAudits(t).length).toBe(1);
  });

  it('the lookup fails first ("couldn\'t check"), then SUCCESS → status SUCCESS (a real change: audited, statusChangedAt moves)', async () => {
    const { t } = await bought();
    answers(t, { vdA: [new Error('timeout'), { id: 'x', status: 'SUCCESS' }] });
    await t.processor.reconcileByReference('vdA');
    const first = { ...alertOf(t, 'vdA') };
    expect(first.hubbleStatus).toBe('LOOKUP_FAILED');
    await t.processor.reconcileByReference('vdA');
    const a = alertOf(t, 'vdA');
    expect(a).toMatchObject({ hubbleStatus: 'SUCCESS', statusHistory: ['LOOKUP_FAILED', 'SUCCESS'] });
    expect(a.statusChangedAt.getTime()).toBeGreaterThanOrEqual(first.statusChangedAt.getTime());
    expect(alertAudits(t).map((x: any) => x.metadata.hubbleStatus)).toEqual(['LOOKUP_FAILED', 'SUCCESS']);
  });

  it('the strongest real status is kept: SUCCESS > unrecognised > PROCESSING', async () => {
    const { t } = await bought();
    answers(t, {
      vdA: [{ status: 'SUCCESS' }, { status: 'PROCESSING' }],
      vdB: [{ status: 'PROCESSING' }, { status: 'ON_HOLD' }, { status: 'PROCESSING' }, { status: 'SUCCESS' }],
    });
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    expect(alertOf(t, 'vdA')).toMatchObject({ hubbleStatus: 'SUCCESS', statusHistory: ['SUCCESS', 'PROCESSING'] });
    for (let i = 0; i < 4; i++) await t.processor.reconcileByReference('vdB');
    expect(alertOf(t, 'vdB')).toMatchObject({ hubbleStatus: 'SUCCESS', statusHistory: ['PROCESSING', 'ON_HOLD', 'PROCESSING', 'SUCCESS'] });
    // Audits only on real (worsening) changes: vdA SUCCESS; vdB PROCESSING, ON_HOLD, SUCCESS.
    expect(alertAudits(t).map((x: any) => `${x.metadata.referenceId}:${x.metadata.hubbleStatus}`)).toEqual(['vdA:SUCCESS', 'vdB:PROCESSING', 'vdB:ON_HOLD', 'vdB:SUCCESS']);
  });
});

describe('H2 — FAILED / no order resolves an alert', () => {
  it('PROCESSING then FAILED → resolved (excluded from the open count, listed as resolved); FAILED alone never creates one', async () => {
    const { t, id } = await bought();
    answers(t, { vdA: [{ status: 'PROCESSING' }, { status: 'FAILED' }], vdB: [{ status: 'FAILED' }] });
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdB');
    expect(alertOf(t, 'vdB')).toBeUndefined();
    const a = alertOf(t, 'vdA');
    expect(a).toMatchObject({ hubbleStatus: 'FAILED', statusHistory: ['PROCESSING', 'FAILED'] });
    expect(a.resolvedAt).toBeInstanceOf(Date);
    const s: any = (await t.svc.detail(ADMIN, id)).summary.earlierOrderAlerts;
    expect(s.total).toBe(0);
    expect(s.items).toEqual([]);
    expect(s.resolvedTotal).toBe(1);
    expect(s.resolvedItems[0]).toMatchObject({ referenceId: 'vdA', hubbleStatus: 'FAILED', statusHistory: ['PROCESSING', 'FAILED'] });
    expect(s.resolvedItems[0].resolvedAt).toBeInstanceOf(Date);
    expect(alertAudits(t).map((x: any) => [x.metadata.hubbleStatus, x.metadata.resolved ?? false])).toEqual([['PROCESSING', false], ['FAILED', true]]);
  });

  it('no order at Hubble (canary-verified) on an existing alert → resolved (NO_ORDER); a later SUCCESS re-opens it (worsened)', async () => {
    const { t, id } = await bought();
    jest.spyOn(t.processor, 'verifyNotFoundCanary').mockResolvedValue({ ok: true, canaryRef: 'vdCANARY' });
    answers(t, { vdA: [{ status: 'PROCESSING' }, null, { status: 'SUCCESS' }] });
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    expect(alertOf(t, 'vdA')).toMatchObject({ hubbleStatus: 'NO_ORDER' });
    expect(alertOf(t, 'vdA').resolvedAt).toBeInstanceOf(Date);
    await t.processor.reconcileByReference('vdA');
    expect(alertOf(t, 'vdA')).toMatchObject({ hubbleStatus: 'SUCCESS', resolvedAt: null, statusHistory: ['PROCESSING', 'NO_ORDER', 'SUCCESS'] });
    expect((await t.svc.detail(ADMIN, id)).summary.earlierOrderAlerts).toMatchObject({ total: 1, resolvedTotal: 0 });
  });

  it('a lookup failure on a RESOLVED alert keeps it resolved (only lastCheckFailedAt + history)', async () => {
    const { t } = await bought();
    answers(t, { vdA: [{ status: 'PROCESSING' }, { status: 'FAILED' }, new Error('down')] });
    for (let i = 0; i < 3; i++) await t.processor.reconcileByReference('vdA');
    const a = alertOf(t, 'vdA');
    expect(a).toMatchObject({ hubbleStatus: 'FAILED', statusHistory: ['PROCESSING', 'FAILED', 'LOOKUP_FAILED'] });
    expect(a.resolvedAt).toBeInstanceOf(Date);
    expect(a.lastCheckFailedAt).toBeInstanceOf(Date);
  });
});

describe('M2 — concurrent updates never drop a status', () => {
  it('two status reports racing on the same alert → both in the history, the strongest kept', async () => {
    const { t, b } = await bought({ serializeTransactions: true });
    const row = { id: b.id, campaignId: b.campaignId, rowNumber: b.rowNumber, batchNumber: 1 };
    await t.processor.recordOrderAlert(row, 'vdA', 'PROCESSING', 'SUPERSEDED');
    await Promise.all([
      t.processor.recordOrderAlert(row, 'vdA', 'ON_HOLD', 'SUPERSEDED'),
      t.processor.recordOrderAlert(row, 'vdA', 'SUCCESS', 'SUPERSEDED'),
    ]);
    const a = alertOf(t, 'vdA');
    expect(a.hubbleStatus).toBe('SUCCESS');
    expect([...a.statusHistory].sort()).toEqual(['ON_HOLD', 'PROCESSING', 'SUCCESS']);
  });
});

describe('L1 — only the unique violation means "already alerted"', () => {
  it('any other create error → not recorded, logged loudly, no update attempted', async () => {
    const { t, b } = await bought();
    const errLog = jest.spyOn((t.processor as any).logger, 'error');
    t.prisma.voucherDispersalOrderAlert.create.mockRejectedValueOnce(new Error('connection reset'));
    const row = { id: b.id, campaignId: b.campaignId, rowNumber: b.rowNumber, batchNumber: 1 };
    expect(await t.processor.recordOrderAlert(row, 'vdA', 'SUCCESS', 'SUPERSEDED')).toBe(false);
    expect(t.prisma.voucherDispersalOrderAlert.update).not.toHaveBeenCalled();
    expect(t.prisma.voucherDispersalOrderAlert.updateMany).not.toHaveBeenCalled();
    expect(t.orderAlerts.length).toBe(0);
    expect(errLog.mock.calls.some((c) => /could NOT record the order alert/.test(String(c[0])) && /connection reset/.test(String(c[0])))).toBe(true);
  });
});

describe('L2 — history capped at 20, consecutive duplicates removed', () => {
  it('repeated identical reports add nothing; a long history keeps the latest 20', async () => {
    const { t, b } = await bought();
    const row = { id: b.id, campaignId: b.campaignId, rowNumber: b.rowNumber, batchNumber: 1 };
    await t.processor.recordOrderAlert(row, 'vdA', 'SUCCESS', 'SUPERSEDED');
    await t.processor.recordOrderAlert(row, 'vdA', 'LOOKUP_FAILED', 'SUPERSEDED');
    await t.processor.recordOrderAlert(row, 'vdA', 'LOOKUP_FAILED', 'SUPERSEDED');
    expect(alertOf(t, 'vdA').statusHistory).toEqual(['SUCCESS', 'LOOKUP_FAILED']);
    for (let i = 0; i < 30; i++) await t.processor.recordOrderAlert(row, 'vdA', i % 2 ? 'LOOKUP_FAILED' : 'PROCESSING', 'SUPERSEDED');
    const h = alertOf(t, 'vdA').statusHistory;
    expect(h.length).toBe(20);
    expect(h[h.length - 1]).toBe('LOOKUP_FAILED');
    expect(alertOf(t, 'vdA').hubbleStatus).toBe('SUCCESS');
    expect(alertAudits(t).length).toBe(1); // none of those were real changes
  });
});

describe('L3 — kind upgrades when the same reference later turns out superseded', () => {
  it('NOT_APPLIED → SUPERSEDED (audited as a change)', async () => {
    const { t, b } = await bought();
    const row = { id: b.id, campaignId: b.campaignId, rowNumber: b.rowNumber, batchNumber: 1 };
    await t.processor.recordOrderAlert(row, 'vdA', 'SUCCESS', 'NOT_APPLIED');
    await t.processor.recordOrderAlert(row, 'vdA', 'SUCCESS', 'SUPERSEDED');
    expect(alertOf(t, 'vdA')).toMatchObject({ kind: 'SUPERSEDED', hubbleStatus: 'SUCCESS' });
    expect(alertAudits(t).map((x: any) => x.metadata.kind)).toEqual(['NOT_APPLIED', 'SUPERSEDED']);
    // Never downgraded back.
    await t.processor.recordOrderAlert(row, 'vdA', 'SUCCESS', 'NOT_APPLIED');
    expect(alertOf(t, 'vdA').kind).toBe('SUPERSEDED');
  });
});

describe('L4 — no false NOT_APPLIED alert for a row re-queued with the SAME reference', () => {
  it('a stale PENDING snapshot, row now QUEUED with the same reference → SKIPPED, no alert / no alert audit', async () => {
    const { t, b } = await bought();
    Object.assign(b, { voucherCode: null, status: 'QUEUED', boughtAt: null });
    const snapshot: any = { ...b, status: 'PENDING_RECONCILE' };
    const out = await t.processor.applyBody(snapshot, { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    expect(out).toBe('SKIPPED');
    expect(t.orderAlerts.length).toBe(0);
    expect(t.audits.filter((x: any) => x.action === 'VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY' || x.metadata?.event === SUPERSEDED_ALERT_EVENT).length).toBe(0);
    expect(b.status).toBe('QUEUED');
  });

  it('a row re-queued with a DIFFERENT reference still alerts (SUPERSEDED)', async () => {
    const { t, b } = await bought();
    const snapshot: any = { ...b, status: 'PENDING_RECONCILE', voucherCode: null };
    Object.assign(b, { voucherCode: null, status: 'QUEUED', boughtAt: null, hubbleReferenceId: 'vd' + 'f'.repeat(24) });
    await t.processor.applyBody(snapshot, { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] });
    expect(t.orderAlerts.map((a: any) => [a.referenceId, a.kind])).toEqual([[snapshot.hubbleReferenceId, 'SUPERSEDED']]);
  });
});

describe('L7 — marked rows are "closed", not "buy failed", on the campaign page', () => {
  it('detail + list + batch counts', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], 3000);
    Object.assign(t.rows[0], { status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT', buyFailureReason: 'Marked as not bought by Admin One: x' });
    Object.assign(t.rows[1], { status: 'BUY_FAILED', buyFailureSource: 'HUBBLE_FAILED', buyFailureReason: 'x' });
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary).toMatchObject({ buyFailed: 1, markedClosed: 1 });
    expect(d.batches[0]).toMatchObject({ buyFailed: 1, markedClosed: 1 });
    const list = await t.svc.list(ADMIN, {} as never);
    expect(list.find((c: any) => c.id === id)!.summary).toMatchObject({ buyFailed: 1, markedClosed: 1 });
  });
});

// ─── Release-gate review of e63d928a ────────────────────────────────────────────────────────────────────────────

const ok = (t: any) => jest.spyOn(t.processor, 'verifyNotFoundCanary').mockResolvedValue({ ok: true, canaryRef: 'vdCANARY' });
const notOk = (t: any) =>
  jest.spyOn(t.processor, 'verifyNotFoundCanary').mockResolvedValue({ ok: false, canaryRef: null, why: 'no canary verified' } as any);

describe('gate H1 — an alert that ever saw SUCCESS / an unrecognised status is NEVER resolved', () => {
  it('SUCCESS then FAILED → stays open at SUCCESS; history + a loud "contradicted" audit; still counted open', async () => {
    const { t, id } = await bought();
    const errLog = jest.spyOn((t.processor as any).logger, 'error');
    answers(t, { vdA: [{ status: 'SUCCESS' }, { status: 'FAILED' }] });
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    expect(alertOf(t, 'vdA')).toMatchObject({ hubbleStatus: 'SUCCESS', resolvedAt: null, statusHistory: ['SUCCESS', 'FAILED'] });
    expect(alertAudits(t).map((x: any) => [x.metadata.hubbleStatus, x.metadata.contradictedBy ?? null])).toEqual([['SUCCESS', null], ['SUCCESS', 'FAILED']]);
    expect(errLog.mock.calls.some((c) => /NOT resolved/.test(String(c[0])))).toBe(true);
    expect((await t.svc.detail(ADMIN, id)).summary.earlierOrderAlerts).toMatchObject({ total: 1, resolvedTotal: 0 });
  });

  it('an unrecognised status then a canary-verified no order → stays open (never resolved)', async () => {
    const { t } = await bought();
    ok(t);
    answers(t, { vdA: [{ status: 'ON_HOLD' }, null] });
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    expect(alertOf(t, 'vdA')).toMatchObject({ hubbleStatus: 'ON_HOLD', resolvedAt: null, statusHistory: ['ON_HOLD', 'NO_ORDER'] });
  });

  it('PROCESSING then no order WITHOUT a verified canary → stays open ("NO_ORDER_UNVERIFIED" in the history)', async () => {
    const { t } = await bought();
    const canary = notOk(t);
    answers(t, { vdA: [{ status: 'PROCESSING' }, null] });
    await t.processor.reconcileByReference('vdA');
    await t.processor.reconcileByReference('vdA');
    expect(canary).toHaveBeenCalledWith('vdA', expect.anything());
    expect(alertOf(t, 'vdA')).toMatchObject({ hubbleStatus: 'PROCESSING', resolvedAt: null, statusHistory: ['PROCESSING', 'NO_ORDER_UNVERIFIED'] });
  });

  it('no order on a reference never alerted → nothing, and no canary call', async () => {
    const { t } = await bought();
    const canary = ok(t);
    answers(t, { vdA: [null] });
    await t.processor.reconcileByReference('vdA');
    expect(t.orderAlerts.length).toBe(0);
    expect(canary).not.toHaveBeenCalled();
  });
});

async function failedRow(source: string, extra: Record<string, unknown> = {}) {
  const t = setup();
  const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], 3000);
  const b: any = t.rows[1];
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  Object.assign(b, {
    status: 'BUY_FAILED', buyFailureSource: source, buyFailureReason: 'x', voucherCode: null, boughtAt: null, referenceSentAt: old,
    placeAttemptAt: old, messageClaimedAt: null, ...extra,
  });
  t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
  return { t, id, b };
}

describe('gate H2 — a failed webhook lookup on a FAILED row\'s CURRENT reference is alerted and re-checked by the sweep', () => {
  it.each(['HUBBLE_FAILED', 'REJECTED'])('%s row: webhook lookup fails → NOT_APPLIED "couldn\'t check" alert; the sweep re-checks; SUCCESS → bought + alert resolved', async (source) => {
    const { t, b } = await failedRow(source);
    const ref = b.hubbleReferenceId;
    answers(t, { [ref]: [new Error('timeout'), new Error('timeout again'), { id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] }] });
    expect(await t.processor.reconcileByReference(ref)).toBe('LOOKUP_FAILED');
    expect(alertOf(t, ref)).toMatchObject({ kind: 'NOT_APPLIED', hubbleStatus: 'LOOKUP_FAILED', resolvedAt: null });
    expect(b.lastReconcileResult).toMatch(/^LOOKUP_FAILED/);
    // The sweep picks it up (bounded) — still failing: stays in the sweep.
    b.lastReconcileAt = new Date(Date.now() - 60 * 60 * 1000);
    await t.processor.reconcilePending(undefined, Date.now() + 60_000);
    expect(b.status).toBe('BUY_FAILED');
    expect(alertOf(t, ref).lastCheckFailedAt).toBeInstanceOf(Date);
    // …until a definitive answer: Hubble SUCCESS → the row is bought, the alert resolved ("applied").
    b.lastReconcileAt = new Date(Date.now() - 60 * 60 * 1000);
    await t.processor.reconcilePending(undefined, Date.now() + 60_000);
    expect(b.status).toBe('BOUGHT');
    expect(alertOf(t, ref)).toMatchObject({ hubbleStatus: 'APPLIED' });
    expect(alertOf(t, ref).resolvedAt).toBeInstanceOf(Date);
    // Answered → out of the sweep.
    t.hubble.getOrderByReference.mockClear();
    await t.processor.reconcilePending(undefined, Date.now() + 60_000);
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalledWith(ref);
  });

  it('a FAILED row whose last lookup was NOT a failure is not swept (unchanged scope)', async () => {
    const { t, b } = await failedRow('HUBBLE_FAILED', { lastReconcileResult: 'HUBBLE_FAILED', lastReconcileAt: new Date(Date.now() - 60 * 60 * 1000) });
    await t.processor.reconcilePending(undefined, Date.now() + 60_000);
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalledWith(b.hubbleReferenceId);
  });

  it('the sweep gets Hubble FAILED → the "couldn\'t check" alert is resolved (FAILED)', async () => {
    const { t, b } = await failedRow('HUBBLE_FAILED');
    const ref = b.hubbleReferenceId;
    answers(t, { [ref]: [new Error('timeout'), { status: 'FAILED' }] });
    await t.processor.reconcileByReference(ref);
    b.lastReconcileAt = new Date(Date.now() - 60 * 60 * 1000);
    await t.processor.reconcilePending(undefined, Date.now() + 60_000);
    expect(alertOf(t, ref)).toMatchObject({ hubbleStatus: 'FAILED' });
    expect(alertOf(t, ref).resolvedAt).toBeInstanceOf(Date);
    expect(b.status).toBe('BUY_FAILED');
  });
});

describe('gate H3 — a webhook for a CANCELLED row is looked up, never silently skipped', () => {
  it('CANCELLED row, Hubble SUCCESS → NOT_APPLIED alert + audit (rowStatus CANCELLED); the row is not changed', async () => {
    const { t, b } = await failedRow('HUBBLE_FAILED');
    Object.assign(b, { status: 'CANCELLED', buyFailureSource: null });
    const errLog = jest.spyOn((t.processor as any).logger, 'error');
    answers(t, { [b.hubbleReferenceId]: [{ id: 'H', status: 'SUCCESS', vouchers: [{ cardNumber: CODE }] }] });
    expect(await t.processor.reconcileByReference(b.hubbleReferenceId)).toBe('SKIPPED');
    expect(alertOf(t, b.hubbleReferenceId)).toMatchObject({ kind: 'NOT_APPLIED', hubbleStatus: 'SUCCESS' });
    expect(alertAudits(t)[0].metadata).toMatchObject({ kind: 'NOT_APPLIED', rowStatus: 'CANCELLED' });
    expect(errLog.mock.calls.some((c) => /after the campaign was cancelled/.test(String(c[0])))).toBe(true);
    expect(b).toMatchObject({ status: 'CANCELLED', voucherCode: null });
  });

  it('CANCELLED row, Hubble FAILED / no order → no alert; lookup error → "couldn\'t check" alert', async () => {
    const { t, b } = await failedRow('HUBBLE_FAILED');
    Object.assign(b, { status: 'CANCELLED', buyFailureSource: null });
    answers(t, { [b.hubbleReferenceId]: [{ status: 'FAILED' }, null, new Error('down')] });
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(t.orderAlerts.length).toBe(0);
    expect(await t.processor.reconcileByReference(b.hubbleReferenceId)).toBe('LOOKUP_FAILED');
    expect(alertOf(t, b.hubbleReferenceId)).toMatchObject({ kind: 'NOT_APPLIED', hubbleStatus: 'LOOKUP_FAILED' });
  });

  it('a BOUGHT row (its own order) is not looked up or alerted', async () => {
    const { t, b } = await bought();
    await t.processor.reconcileByReference(b.hubbleReferenceId);
    expect(t.hubble.getOrderByReference).not.toHaveBeenCalledWith(b.hubbleReferenceId);
    expect(t.orderAlerts.length).toBe(0);
  });
});

describe('gate — settle: rows marked "not bought" are CLOSED, not errors', () => {
  it('all bought except a marked row → COMPLETED (not COMPLETED_WITH_ERRORS)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 1000, 'Amazon Pay']], 3000);
    Object.assign(t.rows[0], { status: 'BOUGHT', voucherCode: CODE, messageClaimedAt: new Date(), messageStatus: 'DELIVERED' });
    Object.assign(t.rows[1], { status: 'BUY_FAILED', buyFailureSource: 'MARKED_NOT_BOUGHT', buyFailureReason: 'Marked as not bought by Admin One: x', messageClaimedAt: null });
    t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
    await t.processor.settleCampaign(id);
    expect(t.campaigns[0].status).toBe('COMPLETED');
  });
});
