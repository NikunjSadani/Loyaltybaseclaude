/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Voucher Dispersal — campaign EDIT (name / budget with a server-computed floor + audit trail) and
 * "ADD MORE PEOPLE" batches (upload → preview → confirm / discard on a finished campaign). Owner-approved
 * 2026-11-18 ("Add to the same campaign"). Money path: every test that confirms checks what Hubble was asked.
 */
import * as XLSX from 'xlsx';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { VoucherDispersalService } from './voucher-dispersal.service';
import { VoucherDispersalProcessor } from './voucher-dispersal.processor';
import { makeFakePrisma } from './fake-prisma.test-spec';

const ADMIN = { sub: 'admin-1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'Admin' } as never;
const ADMIN2 = { sub: 'admin-2', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'A2' } as never;
const STAFF = { sub: 's', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '', name: 'S' } as never;
const CODE = 'AMZN-1234-5678-9999';

function setup() {
  process.env.VOUCHER_DISPERSAL_BRANDS = JSON.stringify([
    { key: 'AMAZON_PAY', label: 'Amazon Pay', productId: 'P_AMZ' },
    { key: 'FLIPKART', label: 'Flipkart', productId: 'P_FK' },
  ]);
  const db = makeFakePrisma();
  const hubble = {
    isConfigured: jest.fn(() => true),
    accountFingerprint: jest.fn(() => 'api.myhubble.money#abcdef0123456789'),
    getProduct: jest.fn(async (id: string) => ({
      productId: id,
      name: id === 'P_FK' ? 'Flipkart' : 'Amazon Pay',
      denominationType: id === 'P_FK' ? 'FIXED' : 'FLEXIBLE',
      denominations: id === 'P_FK' ? [300, 1250] : [],
      minValue: 100,
      maxValue: 10000,
      maxVouchersPerOrder: 1,
    })),
    placeOrder: jest.fn(async (p: { referenceId: string }): Promise<any> => ({
      id: `H-${p.referenceId}`,
      status: 'SUCCESS',
      vouchers: [{ cardNumber: CODE, cardPin: null }],
    })),
    getOrderByReference: jest.fn(async (_ref: string): Promise<any> => null),
  };
  const notifications = {
    sendTrackedWhatsappTemplate: jest.fn(async (_p: any) => {
      const r = await db.prisma.messageDeliveryReceipt.create({ data: { clientId: 'gifsy', channel: 'WHATSAPP', crqid: 'c', status: 'SENT', sentAt: new Date() } });
      return { receiptId: r.id as string, requestId: 'req', error: null as string | null };
    }),
  };
  const processor = new VoucherDispersalProcessor(db.prisma as never, hubble as never, notifications as never);
  processor.sleep = async () => undefined;
  jest.spyOn(processor, 'kick').mockImplementation(() => undefined);
  const svc = new VoucherDispersalService(db.prisma as never, hubble as never, processor);
  return { ...db, hubble, notifications, processor, svc };
}

function file(rows: unknown[][], name = 'r.xlsx'): Express.Multer.File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Phone', 'Name', 'Amount (₹)', 'Brand', 'Note'], ...rows]), 'Recipients');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), originalname: name } as Express.Multer.File;
}

/** Create + upload + confirm + drain → a COMPLETED campaign. */
async function finished(t: ReturnType<typeof setup>, rows: unknown[][], budgetRupees = 10000) {
  const c = await t.svc.createCampaign(ADMIN, { name: 'Diwali', programLabel: 'Bajaj Loyalty', budgetRupees });
  const p = await t.svc.upload(ADMIN, c.id, file(rows, 'first.xlsx'));
  await t.svc.confirm(ADMIN, c.id, { previewId: p.previewId, expectedValidCount: p.summary.valid, expectedTotalRupees: p.summary.totalRupees });
  await t.processor.drain({ campaignId: c.id });
  return c.id;
}

const confirmBody = (p: { previewId: string | null; summary: { valid: number; totalRupees: number } }) => ({
  previewId: p.previewId!,
  expectedValidCount: p.summary.valid,
  expectedTotalRupees: p.summary.totalRupees,
});

afterAll(() => {
  delete process.env.VOUCHER_DISPERSAL_BRANDS;
});

// ─── Edit ─────────────────────────────────────────────────────────────────────────

