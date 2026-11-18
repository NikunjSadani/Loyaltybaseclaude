/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — fixes from the two independent money audits of bc6a54ab (2026-11-18):
 * M1 one budget breakdown everywhere (partial — see the doc §10 open question), M2 retry vs promised budget,
 * M3 uploadBatch parses outside the campaign lock, M4 audits inside the transaction, M5 batch notes kept,
 * M6 over-budget wording.
 */
import { ConflictException } from '@nestjs/common';
import { ADMIN, ADMIN2, confirmBody, file, finished, setup } from './dispersal-test-kit.test-spec';

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

describe('M1: ONE budget breakdown — floor, edit refusal and the detail page agree; failed rows are never "in progress"', () => {
  it('spent · with Hubble · failed purchases Hubble may still complete · queued add up to the floor everywhere', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 10000);
    const base = { ...t.rows[0], dedupePhone: null, voucherCode: null };
    t.rows.push({ ...base, id: 'rP', rowNumber: 20, phone: '9000000001', hubbleReferenceId: 'vdp', status: 'PENDING_RECONCILE', amountPaise: 50000n });
    t.rows.push({ ...base, id: 'rF', rowNumber: 21, phone: '9000000002', hubbleReferenceId: 'vdf', status: 'BUY_FAILED', buyFailureSource: 'HUBBLE_FAILED', referenceSentAt: new Date(), amountPaise: 30000n });
    t.rows.push({ ...base, id: 'rN', rowNumber: 22, phone: '9000000003', hubbleReferenceId: 'vdn', status: 'BUY_FAILED', buyFailureSource: 'NOT_SENT', referenceSentAt: null, amountPaise: 70000n });
    t.rows.push({ ...base, id: 'rQ', rowNumber: 23, phone: '9000000004', hubbleReferenceId: 'vdq', status: 'QUEUED', amountPaise: 20000n });
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.budgetUsage).toEqual({ spentRupees: 1000, withHubbleRupees: 500, failedMayCompleteRupees: 300, queuedRupees: 200, supersededRupees: 0, floorRupees: 2000 });
    expect(d.summary.budgetFloorRupees).toBe(2000);
    const err = await t.svc.editCampaign(ADMIN, id, { budgetRupees: 1999 }).then(() => new Error("resolved"), (e: Error) => e);
    expect(err.message).toBe(
      "The budget can't go below ₹2,000 — spent ₹1,000 · with Hubble (not yet confirmed) ₹500 · failed purchases Hubble may still complete ₹300 · queued ₹200.",
    );
    expect(err.message).not.toMatch(/in progress/);
  });
});

describe('M2: a retry never consumes budget a confirmed batch was promised', () => {
  it('budget 10,000; 8 bought; a NOT_SENT failure; batch 2 (2 × 1,000) queued → retry refused with the numbers; allowed after raising', async () => {
    const t = setup();
    const rows = Array.from({ length: 9 }, (_, i) => [`98765432${10 + i}`, `P${i}`, 1000, 'Amazon Pay']);
    const id = await finished(t, rows, 10000);
    const failed = t.rows[8];
    Object.assign(failed, { status: 'BUY_FAILED', buyFailureSource: 'NOT_SENT', referenceSentAt: null, voucherCode: null, boughtAt: null });
    t.campaigns[0].status = 'COMPLETED_WITH_ERRORS';
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9000000001', 'N1', 1000, 'Amazon Pay'], ['9000000002', 'N2', 1000, 'Amazon Pay']]));
    await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b));
    expect(t.rows.filter((r) => r.status === 'QUEUED').length).toBe(2);
    const err = await t.svc.retryBuy(ADMIN, id, failed.id).then(() => new Error("resolved"), (e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(
      'Retrying needs ₹1,000; only ₹0 is left after queued rows and purchases already made or with Hubble — raise the budget (Edit campaign), then retry.',
    );
    expect(failed.status).toBe('BUY_FAILED');
    expect(t.audits.some((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_RETRY_BUY' && a.metadata.outcome === 'REFUSED_BUDGET')).toBe(true);
    await t.svc.editCampaign(ADMIN, id, { budgetRupees: 11000 });
    const ok = await t.svc.retryBuy(ADMIN, id, failed.id);
    expect(ok.row.status).toBe('QUEUED');
  });

  it('retrying a row that is ALREADY counted (pending with Hubble) does not count it twice', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 1000);
    const r = t.rows[0];
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    Object.assign(r, { status: 'PENDING_RECONCILE', voucherCode: null, boughtAt: null, placeAttemptAt: old, pendingSince: old, referenceSentAt: old });
    t.campaigns[0].status = 'PROCESSING';
    // Hubble has no order and the canary is verified → re-queue with the same reference (budget exactly fits).
    t.rows.push({ ...r, id: 'canary', rowNumber: 50, phone: '9000000009', dedupePhone: null, hubbleReferenceId: 'vdcanary', status: 'BOUGHT', hubbleOrderId: 'H-c', hubbleAccount: 'api.myhubble.money#abcdef0123456789', amountPaise: 0n, boughtAt: new Date() });
    t.hubble.getOrderByReference.mockImplementation(async (ref: string) => (ref === 'vdcanary' ? { id: 'H-c', status: 'SUCCESS', referenceId: 'vdcanary' } : null));
    const res = await t.svc.retryBuy(ADMIN, id, r.id).then(() => new Error("resolved"), (e: Error) => e);
    expect((res as Error).message ?? '').not.toMatch(/Retrying needs/);
  });
});

describe('M3: uploadBatch parses and looks up duplicates OUTSIDE the campaign lock', () => {
  it('an edit made while the file is still being checked succeeds, and the preview uses the edited budget', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 5000);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = t.hubble.getProduct.getMockImplementation()!;
    t.hubble.getProduct.mockImplementation(async (pid: string) => { await gate; return real(pid); });
    const txBefore = t.prisma.$transaction.mock.calls.length;
    const upload = t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    await new Promise((r) => setImmediate(r));
    expect(t.prisma.$transaction.mock.calls.length).toBe(txBefore); // no lock taken while parsing
    await expect(t.svc.editCampaign(ADMIN2, id, { budgetRupees: 7000 })).resolves.toMatchObject({ budgetRupees: 7000 });
    release();
    const b = await upload;
    expect(b.summary).toMatchObject({ budgetRupees: 7000, remainingBudgetRupees: 6000, valid: 1 });
  });

  it('the duplicate set is re-checked under the lock (a phone that got a live row meanwhile becomes DUPLICATE)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 5000);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realTx = t.prisma.$transaction.getMockImplementation()!;
    t.prisma.$transaction.mockImplementationOnce(async (fn: any) => { await gate; return realTx(fn); });
    const upload = t.svc.uploadBatch(ADMIN, id, file([['9876543299', 'Late', 500, 'Amazon Pay']]));
    await new Promise((r) => setTimeout(r, 20));
    t.rows.push({ ...t.rows[0], id: 'rLate', rowNumber: 30, phone: '9876543299', dedupePhone: '9876543299', hubbleReferenceId: 'vdlate', status: 'BOUGHT' });
    release();
    const b = await upload;
    expect(b.rows[0]).toMatchObject({ status: 'DUPLICATE' });
    expect(b.rows[0].invalidReason).toMatch(/batch 1/);
    expect(t.rows.find((r) => r.batchNumber === 2)!.hubbleReferenceId).toBeNull();
  });
});

