/**
 * Unit tests for credits.helpers.ts — focused on the AF-5 formula-injection
 * hardening of generatePayoutFileBuffer (the only WRITE/export path here; the
 * parseUtrUpload reader is a parse path and intentionally untouched).
 *
 * The payout file echoes user/data strings (outlet name, bank name, IFSC, UPI,
 * etc.) into cells that a payments operator opens in Excel, so every string cell
 * must be neutralised against `=,+,-,@`-prefixed formula injection.
 */

import * as XLSX from 'xlsx';
import {
  generatePayoutFileBuffer,
  parseUtrUpload,
  classifyPaymentOutcome,
  PAYOUT_FILE_HEADERS,
  PayoutBatch,
  PayoutBatchRow,
  UtrBatchRow,
} from './credits.helpers';

const row = (over: Partial<PayoutBatchRow> = {}): PayoutBatchRow => ({
  outletId: 'OUT-1',
  outletName: 'Kumar Store',
  phone: '9820100001',
  bankName: 'HDFC',
  accountNumber: '50100123',
  ifscCode: 'HDFC0001',
  upiId: 'kumar@hdfc',
  kycStatus: 'VERIFIED',
  amount: 1500,
  isDeactivated: false,
  utrStatus: 'PENDING',
  entryIds: ['e1'],
  ...over,
});

const batch = (rows: PayoutBatchRow[]): PayoutBatch => ({
  id: 'BATCH-1',
  creditBatchId: 'CB-1',
  period: '2026-06',
  groupType: 'STANDARD',
  status: 'DOWNLOADED',
  downloadedAt: '2026-06-26',
  downloadedBy: 'admin',
  totalAmount: 1500,
  bankSnapshots: [],
  rows,
});

/** Read the payout sheet back as raw arrays (row0 = title, row1 = headers, row2+ = data). */
function readAoa(buf: Buffer): (string | number)[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: '',
    raw: false,
  }) as (string | number)[][];
}

describe('generatePayoutFileBuffer — formula-injection sanitisation (AF-5)', () => {
  it('prefixes injection-prone string cells with an apostrophe', () => {
    const aoa = readAoa(
      generatePayoutFileBuffer(
        batch([
          row({
            outletName: '=cmd|\'/c calc\'!A1',
            bankName: '@SUM(A1)',
            upiId: '+1+1',
            ifscCode: '-2',
          }),
        ]),
      ),
    );
    // Data row is index 2 (title row 0, headers row 1).
    const data = aoa[2];
    // Columns: BatchID, OutletID, OutletName, Phone, BankName, Acct, IFSC, UPI, ...
    expect(data[2]).toBe('\'=cmd|\'/c calc\'!A1'); // Outlet Name
    expect(data[4]).toBe('\'@SUM(A1)'); // Bank Name
    expect(data[6]).toBe('\'-2'); // IFSC
    expect(data[7]).toBe('\'+1+1'); // UPI ID
  });

  it('leaves benign strings and the numeric amount unchanged', () => {
    const aoa = readAoa(generatePayoutFileBuffer(batch([row({ amount: 2500 })])));
    const data = aoa[2];
    expect(data[2]).toBe('Kumar Store'); // Outlet Name unchanged
    expect(data[4]).toBe('HDFC'); // Bank Name unchanged
    expect(data[10]).toBe('2500'); // Payout Amount (raw:false → string "2500")
  });
});

// ─── classifyPaymentOutcome — 3-state Success/Failure classifier ───────────────
//
// Regression: the old boolean parseSuccess treated ANY non-success token (incl.
// the UI's own "Paid" label and a blank cell) as a FAILURE, silently marking the
// payout entry FAILED and clearing it from the wallet with no error. The money
// path must now resolve to exactly one of SUCCESS / FAILURE / INVALID.

describe('classifyPaymentOutcome — 3-state success/failure classifier', () => {
  it.each([
    'Success', 'SUCCESS', 'success',
    'Paid', 'PAID', 'paid',
    'Yes', 'YES', 'Y', 'y',
    '1', 'True', 'TRUE', 'T',
    '  Paid  ', // trimmed
  ])('treats %j as SUCCESS', (raw) => {
    expect(classifyPaymentOutcome(raw)).toBe('SUCCESS');
  });

  it.each([
    'Failed', 'FAILED', 'Failure', 'FAILURE', 'Fail',
    'No', 'NO', 'N', 'n',
    '0', 'False', 'FALSE', 'F',
    'Rejected', 'Bounced', 'Returned',
  ])('treats %j as FAILURE', (raw) => {
    expect(classifyPaymentOutcome(raw)).toBe('FAILURE');
  });

  it.each(['xyz', 'done', 'processing', 'ok', 'pending', 'paidd', 'yep', '2', 'P', 'p'])(
    'treats the unrecognized value %j as INVALID',
    (raw) => {
      expect(classifyPaymentOutcome(raw)).toBe('INVALID');
    },
  );

  it.each(['', '   ', null, undefined])(
    'treats the blank/empty value %j as INVALID',
    (raw) => {
      expect(classifyPaymentOutcome(raw as string)).toBe('INVALID');
    },
  );
});

// ─── parseUtrUpload — Success/Failure handling end-to-end ──────────────────────

const UTR_HEADERS = PAYOUT_FILE_HEADERS; // title row + these headers (row index 1)