describe('edit campaign (PATCH /campaigns/:id)', () => {
  it('renames + raises the budget, audits who/when/old→new, and shows the history on the detail', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 2000);
    const c = await t.svc.editCampaign(ADMIN2, id, { name: 'Diwali 2026', budgetRupees: 5000 });
    expect(c).toMatchObject({ name: 'Diwali 2026', budgetRupees: 5000 });
    expect(t.campaigns[0].budgetPaise).toBe(500000n);
    const a = t.audits.find((x) => x.metadata?.event === 'VOUCHER_DISPERSAL_EDITED')!;
    expect(a).toMatchObject({ actorId: 'admin-2', entityId: id, oldValues: { name: 'Diwali', budgetRupees: 2000 }, newValues: { name: 'Diwali 2026', budgetRupees: 5000 } });
    const d = await t.svc.detail(ADMIN, id);
    expect(d.edits).toEqual([
      expect.objectContaining({
        byId: 'admin-2',
        byName: 'Admin Two',
        changes: [
          { field: 'name', from: 'Diwali', to: 'Diwali 2026' },
          { field: 'budgetRupees', from: 2000, to: 5000 },
        ],
      }),
    ]);
    expect(typeof d.edits[0].at).not.toBe('undefined');
  });

  it('lowers the budget only down to spent + committed (floor stated in the refusal); exactly the floor is allowed', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 300, 'Flipkart']], 5000);
    // A row with its reference at Hubble that is still unconfirmed also counts (committed, not spent).
    t.rows.push({ ...t.rows[0], id: 'rowX', rowNumber: 99, dedupePhone: null, phone: '9000000000', hubbleReferenceId: 'vdx', status: 'PENDING_RECONCILE', amountPaise: 50000n, voucherCode: null });
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary.budgetFloorRupees).toBe(1800);
    await expect(t.svc.editCampaign(ADMIN, id, { budgetRupees: 1799 })).rejects.toThrow(/can't go below ₹1,800/);
    await expect(t.svc.editCampaign(ADMIN, id, { budgetRupees: 1799 })).rejects.toBeInstanceOf(BadRequestException);
    const ok = await t.svc.editCampaign(ADMIN, id, { budgetRupees: 1800 });
    expect(ok.budgetRupees).toBe(1800);
  });

  it('refuses a CANCELLED campaign, an empty / no-op change, and non-admins', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    await expect(t.svc.editCampaign(ADMIN, c.id, {})).rejects.toThrow(/Nothing to change/);
    await expect(t.svc.editCampaign(ADMIN, c.id, { name: 'x', budgetRupees: 1000 })).rejects.toThrow(/Nothing to change/);
    await expect(t.svc.editCampaign(ADMIN, c.id, { name: '   ' })).rejects.toThrow(/name/i);
    await expect(t.svc.editCampaign(STAFF, c.id, { name: 'y' })).rejects.toBeInstanceOf(ForbiddenException);
    // A draft can be edited (nothing spent → floor 0).
    expect((await t.svc.editCampaign(ADMIN, c.id, { budgetRupees: 1 })).budgetRupees).toBe(1);
    await t.svc.cancel(ADMIN, c.id);
    await expect(t.svc.editCampaign(ADMIN, c.id, { name: 'y' })).rejects.toThrow(/cancelled/i);
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_EDITED').length).toBe(1);
  });

  it('a raised budget lets a previously over-budget preview be confirmed (first file)', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 1000 });
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 800, 'Amazon Pay'], ['9876543211', 'B', 800, 'Amazon Pay']]));
    await expect(t.svc.confirm(ADMIN, c.id, confirmBody(p))).rejects.toThrow(/over the/);
    await t.svc.editCampaign(ADMIN, c.id, { budgetRupees: 1600 });
    expect((await t.svc.confirm(ADMIN, c.id, confirmBody(p))).status).toBe('PROCESSING');
  });
});

// ─── Batches ──────────────────────────────────────────────────────────────────────