describe('M4: audit rows are written inside the same transaction (no change without history)', () => {
  it('if the edit audit cannot be written, the edit is rolled back and refused', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 5000);
    t.prisma.auditLog.create.mockRejectedValueOnce(new Error('audit table down'));
    await expect(t.svc.editCampaign(ADMIN, id, { budgetRupees: 7000 })).rejects.toThrow(/audit table down/);
    expect(t.campaigns[0].budgetPaise).toBe(500000n);
  });

  it('batch upload / confirm / discard roll back when their audit fails', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 5000);
    t.prisma.auditLog.create.mockRejectedValueOnce(new Error('audit down'));
    await expect(t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]))).rejects.toThrow(/audit down/);
    expect(t.batches.length).toBe(0);
    expect(t.rows.filter((r) => r.batchNumber === 2).length).toBe(0);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    t.prisma.auditLog.create.mockRejectedValueOnce(new Error('audit down'));
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))).rejects.toThrow(/audit down/);
    expect(t.batches[0].status).toBe('PREVIEWED');
    expect(t.rows.find((r) => r.batchNumber === 2)!.status).toBe('VALID');
    expect(t.campaigns[0].status).toBe('COMPLETED');
    t.prisma.auditLog.create.mockRejectedValueOnce(new Error('audit down'));
    await expect(t.svc.discardBatch(ADMIN, id, 2)).rejects.toThrow(/audit down/);
    expect(t.batches[0].status).toBe('PREVIEWED');
    expect(t.rows.filter((r) => r.batchNumber === 2).length).toBe(1);
  });
});

describe('M5: skipped / hidden / warning counts are kept on the batch and shown when it is reopened', () => {
  it('reopening a waiting batch shows the same notes as the upload; the upload audit carries them', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 5000);
    const up = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart'], [], ['9876543212', 'Mina', 300, 'Flipkart']]));
    expect(up.summary.skippedNote).toMatch(/1 row skipped: 1 blank/);
    const again = await t.svc.batchPreview(ADMIN, id, 2);
    expect(again.summary).toMatchObject({
      skippedBlankRows: 1, skippedFormulaRows: 0, hiddenRowsIncluded: 0, skippedNote: up.summary.skippedNote, hiddenNote: null, warningCount: 0,
    });
    const audit = t.audits.find((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_BATCH_UPLOADED')!;
    expect(audit.metadata).toMatchObject({ warningCount: 0, skippedRows: 1, hiddenRowsIncluded: 0 });
  });
});

describe('M6: first-file over-budget message points at Edit campaign', () => {
  it('says "Edit campaign to raise the budget" (not "new campaign")', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay'], ['9876543211', 'B', 800, 'Amazon Pay']]));
    const err = await t.svc.confirm(ADMIN, c.id, confirmBody(p)).then(() => new Error("resolved"), (e: Error) => e);
    expect(err.message).toMatch(/Edit campaign to raise the budget/);
    expect(err.message).not.toMatch(/new campaign/);
  });
});
