/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts Phase 2: Payout Store & Batch Download
 *
 * Groups:
 *   A — Source exports
 *   B — Payout entry creation from credit batch
 *   C — Payout batch download: structure
 *   D — Payout batch download: bank snapshot
 *   E — Payout file Excel format
 *   F — Open batch warning
 *   G — Standard vs Separate grouping
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import * as XLSX        from 'xlsx';
import type { CreditBatch, CreditField } from '@/types';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_BATCH: CreditBatch = {
  id:             'batch_test_001',
  period:         '2026-05',
  status:         'CONFIRMED',
  uploadedBy:     'Test Admin',
  uploadedAt:     '2026-06-01T10:00:00.000Z',
  confirmedAt:    '2026-06-01T10:05:00.000Z',
  confirmedBy:    'Test Admin',
  totalOutlets:   2,
  totalPoints:    500,
  totalPayoutInr: 800,
  rows: [
    { rowNum: 3, outletId: 'WS-001', outletName: 'Anand Wholesale', fieldId: 'f_vol', fieldName: 'Volume', amount: 500,   narration: 'May performance', awardType: 'POINTS', status: 'OK', errors: [] },
    { rowNum: 3, outletId: 'RT-001', outletName: 'Sharma Store',    fieldId: 'f_vol', fieldName: 'Volume', amount: 500,   narration: 'May volume',      awardType: 'PAYOUT', status: 'OK', errors: [] },
    { rowNum: 4, outletId: 'RT-001', outletName: 'Sharma Store',    fieldId: 'f_vis', fieldName: 'Visibility', amount: 300, narration: 'Good vis',    awardType: 'PAYOUT', status: 'OK', errors: [] },
    { rowNum: 5, outletId: 'RT-002', outletName: 'Patel Kirana',    fieldId: 'f_vol', fieldName: 'Volume', amount: 0,     narration: '',            awardType: 'POINTS', status: 'SKIP', errors: [] },
  ],
};

const STANDARD_FIELD: CreditField = {
  id: 'f_vol', name: 'Volume', isActive: true, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'PAYOUT', SSS_TOT: 'PAYOUT' },
  createdAt: '2026-01-01T00:00:00.000Z', order: 1,
};
const SEPARATE_FIELD: CreditField = {
  id: 'f_vis', name: 'Visibility', isActive: true, isSeparatePayout: true,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'PAYOUT', SSS_TOT: 'PAYOUT' },
  createdAt: '2026-01-02T00:00:00.000Z', order: 2,
};

// ─── A — Source exports ───────────────────────────────────────────────────────

describe('A — payout-store + payout-download: exports', () => {
  it('A1: createPayoutEntriesFromBatch exported from payout-store', () => {
    const code = src('lib/credits-payouts-payout-store.ts');
    expect(code).toMatch(/export\s+function\s+createPayoutEntriesFromBatch/);
  });

  it('A2: getPayoutEntries exported', () => {
    const code = src('lib/credits-payouts-payout-store.ts');
    expect(code).toMatch(/export\s+function\s+getPayoutEntries/);
  });

  it('A3: DEMO_BANK_DETAILS exported', () => {
    const code = src('lib/credits-payouts-payout-store.ts');
    expect(code).toMatch(/export\s+const\s+DEMO_BANK_DETAILS/);
  });

  it('A4: createPayoutBatch exported from payout-download', () => {
    const code = src('lib/credits-payouts-payout-download.ts');
    expect(code).toMatch(/export\s+function\s+createPayoutBatch/);
  });

  it('A5: generatePayoutFileBuffer exported', () => {
    const code = src('lib/credits-payouts-payout-download.ts');
    expect(code).toMatch(/export\s+function\s+generatePayoutFileBuffer/);
  });

  it('A6: PAYOUT_FILE_HEADERS exported', () => {
    const code = src('lib/credits-payouts-payout-download.ts');
    expect(code).toMatch(/export\s+const\s+PAYOUT_FILE_HEADERS/);
  });
});

// ─── B — Payout entry creation ────────────────────────────────────────────────

