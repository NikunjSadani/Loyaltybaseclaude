// Unit tests for the pure payout UTR parser (no Nest / no Prisma).
// Run: npx jest src/payouts/payout-utr.helpers.spec.ts

import * as XLSX from 'xlsx';
import { parsePayoutUtrUpload } from './payout-utr.helpers';

/** Build a real .xlsx ArrayBuffer matching the template header layout. */
function buildBuffer(
  rows: { txnId?: string; utr?: string; status?: string; remarks?: string }[],
  opts: { withRemarks?: boolean } = {},
): ArrayBufferLike {
  const headers = opts.withRemarks
    ? ['Transaction ID', 'Partner Name', 'PAN', 'Amount (₹)', 'Mode', 'UTR', 'Status', 'Remarks']
    : ['Transaction ID', 'Partner Name', 'PAN', 'Amount (₹)', 'Mode', 'UTR', 'Status'];
  const aoa: (string | number)[][] = [
    headers,
    ...rows.map((r) =>
      opts.withRemarks
        ? [r.txnId ?? '', '', '', '', '', r.utr ?? '', r.status ?? '', r.remarks ?? '']
        : [r.txnId ?? '', '', '', '', '', r.utr ?? '', r.status ?? ''],
    ),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  // Return a clean ArrayBuffer slice.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const ctx = (txnIds: string[], known: string[] = []) => ({
  batchTxnIds: new Set(txnIds),
  knownUtrs: new Set(known.map((u) => u.toUpperCase())),
});

