/**
 * "Cancel payouts — upload file" (owner 2026-11-25): template ↔ parser round trip, every bad row listed (never
 * skipped silently), and the CANCELLED-aware bank-result (UTR) upload. Plus a static guard that every bank-file /
 * TDS / partner / report reader keeps CANCELLED out.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { buildCancelTemplate, COL, parseCancelFile } from './payout-cancel-file';
import { parseUtrUpload, UTR_ERROR_CANCELLED_SUCCESS, UTR_NOTICE_CANCELLED } from './credits.helpers';
import type { CancelRowView } from './payout-cancel';

const view = (over: Partial<CancelRowView> = {}): CancelRowView => ({
  entryId: 'e1', batchId: 'b1', batchCode: 'CB-2026-10-001', outletId: 'O1', outletName: '=HYPERLINK("x")', fieldId: 'f1',
  fieldName: 'Visibility', period: '2026-10', amountPaise: 123456, status: 'PENDING', kind: 'UNPAID', downloadCode: null,
  failureReason: null, attemptedAt: null, autoInvoiceId: null, ...over,
});

function fill(buf: Buffer, edit: (rows: Record<string, unknown>[]) => void): Buffer {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
  edit(rows);
  wb.Sheets[wb.SheetNames[0]] = XLSX.utils.json_to_sheet(rows);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('cancel file', () => {
  it('template carries every column, is formula-safe, and parses back the rows marked Y', () => {
    const buf = buildCancelTemplate(
      [view(), view({ entryId: 'e2', outletId: 'O2', status: 'FAILED', kind: 'FAILED', downloadCode: 'PD-1', failureReason: 'Account closed', amountPaise: 5000 })],
      'unpaid and failed rows of this client',
    );
    const sheet = XLSX.read(buf, { type: 'buffer' }).Sheets.Payouts;
    const header = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0];
    expect(header).toEqual(Object.values(COL));
    expect(XLSX.utils.sheet_to_json<Record<string, string>>(sheet)[0][COL.outletName]).toBe(`'=HYPERLINK("x")`);

    const filled = fill(buf, (rows) => {
      rows[0][COL.cancel] = 'y';
      rows[0][COL.reason] = 'Duplicate row';
      rows[1][COL.cancel] = 'Y';
    });
    const p = parseCancelFile(filled, 'Uploaded twice');
    expect(p.headerError).toBeNull();
    expect(p.problems).toEqual([]);
    expect(p.rows).toEqual([
      expect.objectContaining({ rowNum: 2, entryId: 'e1', expectedStatus: 'PENDING', expectedAmountPaise: 123456n, reason: 'Duplicate row' }),
      expect.objectContaining({ rowNum: 3, entryId: 'e2', expectedStatus: 'FAILED', expectedAmountPaise: 5000n, reason: 'Uploaded twice' }),
    ]);
  });

  it('lists every bad row with its reason; unmarked rows are counted, never cancelled', () => {
    const buf = buildCancelTemplate([view(), view({ entryId: 'e2' }), view({ entryId: 'e3' }), view({ entryId: 'e4' }), view({ entryId: '' })], 'x');
    const filled = fill(buf, (rows) => {
      rows[0][COL.cancel] = 'maybe';
      rows[1][COL.cancel] = 'Y';
      rows[1][COL.status] = 'PAID';
      rows[2][COL.cancel] = 'Y';
      rows[2][COL.amount] = 'abc';
      rows[3][COL.cancel] = 'Y'; // no reason anywhere
      rows[4][COL.cancel] = 'Y';
    });
    const p = parseCancelFile(filled, null);
    expect(p.rows).toEqual([]);
    expect(p.problems.map((x) => [x.rowNum, x.reason.slice(0, 24)])).toEqual([
      [2, '"Cancel? (Y)" must be Y '],
      [3, 'Status must be PENDING o'],
      [4, 'Amount is not a valid ru'],
      [5, 'No reason — fill "Reason'],
      [6, 'Entry ID is blank'],
    ]);
  });

  it('refuses a file that is not the template', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Outlet', 'Amount'], ['O1', 1]]), 'S');
    const p = parseCancelFile(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'r');
    expect(p.headerError).toMatch(/Missing column/);
  });
});

describe('bank-result (UTR) upload after a cancellation', () => {
  function utrFile(rows: Array<[string, string, string]>): ArrayBuffer {
    const aoa = [['Payout file'], ['Outlet ID', 'Batch ID', 'UTR', 'Payment Date', 'Success/Failure', 'Remarks'], ...rows.map(([o, u, s]) => [o, 'PD-1', u, '', s, ''])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
    const b = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  const opts = { downloadCode: 'PD-1', batchRows: [{ outletId: 'O1', utrStatus: 'CANCELLED' as const }], knownUtrs: new Map() };

  it('re-uploading the original Failed row is a no-change notice', () => {
    const r = parseUtrUpload(utrFile([['O1', '', 'Failed']]), opts);
    expect(r.rows[0]).toMatchObject({ status: 'SKIP', notice: UTR_NOTICE_CANCELLED });
  });
  it('a Success row for a cancelled payout is a blocking error (never marked paid)', () => {
    const r = parseUtrUpload(utrFile([['O1', 'UTR1', 'Success']]), opts);
    expect(r.rows[0].status).toBe('ERROR');
    expect(r.rows[0].errors).toContain(UTR_ERROR_CANCELLED_SUCCESS);
    expect(r.canProceed).toBe(false);
  });
});

describe('CANCELLED never reaches a bank file, a TDS base, the partner, or a pending total (static guard)', () => {
  const SRC = path.resolve(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
  it.each([
    ['credits/credits.service.ts', /status: \{ in: \['PENDING', 'FAILED'\] \},\s*\/\/ WP5/], // bank-file selection
    ['tds/tds-194r.shared.ts', /status: \{ in: \['PAID', 'PROCESSING'\] \}/], // 194R base
    ['tds/tds.service.ts', /status: 'PAID',\s*\/\/ FIX-4/], // 194C liability
    ['common/payout-statement.helper.ts', /status: \{ in: \['PENDING', 'PROCESSING', 'PAID'\] \}/], // partner payouts
    ['common/outlet-wallet-activity.helper.ts', /status: \{ in: \['PENDING', 'PROCESSING', 'PAID'\] \}/], // partner card
    ['tds-invoicing/tds-reports.service.ts', /status: \{ not: 'CANCELLED' \}/], // TDS payout report
    ['exports/kinds/batch2/tds-payouts.kind.ts', /status: \{ not: 'CANCELLED' \}/], // its export
    ['invoices/invoices.service.ts', /status: \{ not: 'CANCELLED' \}/], // invoice regenerate base
  ])('%s', (file, re) => {
    expect(read(file)).toMatch(re);
  });
});