describe('add more people — upload a batch', () => {
  it('is refused before the first confirm, while purchases are in flight, and on a cancelled campaign — each with a reason', async () => {
    const t = setup();
    const c = await t.svc.createCampaign(ADMIN, { name: 'x', programLabel: 'P', budgetRupees: 5000 });
    await expect(t.svc.uploadBatch(ADMIN, c.id, file([['9876543210', 'A', 500, 'Amazon Pay']]))).rejects.toThrow(/first file/);
    const p = await t.svc.upload(ADMIN, c.id, file([['9876543210', 'A', 500, 'Amazon Pay']]));
    await t.svc.confirm(ADMIN, c.id, confirmBody(p));
    // PROCESSING (row still QUEUED) → blocked.
    await expect(t.svc.uploadBatch(ADMIN, c.id, file([['9876543211', 'B', 500, 'Amazon Pay']]))).rejects.toThrow(/still being bought/);
    await expect(t.svc.uploadBatch(ADMIN, c.id, file([['9876543211', 'B', 500, 'Amazon Pay']]))).rejects.toBeInstanceOf(ConflictException);
    const c2 = await t.svc.createCampaign(ADMIN, { name: 'y', programLabel: 'P', budgetRupees: 5000 });
    await t.svc.cancel(ADMIN, c2.id);
    await expect(t.svc.uploadBatch(ADMIN, c2.id, file([['9876543211', 'B', 500, 'Amazon Pay']]))).rejects.toThrow(/cancelled/);
    await expect(t.svc.uploadBatch(STAFF, c.id, file([['9876543211', 'B', 500, 'Amazon Pay']]))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('numbers the batch, marks phones already sent in an earlier batch DUPLICATE ("already sent in batch 1"), and changes no totals until confirmed', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 300, 'Flipkart']], 5000);
    const before = await t.svc.detail(ADMIN, id);
    const listBefore = (await t.svc.list(ADMIN, {})).find((x) => x.id === id)!;
    const reportBefore = XLSX.read((await t.svc.report(ADMIN, id)).buffer);

    const b = await t.svc.uploadBatch(ADMIN, id, file([
      ['9876543210', 'Asha again', 500, 'Amazon Pay'], // bought in batch 1
      ['9876543212', 'Mina', 500, 'Amazon Pay'],
      ['9876543212', 'Mina twice', 500, 'Amazon Pay'], // in-file duplicate
      ['12', 'Bad', 500, 'Amazon Pay'],
    ], 'more.xlsx'));
    expect(b.batchNumber).toBe(2);
    expect(b.batchStatus).toBe('PREVIEWED');
    expect(b.previewId).toMatch(/^pv/);
    expect(b.rows.map((r: any) => r.status)).toEqual(['DUPLICATE', 'VALID', 'DUPLICATE', 'INVALID']);
    expect(b.rows[0].invalidReason).toMatch(/already sent in batch 1/i);
    expect(b.summary).toMatchObject({ total: 4, valid: 1, invalid: 1, duplicates: 2, totalRupees: 500, budgetRupees: 5000, alreadyCommittedRupees: 1300, remainingBudgetRupees: 3700, overBudget: false, crossBatchDuplicates: 1 });
    // Only the NEW valid row gets a Hubble reference.
    expect(t.rows.filter((r) => r.batchNumber === 2 && r.hubbleReferenceId).length).toBe(1);

    // Nothing about the campaign's totals, list summary or report changed.
    const after = await t.svc.detail(ADMIN, id);
    expect(after.summary).toMatchObject({ total: before.summary.total, valid: before.summary.valid, bought: 2, totalRupees: before.summary.totalRupees });
    expect(after.campaign.status).toBe('COMPLETED');
    const listAfter = (await t.svc.list(ADMIN, {})).find((x) => x.id === id)!;
    expect(listAfter.summary).toMatchObject({ ...listBefore.summary, pendingBatchNumber: 2 });
    const reportAfter = XLSX.read((await t.svc.report(ADMIN, id)).buffer);
    expect(XLSX.utils.sheet_to_json(reportAfter.Sheets[reportAfter.SheetNames[0]]).length).toBe(
      XLSX.utils.sheet_to_json(reportBefore.Sheets[reportBefore.SheetNames[0]]).length,
    );
    // The default rows list hides the unconfirmed batch; asking for it by number shows it.
    expect((await t.svc.rows(ADMIN, id, {})).total).toBe(2);
    expect((await t.svc.rows(ADMIN, id, { batch: 2 })).total).toBe(4);
    // The batch list says it is waiting.
    expect(after.batches.map((x: any) => [x.batchNumber, x.status, x.sourceFileName])).toEqual([[1, 'CONFIRMED', 'first.xlsx'], [2, 'PREVIEWED', 'more.xlsx']]);
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(2);
  });

  it('a phone whose batch-1 purchase FAILED is DUPLICATE with a "use Retry on that row" reason; a phone that was INVALID in batch 1 can be sent now', async () => {
    const t = setup();
    t.hubble.placeOrder.mockImplementationOnce(async (p: any) => ({ id: `H-${p.referenceId}`, status: 'FAILED', failureReason: 'out of stock' }));
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', '', 500, 'Amazon Pay']], 5000);
    expect(t.campaigns[0].status).toBe('COMPLETED_WITH_ERRORS');
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543210', 'Asha', 1000, 'Amazon Pay'], ['9876543211', 'Ravi', 500, 'Amazon Pay']]));
    expect(b.rows[0]).toMatchObject({ status: 'DUPLICATE' });
    expect(b.rows[0].invalidReason).toMatch(/batch 1.*failed.*Retry/i);
    expect(b.rows[1]).toMatchObject({ status: 'VALID' });
    // The one-voucher-per-phone DB key moved to the new live row (the dead batch-1 row gave it up).
    await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b));
    const live = t.rows.filter((r) => r.dedupePhone === '9876543211');
    expect(live.map((r) => [r.batchNumber, r.status])).toEqual([[2, 'QUEUED']]);
  });

  it('re-uploading while batch 2 is unconfirmed replaces its rows (same number, new preview id)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const a = await t.svc.uploadBatch(ADMIN, id, file([['9876543212', 'M', 500, 'Amazon Pay'], ['9876543213', 'N', 500, 'Amazon Pay']]));
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543214', 'O', 700, 'Amazon Pay']], 'fixed.xlsx'));
    expect(b.batchNumber).toBe(2);
    expect(b.previewId).not.toBe(a.previewId);
    expect(t.rows.filter((r) => r.batchNumber === 2).map((r) => r.phone)).toEqual(['9876543214']);
    expect(t.batches.length).toBe(1);
    expect(t.batches[0].sourceFileName).toBe('fixed.xlsx');
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(a as any))).rejects.toThrow(/out of date/);
  });
});

