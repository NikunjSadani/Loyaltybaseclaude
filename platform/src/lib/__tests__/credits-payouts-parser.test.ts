/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts: Upload Parser
 *
 * Groups:
 *   A — Source exports
 *   B — Valid upload
 *   C — Outlet validation errors
 *   D — Amount validation
 *   E — Skip conditions
 *   F — Duplicate detection
 *   G — Summary totals
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import * as XLSX        from 'xlsx';
import type { CreditField } from '@/types';
import type { TemplateOutlet } from '@/lib/credits-payouts-template';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIELD_VOL: CreditField = {
  id: 'f_vol', name: 'Volume', isActive: true, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'PAYOUT', SSS_TOT: 'PAYOUT' },
  createdAt: '2026-01-01T00:00:00.000Z', order: 1,
};
const FIELD_VIS: CreditField = {
  id: 'f_vis', name: 'Visibility', isActive: true, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'PAYOUT', SSS_TOT: 'PAYOUT' },
  createdAt: '2026-01-02T00:00:00.000Z', order: 2,
};
const FIELD_NA: CreditField = {
  id: 'f_na', name: 'NA Field', isActive: true, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'NA', SSS: 'NA', SUB_STOCKIST: 'NA', SSS_TOT: 'NA' },
  createdAt: '2026-01-03T00:00:00.000Z', order: 3,
};

const OUTLETS: TemplateOutlet[] = [
  { id: 'WS-001', name: 'Anand Wholesale', type: 'WHOLESALER' },
  { id: 'RT-001', name: 'Sharma Store',    type: 'SSS' },
  { id: 'SS-001', name: 'Mumbai Sub-Depot',type: 'SUB_STOCKIST' },
];

const DEFAULT_OPTS = {
  fields:          [FIELD_VOL, FIELD_VIS],
  outlets:         OUTLETS,
  month:           '2026-05',
  safetyCapPoints: 50000,
  safetyCapInr:    100000,
};

/** Builds a minimal xlsx buffer from a header row + data rows. */
function buildXlsx(headerRow: string[], dataRows: (string | number)[][]): ArrayBuffer {
  const wsData = [
    ['Credits & Payouts Data — May 2026'],   // title row
    headerRow,
    ...dataRows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Credits & Payouts');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

function makeHeaders(fields: CreditField[]): string[] {
  return [
    'Outlet ID', 'Outlet Name',
    ...fields.map((f) => f.name),
    ...fields.map((f) => `${f.name} Narration`),
  ];
}

// ─── A — Source exports ───────────────────────────────────────────────────────

describe('A — credits-payouts-parser.ts: exports', () => {
  const code = src('lib/credits-payouts-parser.ts');

  it('A1: parseCreditUpload is exported', () => {
    expect(code).toMatch(/export\s+function\s+parseCreditUpload/);
  });

  it('A2: ParseCreditUploadOpts interface defined', () => {
    expect(code).toMatch(/ParseCreditUploadOpts/);
  });

  it('A3: imports CreditParseResult from @/types', () => {
    expect(code).toMatch(/CreditParseResult/);
  });

  it('A4: imports CreditUploadRow from @/types', () => {
    expect(code).toMatch(/CreditUploadRow/);
  });
});

// ─── B — Valid upload ─────────────────────────────────────────────────────────

describe('B — Valid upload', () => {
  it('B1: valid rows return status OK', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 500, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.headerError).toBeNull();
    const okRows = result.rows.filter((r) => r.status === 'OK');
    expect(okRows.length).toBeGreaterThan(0);
    expect(okRows[0].outletId).toBe('WS-001');
    expect(okRows[0].amount).toBe(500);
  });

  it('B2: canProceed is true when there are OK rows and no errors', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 1000, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.canProceed).toBe(true);
    expect(result.hasErrors).toBe(false);
  });

  it('B3: OK rows have correct awardType based on outlet type', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 500, ''],   // WHOLESALER → POINTS
        ['RT-001', 'Sharma Store',    300, ''],   // SSS → PAYOUT
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const wsRow = result.rows.find((r) => r.outletId === 'WS-001' && r.status === 'OK');
    const rtRow = result.rows.find((r) => r.outletId === 'RT-001' && r.status === 'OK');
    expect(wsRow?.awardType).toBe('POINTS');
    expect(rtRow?.awardType).toBe('PAYOUT');
  });

  it('B4: narration value is captured from narration column', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 500, 'Great performance']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const okRow = result.rows.find((r) => r.status === 'OK');
    expect(okRow?.narration).toBe('Great performance');
  });

  it('B5: 1 decimal place is accepted (e.g. 100.5)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 100.5, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const okRow = result.rows.find((r) => r.status === 'OK');
    expect(okRow?.amount).toBe(100.5);
  });
});

// ─── C — Outlet validation errors ────────────────────────────────────────────