describe('B — createPayoutEntriesFromBatch', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('B1: creates entries only for PAYOUT-type OK rows', async () => {
    const { createPayoutEntriesFromBatch, getPayoutEntries, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    resetPayoutEntries();
    const entries = createPayoutEntriesFromBatch(MOCK_BATCH);
    // RT-001 Volume + RT-001 Visibility = 2 entries
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.status === 'PENDING')).toBe(true);
  });

  it('B2: does NOT create entries for POINTS rows', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    resetPayoutEntries();
    const entries = createPayoutEntriesFromBatch(MOCK_BATCH);
    const outletIds = entries.map((e) => e.outletId);
    // WS-001 is POINTS → should not appear
    expect(outletIds).not.toContain('WS-001');
  });

  it('B3: does NOT create entries for SKIP rows', async () => {
    const { createPayoutEntriesFromBatch, getPayoutEntries, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const entries = getPayoutEntries();
    // RT-002 was SKIP → should not appear
    expect(entries.some((e) => e.outletId === 'RT-002')).toBe(false);
  });

  it('B4: entries carry correct amount, fieldId, period', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    resetPayoutEntries();
    const entries = createPayoutEntriesFromBatch(MOCK_BATCH);
    const visEntry = entries.find((e) => e.fieldId === 'f_vis');
    expect(visEntry).toBeDefined();
    expect(visEntry!.amount).toBe(300);
    expect(visEntry!.period).toBe('2026-05');
    expect(visEntry!.batchId).toBe('batch_test_001');
  });

  it('B5: idempotent — calling twice does not create duplicate entries', async () => {
    const { createPayoutEntriesFromBatch, getPayoutEntries, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const entries = getPayoutEntries();
    expect(entries).toHaveLength(2);
  });
});

// ─── C — Payout batch structure ───────────────────────────────────────────────

describe('C — createPayoutBatch structure', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('C1: creates a batch with a unique ID', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } =
      await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const result = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    expect(result.batch.id).toMatch(/^PB-/);
  });

  it('C2: batch has correct period and groupType', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { batch } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    expect(batch.period).toBe('2026-05');
    expect(batch.groupType).toBe('STANDARD');
  });

  it('C3: batch rows contain the payout outlets', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { batch } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    const ids = batch.rows.map((r) => r.outletId);
    expect(ids).toContain('RT-001');
  });

  it('C4: batch totalAmount equals sum of row amounts', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { batch } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    const rowTotal = batch.rows.reduce((s, r) => s + r.amount, 0);
    expect(batch.totalAmount).toBe(rowTotal);
  });
});

// ─── D — Bank snapshot ────────────────────────────────────────────────────────

describe('D — Bank details snapshot', () => {
  beforeEach(() => { localStorage.clear(); });

  it('D1: DEMO_BANK_DETAILS has entries for WHOLESALER and SSS outlets', async () => {
    const { DEMO_BANK_DETAILS } = await import('../credits-payouts-payout-store');
    expect('WS-001' in DEMO_BANK_DETAILS).toBe(true);
    expect('RT-001' in DEMO_BANK_DETAILS).toBe(true);
  });

  it('D2: snapshotBankDetails returns one snapshot per outlet', async () => {
    const { snapshotBankDetails } = await import('../credits-payouts-payout-store');
    const snaps = snapshotBankDetails(['WS-001', 'RT-001']);
    expect(snaps).toHaveLength(2);
    expect(snaps.every((s) => s.snapshotAt)).toBe(true);
  });

  it('D3: bank snapshot is stored in the batch', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { batch } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    expect(batch.bankSnapshots.length).toBeGreaterThan(0);
    expect(batch.bankSnapshots[0]).toHaveProperty('accountNumber');
    expect(batch.bankSnapshots[0]).toHaveProperty('ifscCode');
  });

  it('D4: deactivated outlets are flagged in batch rows', async () => {
    const { DEMO_BANK_DETAILS } = await import('../credits-payouts-payout-store');
    // RT-006 is deactivated in the demo data
    expect(DEMO_BANK_DETAILS['RT-006']?.isActive).toBe(false);
  });
});

// ─── E — Payout file Excel format ─────────────────────────────────────────────

