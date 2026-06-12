/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts Phase 2: UTR Upload
 *
 * Groups:
 *   A — Source exports
 *   B — isValidUtr
 *   C — parseUtrUpload: header validation
 *   D — parseUtrUpload: row-level validation
 *   E — parseUtrUpload: idempotency (already-PAID rows)
 *   F — parseUtrUpload: duplicate UTR detection
 *   G — applyUtrResult: batch status transitions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import * as XLSX        from 'xlsx';
import type { CreditBatch, PayoutBatch, PayoutBatchRow } from '@/types';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an xlsx ArrayBuffer for UTR upload tests.
 * Row 0 = title, Row 1 = headers, Row 2+ = data.
 */
function buildUtrXlsx(headers: string[], dataRows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([['Payout File Title'], headers, ...dataRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payout');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

const DEFAULT_HEADERS = [
  'Batch ID', 'Outlet ID', 'Outlet Name', 'Phone',
  'Bank Name', 'Account Number', 'IFSC', 'UPI ID',
  'KYC Status', 'Deactivated', 'Payout Amount',
  'UTR', 'Success/Failure', 'Remarks',
];

// ─── Fixture payout batch ─────────────────────────────────────────────────────

const MOCK_PAYOUT_BATCH_ID = 'PB-2026-05-001';
const MOCK_PAYOUT_BATCH: PayoutBatch = {
  id:            MOCK_PAYOUT_BATCH_ID,
  creditBatchId: 'batch_test_001',
  period:        '2026-05',
  groupType:     'STANDARD',
  status:        'OPEN',
  downloadedAt:  '2026-06-01T12:00:00.000Z',
  downloadedBy:  'Gifsy Admin',
  totalAmount:   800,
  bankSnapshots: [
    { outletId: 'RT-001', bankName: 'HDFC', accountNumber: '00111122233', ifscCode: 'HDFC0001234', upiId: 'rt001@hdfc', snapshotAt: '2026-06-01T12:00:00.000Z' },
    { outletId: 'SS-001', bankName: 'SBI',  accountNumber: '55566677788', ifscCode: 'SBIN0099887', upiId: 'ss001@sbi',  snapshotAt: '2026-06-01T12:00:00.000Z' },
  ],
  rows: [
    {
      outletId: 'RT-001', outletName: 'Sharma Store', phone: '9876543210',
      bankName: 'HDFC', accountNumber: '00111122233', ifscCode: 'HDFC0001234',
      upiId: 'rt001@hdfc', kycStatus: 'VERIFIED', amount: 500,
      isDeactivated: false, utrStatus: 'PENDING', entryIds: ['entry_001'],
    } as PayoutBatchRow,
    {
      outletId: 'SS-001', outletName: 'Mumbai Sub-Depot', phone: '9123456780',
      bankName: 'SBI', accountNumber: '55566677788', ifscCode: 'SBIN0099887',
      upiId: 'ss001@sbi', kycStatus: 'VERIFIED', amount: 300,
      isDeactivated: false, utrStatus: 'PENDING', entryIds: ['entry_002'],
    } as PayoutBatchRow,
  ],
};

// ─── A — Source exports ───────────────────────────────────────────────────────

describe('A — UTR: exports', () => {
  it('A1: isValidUtr exported', () => {
    const code = src('lib/credits-payouts-utr.ts');
    expect(code).toMatch(/export\s+function\s+isValidUtr/);
  });

  it('A2: parseUtrUpload exported', () => {
    const code = src('lib/credits-payouts-utr.ts');
    expect(code).toMatch(/export\s+function\s+parseUtrUpload/);
  });

  it('A3: applyUtrResult exported', () => {
    const code = src('lib/credits-payouts-utr.ts');
    expect(code).toMatch(/export\s+function\s+applyUtrResult/);
  });
});

// ─── B — isValidUtr ───────────────────────────────────────────────────────────

describe('B — isValidUtr', () => {
  it('B1: accepts 8-char alphanumeric UTR', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('HDFC12345')).toBe(true);
  });

  it('B2: accepts 22-char UTR', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('NEFT2026060112345678901')).toBe(false); // 23 chars — too long
    expect(isValidUtr('NEFT202606011234567890')).toBe(true);   // 22 chars — ok
  });

  it('B3: rejects 7-char UTR (too short)', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('HDFC123')).toBe(false);
  });

  it('B4: rejects UTR with special characters', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('HDFC-12345')).toBe(false);
    expect(isValidUtr('HDFC 12345')).toBe(false);
  });

  it('B5: accepts lowercase UTR (case-insensitive)', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('hdfc12345')).toBe(true);
  });

  it('B6: trims whitespace before checking', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('  HDFC12345  ')).toBe(true);
  });
});