describe('parsePayoutUtrUpload', () => {
  it('accepts a valid PAID row with a UTR', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
      ctx(['txn1']),
    );
    expect(res.headerError).toBeNull();
    expect(res.canProceed).toBe(true);
    expect(res.summary.paidCount).toBe(1);
    expect(res.summary.failedCount).toBe(0);
    expect(res.summary.errors).toBe(0);
    const row = res.rows[0];
    expect(row.status).toBe('OK');
    expect(row.outcome).toBe('PAID');
    expect(row.utr).toBe('UTR12345678');
  });

  it('accepts a valid FAILED row with no UTR', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([{ txnId: 'txn1', status: 'FAILED', remarks: 'bank rejected' }], {
        withRemarks: true,
      }),
      ctx(['txn1']),
    );
    expect(res.canProceed).toBe(true);
    expect(res.summary.failedCount).toBe(1);
    expect(res.summary.paidCount).toBe(0);
    const row = res.rows[0];
    expect(row.status).toBe('OK');
    expect(row.outcome).toBe('FAILED');
    expect(row.remarks).toBe('bank rejected');
  });

  it('rejects a Transaction ID not in the batch', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([{ txnId: 'ghost', utr: 'UTR12345678', status: 'PAID' }]),
      ctx(['txn1']),
    );
    expect(res.hasErrors).toBe(true);
    expect(res.canProceed).toBe(false);
    expect(res.rows[0].status).toBe('ERROR');
    expect(res.rows[0].errors.join(' ')).toMatch(/not part of this batch/i);
  });

  it('rejects a PAID row missing its UTR', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([{ txnId: 'txn1', status: 'PAID' }]),
      ctx(['txn1']),
    );
    expect(res.hasErrors).toBe(true);
    expect(res.canProceed).toBe(false);
    expect(res.rows[0].errors.join(' ')).toMatch(/UTR is required/i);
    // The rejection reason must surface on `remarks` too (drives the downloadable
    // error report so the admin can fix-and-re-upload).
    expect(res.rows[0].remarks).toMatch(/UTR is required/i);
  });

  it('rejects a duplicate UTR already used in a prior batch', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
      ctx(['txn1'], ['UTR12345678']),
    );
    expect(res.hasErrors).toBe(true);
    expect(res.rows[0].errors.join(' ')).toMatch(/already been used/i);
  });

  it('rejects a UTR that repeats within the same upload', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([
        { txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' },
        { txnId: 'txn2', utr: 'UTR12345678', status: 'PAID' },
      ]),
      ctx(['txn1', 'txn2']),
    );
    expect(res.hasErrors).toBe(true);
    // First row OK, second flagged as a duplicate-within-upload.
    const second = res.rows.find((r) => r.txnId === 'txn2')!;
    expect(second.status).toBe('ERROR');
    expect(second.errors.join(' ')).toMatch(/more than once/i);
  });

  it('skips blank / SKIP-status rows (counted as skipped, never applied)', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([
        { txnId: 'txn1', status: '' }, // blank status → SKIP
        { txnId: 'txn2', status: 'SKIP' },
        { txnId: 'txn3', utr: 'UTR99999999', status: 'PAID' },
      ]),
      ctx(['txn1', 'txn2', 'txn3']),
    );
    expect(res.summary.skipped).toBe(2);
    expect(res.summary.paidCount).toBe(1);
    expect(res.canProceed).toBe(true);
  });

  it('errors when the header is missing required columns', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Foo', 'Bar'], ['a', 'b']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'x');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const res = parsePayoutUtrUpload(ab, ctx(['txn1']));
    expect(res.headerError).toMatch(/Transaction ID.*Status|official UTR template/i);
    expect(res.canProceed).toBe(false);
  });

  it('returns a header error when the batch has no transactions', () => {
    const res = parsePayoutUtrUpload(
      buildBuffer([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
      ctx([]),
    );
    expect(res.headerError).toMatch(/no payout transactions/i);
    expect(res.canProceed).toBe(false);
  });

  it('round-trip: ignores the new read-only beneficiary columns and keys off ID/UTR/Status', () => {
    // Build an upload that mirrors the EXPORT layout — the beneficiary columns sit
    // BETWEEN "Mode" and "UTR". The parser must locate columns by header name and
    // ignore the extras, so the re-upload round-trip is unaffected.
    const headers = [
      'Transaction ID', 'Partner Name', 'PAN', 'Amount (₹)', 'Mode',
      'Beneficiary Name', 'Bank Account Number', 'IFSC', 'Bank Name', 'UPI ID',
      'UTR', 'Status',
    ];
    const aoa: (string | number)[][] = [
      headers,
      // txn1 PAID with a UTR; the beneficiary cells are filled but must be ignored.
      ['txn1', 'Acme', 'ABCDE1234F', '1000.00', 'BANK_TRANSFER',
        'Ravi Kumar', '0011223344', 'HDFC0001234', 'HDFC Bank', '',
        'UTR12345678', 'PAID'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    const res = parsePayoutUtrUpload(ab, ctx(['txn1']));
    expect(res.headerError).toBeNull();
    expect(res.canProceed).toBe(true);
    expect(res.summary.paidCount).toBe(1);
    const row = res.rows[0];
    expect(row.txnId).toBe('txn1');
    expect(row.outcome).toBe('PAID');
    expect(row.utr).toBe('UTR12345678');
  });
});

describe('parsePayoutUtrUpload — PROCESS-FIRST guard + Paid outside platform', () => {
  function buf(rows: (string | number)[][]): ArrayBufferLike {
    const aoa = [['Transaction ID', 'UTR', 'Status', 'Paid outside platform (Y/N)', 'Off-platform note'], ...rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
    const b = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  const withInfo = (info: Record<string, { status: string; amountPaise: number }>) => ({
    batchTxnIds: new Set(Object.keys(info)),
    knownUtrs: new Set<string>(),
    txnInfo: new Map(Object.entries(info)),
  });

  it('PENDING + PAID + blank flag → row error with the exact guidance text', () => {
    const res = parsePayoutUtrUpload(buf([['t1', 'UTR12345678', 'PAID', '', '']]), withInfo({ t1: { status: 'PENDING', amountPaise: 100 } }));
    expect(res.canProceed).toBe(false);
    expect(res.rows[0].errors).toEqual([
      "This payment wasn't processed in a batch — process the batch first, or mark it 'Paid outside platform' if it was paid outside Gifsy.",
    ]);
  });

  it('HOLD is treated as unprocessed too', () => {
    const res = parsePayoutUtrUpload(buf([['t1', 'UTR12345678', 'PAID', 'n', '']]), withInfo({ t1: { status: 'HOLD', amountPaise: 100 } }));
    expect(res.rows[0].status).toBe('ERROR');
  });

  it('PENDING + PAID + "Y"/"yes" → OK, flagged, note kept', () => {
    const res = parsePayoutUtrUpload(
      buf([['t1', 'UTR12345678', 'PAID', 'Y', 'cash at depot'], ['t2', 'UTR87654321', 'PAID', 'yes', '']]),
      withInfo({ t1: { status: 'PENDING', amountPaise: 100 }, t2: { status: 'PENDING', amountPaise: 100 } }),
    );
    expect(res.canProceed).toBe(true);
    expect(res.rows.map((r) => [r.status, r.paidOffPlatform, r.offPlatformNote])).toEqual([
      ['OK', true, 'cash at depot'],
      ['OK', true, ''],
    ]);
  });

  it('INITIATED / PROCESSING + PAID + blank → OK (unchanged path)', () => {
    const res = parsePayoutUtrUpload(
      buf([['t1', 'UTR12345678', 'PAID', '', ''], ['t2', 'UTR87654321', 'PAID', '', '']]),
      withInfo({ t1: { status: 'INITIATED', amountPaise: 100 }, t2: { status: 'PROCESSING', amountPaise: 100 } }),
    );
    expect(res.canProceed).toBe(true);
    expect(res.rows.every((r) => r.paidOffPlatform === false)).toBe(true);
  });

  it('"Y" on a FAILED row, or a non Y/N value → row error', () => {
    const res = parsePayoutUtrUpload(
      buf([['t1', '', 'FAILED', 'Y', ''], ['t2', 'UTR87654321', 'PAID', 'maybe', '']]),
      withInfo({ t1: { status: 'INITIATED', amountPaise: 100 }, t2: { status: 'INITIATED', amountPaise: 100 } }),
    );
    expect(res.rows[0].errors).toEqual(['"Paid outside platform (Y/N)" = Y can only be used on a PAID row.']);
    expect(res.rows[1].errors).toEqual(['"Paid outside platform (Y/N)" must be Y or N (got "maybe").']);
  });

  it('"Y" with a zero amount → row error', () => {
    const res = parsePayoutUtrUpload(buf([['t1', 'UTR12345678', 'PAID', 'Y', '']]), withInfo({ t1: { status: 'PENDING', amountPaise: 0 } }));
    expect(res.rows[0].errors).toEqual(['Cannot record an off-platform payment for a transaction with no valid amount.']);
  });

  it('FAILED on a PENDING tx needs no flag (guard is PAID-only)', () => {
    const res = parsePayoutUtrUpload(buf([['t1', '', 'FAILED', '', '']]), withInfo({ t1: { status: 'PENDING', amountPaise: 100 } }));
    expect(res.canProceed).toBe(true);
  });

  it('without txnInfo (pure callers) the guard does not run', () => {
    const res = parsePayoutUtrUpload(buf([['t1', 'UTR12345678', 'PAID', '', '']]), {
      batchTxnIds: new Set(['t1']),
      knownUtrs: new Set<string>(),
    });
    expect(res.canProceed).toBe(true);
  });
});