describe('C — Outlet validation errors', () => {
  it('C1: unknown outlet ID → ERROR status', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['UNKNOWN-999', 'Unknown Outlet', 500, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const errRow = result.rows.find((r) => r.outletId === 'UNKNOWN-999' && r.status === 'ERROR');
    expect(errRow).toBeDefined();
    expect(errRow!.errors.length).toBeGreaterThan(0);
  });

  it('C2: missing Outlet ID column → headerError', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    // Omit 'Outlet ID' from headers
    const buf = buildXlsx(
      ['Wrong Header', 'Outlet Name', 'Volume', 'Volume Narration'],
      [['WS-001', 'Anand Wholesale', 500, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.headerError).not.toBeNull();
    expect(result.canProceed).toBe(false);
  });

  it('C3: error message mentions the outlet ID', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['BAD-ID', 'Unknown', 500, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const errRow = result.rows.find((r) => r.outletId === 'BAD-ID');
    expect(errRow?.errors.join(' ')).toMatch(/BAD-ID/);
  });
});

// ─── D — Amount validation ────────────────────────────────────────────────────

describe('D — Amount validation', () => {
  it('D1: negative amount → ERROR', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', -100, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const errRow = result.rows.find((r) => r.outletId === 'WS-001' && r.status === 'ERROR');
    expect(errRow).toBeDefined();
    expect(errRow!.errors.join(' ')).toMatch(/negative/i);
  });

  it('D2: more than 1 decimal place → ERROR (e.g. 100.55)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 100.55, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const errRow = result.rows.find((r) => r.outletId === 'WS-001' && r.status === 'ERROR');
    expect(errRow).toBeDefined();
    expect(errRow!.errors.join(' ')).toMatch(/decimal/i);
  });

  it('D3: amount exceeding points safety cap → ERROR', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 99999999, '']],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, safetyCapPoints: 50000 });
    const errRow = result.rows.find((r) => r.outletId === 'WS-001' && r.status === 'ERROR');
    expect(errRow).toBeDefined();
    expect(errRow!.errors.join(' ')).toMatch(/cap/i);
  });

  it('D4: amount exceeding INR safety cap → ERROR for payout outlet', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['RT-001', 'Sharma Store', 9999999, '']],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, safetyCapInr: 100000 });
    const errRow = result.rows.find((r) => r.outletId === 'RT-001' && r.status === 'ERROR');
    expect(errRow).toBeDefined();
  });

  it('D5: non-numeric value → ERROR', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 'ABC', '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const errRow = result.rows.find((r) => r.outletId === 'WS-001' && r.status === 'ERROR');
    expect(errRow).toBeDefined();
  });
});

// ─── E — Skip conditions ──────────────────────────────────────────────────────

describe('E — Skip conditions (zero/blank/NA → SKIP, not error)', () => {
  it('E1: blank value → SKIP (not ERROR)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', '', '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const skipRow = result.rows.find((r) => r.outletId === 'WS-001' && r.fieldId === 'f_vol');
    expect(skipRow?.status).toBe('SKIP');
    expect(result.hasErrors).toBe(false);
  });

  it('E2: zero value → SKIP', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 0, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const skipRow = result.rows.find((r) => r.outletId === 'WS-001' && r.fieldId === 'f_vol');
    expect(skipRow?.status).toBe('SKIP');
    expect(result.hasErrors).toBe(false);
  });

  it('E3: NA field award type → SKIP', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_NA]),
      [['WS-001', 'Anand Wholesale', 500, '']],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, fields: [FIELD_NA] });
    const skipRow = result.rows.find((r) => r.outletId === 'WS-001');
    expect(skipRow?.status).toBe('SKIP');
  });

  it('E4: SKIP rows do not contribute to totals', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 0, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.summary.totalPoints).toBe(0);
    expect(result.summary.totalPayoutInr).toBe(0);
  });

  it('E5: canProceed is false when all rows are skipped', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 0, ''],
        ['RT-001', 'Sharma Store', '', ''],
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.canProceed).toBe(false);
    expect(result.hasErrors).toBe(false);
  });
});

// ─── F — Duplicate detection ──────────────────────────────────────────────────

describe('F — Duplicate detection', () => {
  it('F1: duplicate outlet+field in same upload → second row ERROR', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 500, ''],
        ['WS-001', 'Anand Wholesale', 600, ''],   // duplicate
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const allWs001Vol = result.rows.filter(
      (r) => r.outletId === 'WS-001' && r.fieldId === 'f_vol',
    );
    const okCount  = allWs001Vol.filter((r) => r.status === 'OK').length;
    const errCount = allWs001Vol.filter((r) => r.status === 'ERROR').length;
    expect(okCount).toBe(1);
    expect(errCount).toBe(1);
  });

  it('F1a: duplicate error message mentions "duplicate"', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 500, ''],
        ['WS-001', 'Anand Wholesale', 600, ''],
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const dupErr = result.rows.find(
      (r) => r.outletId === 'WS-001' && r.status === 'ERROR',
    );
    expect(dupErr?.errors.join(' ')).toMatch(/duplicate/i);
  });

  it('F2: same outlet, different fields → not a duplicate', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [['WS-001', 'Anand Wholesale', 500, '', 300, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const errRows = result.rows.filter((r) => r.outletId === 'WS-001' && r.status === 'ERROR');
    expect(errRows).toHaveLength(0);
  });
});

// ─── G — Summary totals ───────────────────────────────────────────────────────

describe('G — Summary totals', () => {
  it('G1: summary.totalPoints sums OK POINTS rows', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 500, ''],   // WHOLESALER → POINTS
        ['RT-001', 'Sharma Store',    300, ''],   // SSS → PAYOUT
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.summary.totalPoints).toBe(500);
  });

  it('G2: summary.totalPayoutInr sums OK PAYOUT rows', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 500, ''],
        ['RT-001', 'Sharma Store',    300, ''],
        ['SS-001', 'Mumbai Sub-Depot',200, ''],
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.summary.totalPayoutInr).toBe(500);  // RT-001 + SS-001
  });

  it('G3: summary counts match row statuses', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 500, ''],    // OK
        ['RT-001', 'Sharma Store',    0,   ''],    // SKIP
        ['BAD-ID', 'Unknown',         200, ''],    // ERROR
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.summary.ok).toBe(1);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.errors).toBe(1);
  });

  it('G4: empty file has zero totals', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(makeHeaders([FIELD_VOL]), []);
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.summary.totalPoints).toBe(0);
    expect(result.summary.totalPayoutInr).toBe(0);
  });
});