// ─── C — parseUtrUpload: header validation ────────────────────────────────────

describe('C — parseUtrUpload header validation', () => {
  beforeEach(() => { localStorage.clear(); });

  it('C1: returns headerError when batch not found', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const { resetPayoutBatches } = await import('../credits-payouts-payout-store');
    resetPayoutBatches?.();
    const buf = buildUtrXlsx(DEFAULT_HEADERS, []);
    const result = parseUtrUpload(buf, { batchId: 'NONEXISTENT' });
    expect(result.headerError).not.toBeNull();
    expect(result.canProceed).toBe(false);
  });

  it('C2: returns headerError when Outlet ID column missing', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);
    const headersNoOutlet = DEFAULT_HEADERS.filter((h) => h !== 'Outlet ID');
    const buf = buildUtrXlsx(headersNoOutlet, []);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.headerError).not.toBeNull();
    expect(result.headerError).toMatch(/Outlet ID/i);
  });

  it('C3: returns headerError when UTR column missing', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);
    const headersNoUtr = DEFAULT_HEADERS.filter((h) => h !== 'UTR');
    const buf = buildUtrXlsx(headersNoUtr, []);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.headerError).not.toBeNull();
  });

  it('C4: valid headers → no headerError', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', 'Sharma Store', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.headerError).toBeNull();
  });
});

// ─── D — parseUtrUpload: row-level validation ──────────────────────────────────

describe('D — parseUtrUpload row validation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function setupBatch() {
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);
  }

  it('D1: valid row with SUCCESS → status OK', async () => {
    await setupBatch();
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].success).toBe(true);
    expect(result.canProceed).toBe(true);
  });

  it('D2: unknown outlet ID → ERROR', async () => {
    await setupBatch();
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'UNKNOWN-999', '', '', '', '', '', '', '', '', 100, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.join(' ')).toMatch(/not found/i);
  });

  it('D3: batch ID mismatch → ERROR', async () => {
    await setupBatch();
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      ['PB-WRONG-BATCH', 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.join(' ')).toMatch(/batch id/i);
  });

  it('D4: success=true but UTR empty → ERROR', async () => {
    await setupBatch();
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, '', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.join(' ')).toMatch(/utr is required/i);
  });

  it('D5: invalid UTR format → ERROR', async () => {
    await setupBatch();
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'SHORT', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.rows[0].status).toBe('ERROR');
  });

  it('D6: failure row (SUCCESS=0) without UTR → OK (UTR not required for failures)', async () => {
    await setupBatch();
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, '', '0', 'Transfer failed'],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].success).toBe(false);
  });

  it('D7: "1" and "Y" and "YES" accepted as success values', async () => {
    await setupBatch();
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    for (const val of ['1', 'Y', 'YES', 'TRUE', 'Success']) {
      const buf = buildUtrXlsx(DEFAULT_HEADERS, [
        [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', val, ''],
      ]);
      const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
      const row = result.rows.find((r) => r.outletId === 'RT-001')!;
      expect(row.success).toBe(true);
    }
  });
});

// ─── E — Idempotency (already-PAID rows) ──────────────────────────────────────