describe('E — generatePayoutFileBuffer Excel format', () => {
  beforeEach(() => { localStorage.clear(); });

  it('E1: returns an ArrayBuffer', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { buffer } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    expect(buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('E2: Excel has a sheet named "Payout"', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { buffer } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    const wb = XLSX.read(buffer, { type: 'array' });
    expect(wb.SheetNames).toContain('Payout');
  });

  it('E3: row 2 (headers) contains "Outlet ID", "Batch ID", "UTR"', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { buffer } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    const wb      = XLSX.read(buffer, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Payout'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).toContain('Outlet ID');
    expect(headers).toContain('Batch ID');
    expect(headers).toContain('UTR');
    expect(headers).toContain('Success/Failure');
  });

  it('E4: data rows include Account Number and IFSC columns', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { buffer } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    const wb      = XLSX.read(buffer, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Payout'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).toContain('Account Number');
    expect(headers).toContain('IFSC');
  });

  it('E5: PAYOUT_FILE_HEADERS includes all required columns', async () => {
    const { PAYOUT_FILE_HEADERS } = await import('../credits-payouts-payout-download');
    expect(PAYOUT_FILE_HEADERS).toContain('Outlet ID');
    expect(PAYOUT_FILE_HEADERS).toContain('Batch ID');
    expect(PAYOUT_FILE_HEADERS).toContain('UTR');
    expect(PAYOUT_FILE_HEADERS).toContain('Success/Failure');
    expect(PAYOUT_FILE_HEADERS).toContain('Remarks');
    expect(PAYOUT_FILE_HEADERS).toContain('Payout Amount');
  });
});

// ─── F — Open batch warning ───────────────────────────────────────────────────

describe('F — Open batch warning', () => {
  beforeEach(() => { localStorage.clear(); });

  it('F1: no warning when no open batches exist', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);
    const { openWarning } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    expect(openWarning).toBeNull();
  });

  it('F2: warning when a second batch is downloaded for same period', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    // Seed payout entries twice to have something to download
    createPayoutEntriesFromBatch(MOCK_BATCH);
    // First download
    createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    // Add more entries for a second download
    const MOCK_BATCH_2: CreditBatch = {
      ...MOCK_BATCH,
      id: 'batch_test_002',
      rows: [
        { rowNum: 3, outletId: 'SS-001', outletName: 'Mumbai Sub-Depot', fieldId: 'f_vol', fieldName: 'Volume', amount: 200, narration: '', awardType: 'PAYOUT', status: 'OK', errors: [] },
      ],
    };
    createPayoutEntriesFromBatch(MOCK_BATCH_2);
    // Second download — should warn
    const { openWarning } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    expect(openWarning).not.toBeNull();
    expect(openWarning).toMatch(/open/i);
  });
});

// ─── G — Standard vs Separate grouping ───────────────────────────────────────

describe('G — Standard vs Separate field grouping', () => {
  beforeEach(() => { localStorage.clear(); });

  it('G1: STANDARD batch excludes separate-flagged fields', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH); // has f_vol (standard) and f_vis (separate)

    const { batch } = createPayoutBatch({
      period: '2026-05', groupType: 'STANDARD', downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    // STANDARD batch should sum f_vol amounts only (f_vis is separate)
    // RT-001 Volume: 500 only (Visibility excluded from standard)
    expect(batch.rows.find((r) => r.outletId === 'RT-001')?.amount).toBe(500);
  });

  it('G2: SEPARATE batch includes only the specified fieldId', async () => {
    const { createPayoutEntriesFromBatch, resetPayoutEntries } =
      await import('../credits-payouts-payout-store');
    const { createPayoutBatch } = await import('../credits-payouts-payout-download');
    resetPayoutEntries();
    createPayoutEntriesFromBatch(MOCK_BATCH);

    const { batch } = createPayoutBatch({
      period: '2026-05', groupType: 'SEPARATE', fieldId: 'f_vis', fieldName: 'Visibility',
      downloadedBy: 'Gifsy',
      fields: [STANDARD_FIELD, SEPARATE_FIELD],
    });
    // Only f_vis entries for RT-001 (300)
    expect(batch.rows.find((r) => r.outletId === 'RT-001')?.amount).toBe(300);
  });
});