describe('add more people — confirm a batch', () => {
  it('refuses over (spent + committed + this batch) > budget telling them to raise it; after Edit it buys ONLY the new rows and re-settles', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']], 1500);
    const firstRef = t.rows[0].hubbleReferenceId;
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart'], ['9876543212', 'Mina', 500, 'Amazon Pay']]));
    expect(b.summary).toMatchObject({ totalRupees: 800, remainingBudgetRupees: 500, overBudget: true });
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))).rejects.toThrow(/Raise the budget/);
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))).rejects.toBeInstanceOf(BadRequestException);
    await t.svc.editCampaign(ADMIN, id, { budgetRupees: 1800 });
    const c = await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b));
    expect(c.status).toBe('PROCESSING');
    expect(t.batches[0]).toMatchObject({ status: 'CONFIRMED', confirmedById: 'admin-1' });
    await t.processor.drain({ campaignId: id });
    const refs = t.hubble.placeOrder.mock.calls.map((x: any) => x[0].referenceId);
    expect(refs[0]).toBe(firstRef);
    expect(refs.slice(1).sort()).toEqual(t.rows.filter((r) => r.batchNumber === 2).map((r) => r.hubbleReferenceId).sort());
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(3);
    expect(t.campaigns[0].status).toBe('COMPLETED');
    const d = await t.svc.detail(ADMIN, id);
    expect(d.summary).toMatchObject({ bought: 3, spentRupees: 1800, valid: 3 });
    expect(d.batches.find((x: any) => x.batchNumber === 2)).toMatchObject({ status: 'CONFIRMED', total: 2, bought: 2, buyFailed: 0, uploadedByName: 'Admin One' });
    expect(t.audits.some((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_BATCH_CONFIRMED' && a.metadata.batchNumber === 2)).toBe(true);
  });

  it('is idempotent per batch: a repeated / concurrent confirm with the same preview queues nothing again; a stale preview id or changed numbers are refused', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    await expect(t.svc.confirmBatch(ADMIN, id, 2, { ...confirmBody(b), expectedTotalRupees: 301 })).rejects.toThrow(/preview changed/);
    await expect(t.svc.confirmBatch(ADMIN, id, 2, { ...confirmBody(b), previewId: 'pvstale' })).rejects.toThrow(/out of date/);
    // Two confirms racing (double click / two tabs): both answer, exactly one queues the rows.
    const both = await Promise.allSettled([t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b)), t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(t.rows.filter((r) => r.batchNumber === 2).map((r) => r.status)).toEqual(['QUEUED']);
    await t.processor.drain({ campaignId: id });
    const again = await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b));
    expect(again.status).toBe('COMPLETED');
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(2);
    expect(t.audits.filter((a) => a.metadata?.event === 'VOUCHER_DISPERSAL_BATCH_CONFIRMED').length).toBe(1);
  });

  it('is refused while the campaign is processing again (e.g. a retry re-opened it) — with a reason', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    t.campaigns[0].status = 'PROCESSING';
    t.rows.push({ ...t.rows[0], id: 'rowY', rowNumber: 50, dedupePhone: null, phone: '9000000001', hubbleReferenceId: 'vdy', status: 'QUEUED', voucherCode: null });
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))).rejects.toThrow(/still being bought/);
    expect(t.rows.filter((r) => r.batchNumber === 2).every((r) => r.status === 'VALID')).toBe(true);
  });
});

