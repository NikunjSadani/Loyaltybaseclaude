/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts: UTR Upload (pure / injectable API)
 *
 * Groups:
 *   A — Source exports
 *   B — isValidUtr
 *   C — parseUtrUpload: header validation
 *   D — parseUtrUpload: row-level validation
 *   E — parseUtrUpload: idempotency (already-PAID rows)
 *   F — parseUtrUpload: duplicate UTR detection
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import * as XLSX        from 'xlsx';
import type { UtrBatchRow } from '../credits-payouts-utr';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const DOWNLOAD_CODE = 'PD-2026-05-001';

const BATCH_ROWS: UtrBatchRow[] = [
  { outletId: 'RT-001', utrStatus: 'PENDING' },
  { outletId: 'SS-001', utrStatus: 'PENDING' },
];

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

  it('A3: does NOT import from credits-payouts-payout-store', () => {
    const code = src('lib/credits-payouts-utr.ts');
    expect(code).not.toMatch(/credits-payouts-payout-store/);
  });

  it('A4: UtrBatchRow interface exported', () => {
    const code = src('lib/credits-payouts-utr.ts');
    expect(code).toMatch(/export\s+interface\s+UtrBatchRow/);
  });
});

// ─── B — isValidUtr ───────────────────────────────────────────────────────────

describe('B — isValidUtr', () => {
  it('B1: accepts 8-char alphanumeric UTR', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('HDFC12345')).toBe(true);
  });

  it('B2: accepts 22-char UTR, rejects 23-char', async () => {
    const { isValidUtr } = await import('../credits-payouts-utr');
    expect(isValidUtr('NEFT2026060112345678901')).toBe(false);
    expect(isValidUtr('NEFT202606011234567890')).toBe(true);
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
  it('C1: returns headerError when batchRows is empty', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, []);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    [],
      knownUtrs:    new Set(),
    });
    expect(result.headerError).not.toBeNull();
    expect(result.canProceed).toBe(false);
  });

  it('C2: returns headerError when Outlet ID column missing', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const headersNoOutlet = DEFAULT_HEADERS.filter((h) => h !== 'Outlet ID');
    const buf = buildUtrXlsx(headersNoOutlet, []);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.headerError).not.toBeNull();
    expect(result.headerError).toMatch(/Outlet ID/i);
  });

  it('C3: returns headerError when UTR column missing', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const headersNoUtr = DEFAULT_HEADERS.filter((h) => h !== 'UTR');
    const buf = buildUtrXlsx(headersNoUtr, []);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.headerError).not.toBeNull();
  });

  it('C4: valid headers → no headerError', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', 'Sharma Store', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.headerError).toBeNull();
  });
});

// ─── D — parseUtrUpload: row-level validation ──────────────────────────────────

describe('D — parseUtrUpload row validation', () => {
  it('D1: valid row with SUCCESS → status OK', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].success).toBe(true);
    expect(result.canProceed).toBe(true);
  });

  it('D2: unknown outlet ID → ERROR', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'UNKNOWN-999', '', '', '', '', '', '', '', '', 100, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.join(' ')).toMatch(/not found/i);
  });

  it('D3: batch ID mismatch → ERROR', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      ['PD-WRONG-BATCH', 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.join(' ')).toMatch(/batch id/i);
  });

  it('D4: success=true but UTR empty → ERROR', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, '', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.join(' ')).toMatch(/utr is required/i);
  });

  it('D5: invalid UTR format → ERROR', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, 'SHORT', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.rows[0].status).toBe('ERROR');
  });

  it('D6: failure row (SUCCESS=0) without UTR → OK (UTR not required for failures)', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, '', '0', 'Transfer failed'],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].success).toBe(false);
  });

  it('D7: "1", "Y", "YES", "TRUE", "Success" all accepted as success values', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    for (const val of ['1', 'Y', 'YES', 'TRUE', 'Success']) {
      const buf = buildUtrXlsx(DEFAULT_HEADERS, [
        [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC00112233', val, ''],
      ]);
      const result = parseUtrUpload(buf, {
        downloadCode: DOWNLOAD_CODE,
        batchRows:    BATCH_ROWS,
        knownUtrs:    new Set(),
      });
      const row = result.rows.find((r) => r.outletId === 'RT-001')!;
      expect(row.success).toBe(true);
    }
  });
});

// ─── E — Idempotency (already-PAID rows) ──────────────────────────────────────

describe('E — parseUtrUpload: idempotency', () => {
  it('E1: already-PAID row → SKIP status', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const paidRows: UtrBatchRow[] = [
      { outletId: 'RT-001', utrStatus: 'PAID', utr: 'HDFC99999999' },
      { outletId: 'SS-001', utrStatus: 'PENDING' },
    ];
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC99999999', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    paidRows,
      knownUtrs:    new Set(['HDFC99999999']),
    });
    expect(result.rows[0].status).toBe('SKIP');
  });

  it('E2: summary skipped count includes already-PAID rows', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const paidRows: UtrBatchRow[] = [
      { outletId: 'RT-001', utrStatus: 'PAID', utr: 'HDFC99999999' },
      { outletId: 'SS-001', utrStatus: 'PENDING' },
    ];
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, 'HDFC99999999', 'SUCCESS', ''],
      [DOWNLOAD_CODE, 'SS-001', '', '', '', '', '', '', '', '', 300, 'SBIN00112233', 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    paidRows,
      knownUtrs:    new Set(['HDFC99999999']),
    });
    expect(result.summary.skipped).toBe(1);
  });
});

// ─── F — Duplicate UTR detection ─────────────────────────────────────────────

describe('F — parseUtrUpload: duplicate UTR', () => {
  it('F1: within-file duplicate UTR → ERROR on second row', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const sameUtr = 'HDFC00112233';
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, sameUtr, 'SUCCESS', ''],
      [DOWNLOAD_CODE, 'SS-001', '', '', '', '', '', '', '', '', 300, sameUtr, 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set(),
    });
    const ssRow = result.rows.find((r) => r.outletId === 'SS-001')!;
    expect(ssRow.status).toBe('ERROR');
    expect(ssRow.errors.join(' ')).toMatch(/more than once|duplicate/i);
  });

  it('F2: UTR already in knownUtrs (from a different download) → ERROR', async () => {
    const { parseUtrUpload } = await import('../credits-payouts-utr');
    const usedUtr = 'USEDUTRNEFTHD001';
    const buf = buildUtrXlsx(DEFAULT_HEADERS, [
      [DOWNLOAD_CODE, 'RT-001', '', '', '', '', '', '', '', '', 500, usedUtr, 'SUCCESS', ''],
    ]);
    const result = parseUtrUpload(buf, {
      downloadCode: DOWNLOAD_CODE,
      batchRows:    BATCH_ROWS,
      knownUtrs:    new Set([usedUtr.toUpperCase()]),
    });
    const row = result.rows.find((r) => r.outletId === 'RT-001')!;
    expect(row.status).toBe('ERROR');
    expect(row.errors.join(' ')).toMatch(/already been used|previous batch/i);
  });
});