/** Build an in-memory payout xlsx the parser understands (title, headers, data). */
function buildUtrBuffer(dataRows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([['Payout File Title'], UTR_HEADERS, ...dataRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payout');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

// Column order mirrors PAYOUT_FILE_HEADERS:
//  Batch ID, Outlet ID, Outlet Name, Phone, Bank Name, Account Number, IFSC,
//  UPI ID, KYC Status, Deactivated, Payout Amount, UTR, Payment Date,
//  Success/Failure, Remarks
function dataRow(opts: {
  batchId?: string;
  outletId: string;
  utr?: string;
  successCell: string;
  remarks?: string;
}): (string | number)[] {
  return [
    opts.batchId ?? 'PD-2026-06-001',
    opts.outletId,
    '', '', '', '', '', '', '', '', '', // name…amount (unused by the parser)
    opts.utr ?? '',
    '', // Payment Date
    opts.successCell,
    opts.remarks ?? '',
  ];
}

const DOWNLOAD_CODE = 'PD-2026-06-001';
const UTR_OPTS = (batchRows: UtrBatchRow[]) => ({
  downloadCode: DOWNLOAD_CODE,
  batchRows,
  knownUtrs: new Map<string, Set<string>>(),
});

describe('parseUtrUpload — Success/Failure outcome handling (payout money path)', () => {
  const batchRows: UtrBatchRow[] = [{ outletId: 'OUT-1', utrStatus: 'PENDING' }];

  it.each(['Paid', 'PAID', 'Success', 'Yes'])(
    'a %j row with a valid UTR is OK + success (will be paid)',
    (cell) => {
      const buf = buildUtrBuffer([
        dataRow({ outletId: 'OUT-1', utr: 'UTR12345678', successCell: cell }),
      ]);
      const res = parseUtrUpload(buf, UTR_OPTS(batchRows));
      const r = res.rows[0];
      expect(r.status).toBe('OK');
      expect(r.success).toBe(true);
      expect(r.errors).toEqual([]);
      expect(res.canProceed).toBe(true);
      expect(res.summary.paidCount).toBe(1);
      expect(res.summary.failedCount).toBe(0);
      expect(res.summary.errors).toBe(0);
    },
  );

  it.each(['Failed', 'No', '0'])(
    'a %j row is OK + failure (legitimately marks the entry FAILED)',
    (cell) => {
      const buf = buildUtrBuffer([dataRow({ outletId: 'OUT-1', successCell: cell })]);
      const res = parseUtrUpload(buf, UTR_OPTS(batchRows));
      const r = res.rows[0];
      expect(r.status).toBe('OK');
      expect(r.success).toBe(false);
      expect(r.errors).toEqual([]);
      expect(res.summary.failedCount).toBe(1);
      expect(res.summary.paidCount).toBe(0);
      expect(res.summary.errors).toBe(0);
      // A failure row needs no UTR and still proceeds.
      expect(res.canProceed).toBe(true);
    },
  );

  it('an unrecognized value is an ERROR row (not applied), blocking the apply', () => {
    const buf = buildUtrBuffer([
      dataRow({ outletId: 'OUT-1', utr: 'UTR12345678', successCell: 'xyz' }),
    ]);
    const res = parseUtrUpload(buf, UTR_OPTS(batchRows));
    const r = res.rows[0];
    expect(r.status).toBe('ERROR');
    expect(r.errors.join(' ')).toMatch(/not recognized/i);
    expect(r.errors.join(' ')).toContain('xyz');
    expect(res.hasErrors).toBe(true);
    expect(res.canProceed).toBe(false); // blind apply blocked
    expect(res.summary.errors).toBe(1);
    expect(res.summary.paidCount).toBe(0);
    expect(res.summary.failedCount).toBe(0);
  });

  it('a BLANK Success/Failure cell is an ERROR row (not a silent failure)', () => {
    const buf = buildUtrBuffer([
      dataRow({ outletId: 'OUT-1', utr: 'UTR12345678', successCell: '' }),
    ]);
    const res = parseUtrUpload(buf, UTR_OPTS(batchRows));
    const r = res.rows[0];
    expect(r.status).toBe('ERROR');
    expect(r.errors.join(' ')).toMatch(/blank/i);
    expect(res.canProceed).toBe(false);
    expect(res.summary.errors).toBe(1);
    expect(res.summary.failedCount).toBe(0);
  });

  it('a SUCCESS row with a blank UTR still errors ("UTR is required")', () => {
    const buf = buildUtrBuffer([
      dataRow({ outletId: 'OUT-1', utr: '', successCell: 'Paid' }),
    ]);
    const res = parseUtrUpload(buf, UTR_OPTS(batchRows));
    const r = res.rows[0];
    expect(r.status).toBe('ERROR');
    expect(r.errors.join(' ')).toMatch(/UTR is required/i);
    expect(res.canProceed).toBe(false);
  });

  it('a mixed file (paid + failed + invalid) blocks the apply on the invalid row', () => {
    const buf = buildUtrBuffer([
      dataRow({ outletId: 'OUT-1', utr: 'UTR11112222', successCell: 'Paid' }),
      dataRow({ outletId: 'OUT-2', successCell: 'Failed' }),
      dataRow({ outletId: 'OUT-3', utr: 'UTR33334444', successCell: 'processing' }),
    ]);
    const res = parseUtrUpload(
      buf,
      UTR_OPTS([
        { outletId: 'OUT-1', utrStatus: 'PENDING' },
        { outletId: 'OUT-2', utrStatus: 'PENDING' },
        { outletId: 'OUT-3', utrStatus: 'PENDING' },
      ]),
    );
    expect(res.summary.paidCount).toBe(1);
    expect(res.summary.failedCount).toBe(1);
    expect(res.summary.errors).toBe(1);
    expect(res.canProceed).toBe(false); // one invalid row blocks the whole apply
  });
});