describe('E — parseUtrUpload: idempotency', () => {
  beforeEach(() => { localStorage.clear(); });

  it('E1: already-PAID row → SKIP status', async () => {
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();

    // Mark RT-001 as already PAID
    const paidBatch: PayoutBatch = {
      ...MOCK_PAYOUT_BATCH,
      rows: MOCK_PAYOUT_BATCH.rows.map((r) =>
        r.outletId === 'RT-001' ? { ...r, utrStatus: 'PAID', utr: 'HDFC99999999' } : r,
      ),
    };
    savePayoutBatch(paidBatch);

    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC99999999', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.rows[0].status).toBe('SKIP');
  });

  it('E2: summary skipped count includes already-PAID rows', async () => {
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();
    const paidBatch: PayoutBatch = {
      ...MOCK_PAYOUT_BATCH,
      rows: MOCK_PAYOUT_BATCH.rows.map((r) =>
        r.outletId === 'RT-001' ? { ...r, utrStatus: 'PAID', utr: 'HDFC99999999' } : r,
      ),
    };
    savePayoutBatch(paidBatch);

    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC99999999', 'SUCCESS', ''],
      [MOCK_PAYOUT_BATCH_ID, 'SS-001', '', '', '', '', '', '', '', '', 300, 'SBIN00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    expect(result.summary.skipped).toBe(1);
  });
});

// ─── F — Duplicate UTR detection ─────────────────────────────────────────────

describe('F — parseUtrUpload: duplicate UTR', () => {
  beforeEach(() => { localStorage.clear(); });

  it('F1: within-file duplicate UTR → ERROR on second row', async () => {
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);

    const sameUtr = 'HDFC00112233';
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, sameUtr, 'SUCCESS', ''],
      [MOCK_PAYOUT_BATCH_ID, 'SS-001', '', '', '', '', '', '', '', '', 300, sameUtr, 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    const ssRow = result.rows.find((r) => r.outletId === 'SS-001')!;
    expect(ssRow.status).toBe('ERROR');
    expect(ssRow.errors.join(' ')).toMatch(/more than once|duplicate/i);
  });

  it('F2: UTR used in a DIFFERENT batch → ERROR', async () => {
    const { savePayoutBatch, resetPayoutBatches } = await import('../credits-payouts-payout-store');
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();

    // Seed another batch that already has this UTR used
    const usedUtr = 'USEDUTRNEFTHD001';
    const existingBatch: PayoutBatch = {
      ...MOCK_PAYOUT_BATCH,
      id:     'PB-2026-04-001',
      period: '2026-04',
      rows:   [{ ...MOCK_PAYOUT_BATCH.rows[0], utr: usedUtr, utrStatus: 'PAID' }],
    };
    savePayoutBatch(existingBatch);

    // New batch for current period
    const newBatch: PayoutBatch = { ...MOCK_PAYOUT_BATCH };
    savePayoutBatch(newBatch);

    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, usedUtr, 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    const row = result.rows.find((r) => r.outletId === 'RT-001')!;
    expect(row.status).toBe('ERROR');
    expect(row.errors.join(' ')).toMatch(/already been used|previous batch/i);
  });
});

// ─── G — applyUtrResult: batch status transitions ─────────────────────────────

describe('G — applyUtrResult batch status', () => {
  beforeEach(() => { localStorage.clear(); });

  it('G1: all rows PAID → batch status PAID', async () => {
    const { savePayoutBatch, getPayoutBatch, resetPayoutBatches } =
      await import('../credits-payouts-payout-store');
    const { parseUtrUpload, applyUtrResult } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);

    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
      [MOCK_PAYOUT_BATCH_ID, 'SS-001', '', '', '', '', '', '', '', '', 300, 'SBIN00112233', 'SUCCESS', ''],
    ]);
    const parseResult = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    applyUtrResult(parseResult, MOCK_PAYOUT_BATCH_ID);
    const updated = getPayoutBatch(MOCK_PAYOUT_BATCH_ID);
    expect(updated?.status).toBe('PAID');
  });

  it('G2: all rows FAILED → batch status FAILED', async () => {
    const { savePayoutBatch, getPayoutBatch, resetPayoutBatches } =
      await import('../credits-payouts-payout-store');
    const { parseUtrUpload, applyUtrResult } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);

    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, '', '0', 'Failed'],
      [MOCK_PAYOUT_BATCH_ID, 'SS-001', '', '', '', '', '', '', '', '', 300, '', '0', 'Failed'],
    ]);
    const parseResult = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    applyUtrResult(parseResult, MOCK_PAYOUT_BATCH_ID);
    const updated = getPayoutBatch(MOCK_PAYOUT_BATCH_ID);
    expect(updated?.status).toBe('FAILED');
  });

  it('G3: one PAID one PENDING → batch status PARTIALLY_PAID', async () => {
    const { savePayoutBatch, getPayoutBatch, resetPayoutBatches } =
      await import('../credits-payouts-payout-store');
    const { parseUtrUpload, applyUtrResult } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);

    // Only upload one row
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const parseResult = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    applyUtrResult(parseResult, MOCK_PAYOUT_BATCH_ID);
    const updated = getPayoutBatch(MOCK_PAYOUT_BATCH_ID);
    expect(updated?.status).toBe('PARTIALLY_PAID');
  });

  it('G4: applyUtrResult returns correct paid/failed/skipped counts', async () => {
    const { savePayoutBatch, resetPayoutBatches } =
      await import('../credits-payouts-payout-store');
    const { parseUtrUpload, applyUtrResult } = await import('../credits-payouts-utr');
    resetPayoutBatches?.();
    savePayoutBatch(MOCK_PAYOUT_BATCH);

    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [MOCK_PAYOUT_BATCH_ID, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
      [MOCK_PAYOUT_BATCH_ID, 'SS-001', '', '', '', '', '', '', '', '', 300, '', '0', 'Failed'],
    ]);
    const parseResult = parseUtrUpload(buf, { batchId: MOCK_PAYOUT_BATCH_ID });
    const apply = applyUtrResult(parseResult, MOCK_PAYOUT_BATCH_ID);
    expect(apply.paidCount).toBe(1);
    expect(apply.failedCount).toBe(1);
  });
});
