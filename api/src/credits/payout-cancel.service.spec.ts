/**
 * PayoutCancelService (owner 2026-11-25): the file flow (preview → every unusable row must be acknowledged → apply in
 * one transaction, the file stored + named in the audit row), the role gate on every write, and the refusal audit.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PayoutCancelService } from './payout-cancel.service';
import { buildCancelTemplate, COL } from './payout-cancel-file';

const gifsy = { sub: 'g1', role: 'GIFSY_ADMIN', clientId: 'bajaj', phone: '', name: 'G', assumed: true } as const;
const T = new Date(Date.now() - 2 * 86_400_000);
const period = (() => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();

function entries() {
  const base = { clientId: 'bajaj', batchId: 'b1', outletName: 'Shop', fieldId: 'f1', fieldName: 'Incentive', period, failureReason: null, attemptedAt: null, autoInvoiceId: null, tdsSection: 'SEC_194R', tdsDeductedPaise: 0n, payeePan: null, createdAt: T, batch: { batchCode: 'CB-1' }, download: null };
  return [
    { ...base, id: 'e1', outletId: 'O1', amountPaise: 10000n, status: 'PENDING', downloadId: null },
    { ...base, id: 'e2', outletId: 'O2', amountPaise: 20000n, status: 'PAID', downloadId: 'd1' },
  ] as Array<Record<string, any>>;
}

function build(rows: Array<Record<string, any>>) {
  const audits: any[] = [];
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, f]: [string, any]) => (f && typeof f === 'object' && 'in' in f ? f.in.includes(r[k]) : f && typeof f === 'object' && 'not' in f ? r[k] !== f.not : r[k] === f));
  const tx: any = {
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 1),
    creditPayoutEntry: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => match(r, where))),
      updateMany: jest.fn(async ({ where, data }: any) => { const h = rows.filter((r) => match(r, where)); h.forEach((r) => Object.assign(r, data)); return { count: h.length }; }),
    },
    payoutReversalAllocation: { findMany: jest.fn(async () => []) },
    creditReversal: { findMany: jest.fn(async () => []) },
    tdsDeductionEntry: { findMany: jest.fn(async () => []) },
    tdsCreditApplication: { findMany: jest.fn(async () => []) },
    tdsRecoveryEntry: { findMany: jest.fn(async () => []) },
    autoInvoice: { findMany: jest.fn(async () => []), updateMany: jest.fn() },
    gstReimbursement: { findMany: jest.fn(async () => []), updateMany: jest.fn() },
    creditField: { findMany: jest.fn(async () => []) },
    outlet: { findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async ({ data }: any) => { audits.push(data); return data; }) },
  };
  tx.$transaction = jest.fn(async (fn: any) => fn(tx));
  const storage = { generateKey: jest.fn(() => 'payout-cancellations/bajaj/2026-11/k-file.xlsx'), uploadFile: jest.fn(async () => 'gs://x'), deleteFile: jest.fn(async () => undefined) };
  return { svc: new PayoutCancelService(tx, storage as any), tx, storage, audits };
}

function file(): Express.Multer.File {
  const tpl = buildCancelTemplate(
    entries().map((e) => ({ entryId: e.id, batchId: 'b1', batchCode: 'CB-1', outletId: e.outletId, outletName: 'Shop', fieldId: 'f1', fieldName: 'Incentive', period, amountPaise: Number(e.amountPaise), status: e.status === 'PAID' ? 'PENDING' : e.status, kind: 'UNPAID', downloadCode: null, failureReason: null, attemptedAt: null, autoInvoiceId: null })),
    'x',
  );
  const wb = XLSX.read(tpl, { type: 'buffer' });
  const ws = wb.Sheets.Payouts;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
  rows.forEach((r) => { r[COL.cancel] = 'Y'; });
  wb.Sheets.Payouts = XLSX.utils.json_to_sheet(rows);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { buffer, originalname: 'cancel.xlsx' } as Express.Multer.File;
}

describe('PayoutCancelService — file flow', () => {
  it('preview lists what will be cancelled and every row that cannot be (row number + reason) — no write', async () => {
    const rows = entries();
    const { svc, tx } = build(rows);
    const p: any = await svc.uploadFile(gifsy as any, file(), { reason: 'Uploaded twice' });
    expect(p.applied).toBe(false);
    expect(p.ok.map((r: any) => [r.entryId, r.rowNum])).toEqual([['e1', 2]]);
    expect(p.blocked).toEqual([expect.objectContaining({ rowNum: 3, entryId: 'e2', code: 'PAID' })]);
    expect(p.totals.all).toEqual({ count: 1, paise: 10000 });
    expect(tx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
  });

  it('apply is refused until every unusable row is acknowledged; then cancels in one transaction + stores the file', async () => {
    const rows = entries();
    const { svc, storage, audits } = build(rows);
    await expect(svc.uploadFile(gifsy as any, file(), { reason: 'Uploaded twice', apply: 'true', previewedEntryIds: '["e1"]' })).rejects.toBeInstanceOf(ConflictException);
    expect(rows[0].status).toBe('PENDING');
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(audits.at(-1)).toMatchObject({ action: 'REJECT', entityType: 'CREDIT_PAYOUT_CANCELLATION' });

    const res: any = await svc.uploadFile(gifsy as any, file(), { reason: 'Uploaded twice', apply: 'true', acknowledgedRowNums: '[3]', previewedEntryIds: '["e1"]' });
    expect(res.applied).toBe(true);
    expect(res.cancelled.map((r: any) => r.entryId)).toEqual(['e1']);
    expect(rows[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'Uploaded twice', cancelledById: 'g1' });
    expect(rows[1].status).toBe('PAID');
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
    const ok = audits.find((a) => a.action === 'UPDATE');
    expect(ok.metadata).toMatchObject({ source: 'FILE', file: { key: 'payout-cancellations/bajaj/2026-11/k-file.xlsx', name: 'cancel.xlsx' } });
    expect(ok.metadata.acknowledgedNotCancelled).toHaveLength(1);
  });

  it('apply is tied to the preview: refused (with the lists) when the rows it would cancel differ from the previewed ones', async () => {
    const rows = entries();
    rows[1].status = 'PENDING'; // e2 became cancellable after the preview showed only e1
    rows[1].downloadId = null;
    const { svc, storage } = build(rows);
    let err: any;
    try {
      await svc.uploadFile(gifsy as any, file(), { reason: 'Uploaded twice', apply: 'true', previewedEntryIds: '["e1"]' });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().details).toEqual({ added: [expect.objectContaining({ entryId: 'e2', rowNum: 3 })], removed: [] });
    expect(rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    // …and an apply without the previewed list is refused too.
    await expect(svc.uploadFile(gifsy as any, file(), { reason: 'r', apply: 'true' })).rejects.toThrow(/Preview the file first/);
  });

  it('every write is GIFSY_ADMIN-in-a-client only (client admin / un-assumed Gifsy refused before any read)', async () => {
    const { svc, tx } = build(entries());
    const client = { ...gifsy, role: 'CLIENT_ADMIN', assumed: undefined } as any;
    await expect(svc.uploadFile(client, file(), {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.cancel(client, { kind: 'UNPAID', reason: 'x', items: [{ id: 'e1', expectedStatus: 'PENDING', expectedAmountPaise: 10000 }] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.preview({ ...gifsy, assumed: false } as any, { kind: 'UNPAID', batchId: 'b1' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.template(client, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.creditPayoutEntry.findMany).not.toHaveBeenCalled();
  });

  it('on-screen cancel: refusal is audited (REJECT) and nothing is written', async () => {
    const rows = entries();
    const { svc, audits } = build(rows);
    await expect(
      svc.cancel(gifsy as any, { kind: 'UNPAID', reason: 'Wrong', items: [{ id: 'e1', expectedStatus: 'PENDING', expectedAmountPaise: 9999 }] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(rows[0].status).toBe('PENDING');
    expect(audits).toEqual([expect.objectContaining({ action: 'REJECT', metadata: expect.objectContaining({ event: 'PAYOUT_CANCEL_REFUSED', source: 'SCREEN' }) })]);
  });
});