describe('add more people — discard', () => {
  it('removes the unconfirmed batch (visible as Discarded), never touches totals; a confirmed batch cannot be discarded; the next upload is batch 3', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    const r = await t.svc.discardBatch(ADMIN, id, 2);
    expect(r).toMatchObject({ batchNumber: 2, discardedRows: 1 });
    expect(t.rows.filter((x) => x.batchNumber === 2).length).toBe(0);
    expect(t.batches[0]).toMatchObject({ status: 'DISCARDED', discardedById: 'admin-1', previewId: null });
    await expect(t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b))).rejects.toThrow(/discarded/);
    await expect(t.svc.discardBatch(ADMIN, id, 2)).rejects.toBeInstanceOf(ConflictException);
    const d = await t.svc.detail(ADMIN, id);
    expect(d.batches.map((x: any) => [x.batchNumber, x.status])).toEqual([[1, 'CONFIRMED'], [2, 'DISCARDED']]);
    expect(d.summary.total).toBe(1);
    const c = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    expect(c.batchNumber).toBe(3);
    await t.svc.confirmBatch(ADMIN, id, 3, confirmBody(c));
    await expect(t.svc.discardBatch(ADMIN, id, 3)).rejects.toThrow(/already confirmed/);
    await expect(t.svc.discardBatch(ADMIN, id, 1)).rejects.toThrow(/first file/);
  });
});

describe('cancel with batches', () => {
  it('stops only rows not yet bought (across batches) and discards an unconfirmed batch; bought batches stay bought', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const b2 = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart'], ['9876543212', 'Mina', 500, 'Amazon Pay']]));
    await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b2));
    // Batch 2 queued (not bought yet) → cancel.
    const res = await t.svc.cancel(ADMIN, id);
    expect(res).toMatchObject({ cancelledRows: 2, alreadyBought: 1, discardedPendingBatchRows: 0 });
    expect(t.rows.find((r) => r.batchNumber === 1)!.status).toBe('BOUGHT');
    await t.processor.drain({ campaignId: id });
    expect(t.hubble.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed batch on a campaign that was re-opened by a retry is discarded by cancel (reason recorded)', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']]));
    t.campaigns[0].status = 'PROCESSING';
    const res = await t.svc.cancel(ADMIN, id);
    expect(res.discardedPendingBatchRows).toBe(1);
    expect(t.batches[0]).toMatchObject({ status: 'DISCARDED', discardReason: expect.stringMatching(/cancelled/i) });
    expect(t.rows.filter((r) => r.batchNumber === 2).length).toBe(0);
  });
});

describe('report + rows with batches', () => {
  it('report has Batch + Source file columns for every confirmed batch; rows filter by batch', async () => {
    const t = setup();
    const id = await finished(t, [['9876543210', 'Asha', 1000, 'Amazon Pay']]);
    const b = await t.svc.uploadBatch(ADMIN, id, file([['9876543211', 'Ravi', 300, 'Flipkart']], 'second.xlsx'));
    await t.svc.confirmBatch(ADMIN, id, 2, confirmBody(b));
    await t.processor.drain({ campaignId: id });
    const wb = XLSX.read((await t.svc.report(ADMIN, id)).buffer);
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
    expect(json.map((r) => [r.Batch, r['Source file'], r.Row, r.Phone])).toEqual([
      [1, 'first.xlsx', 2, '9876543210'],
      [2, 'second.xlsx', 2, '9876543211'],
    ]);
    const only2 = await t.svc.rows(ADMIN, id, { batch: 2 });
    expect(only2.rows.map((r) => [r.batchNumber, r.phone])).toEqual([[2, '9876543211']]);
    expect((await t.svc.rows(ADMIN, id, {})).rows.map((r) => r.batchNumber)).toEqual([1, 2]);
  });
});
