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

import { describe, it, expect, vi } from 'vitest';

// Parses real xlsx workbooks; the first test also pays the cold import. Under full-suite load (next to the
// 6,517-outlet credits-upload test) B1 took 5.08 s against the 5 s default (pre-push 2026-11-15). Generous
// per-file timeout; assertions unchanged.
vi.setConfig({ testTimeout: 30_000 });
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

  it('B5: a decimal amount is accepted and rounded half-up to whole points (100.5 → 101)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 100.5, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const okRow = result.rows.find((r) => r.status === 'OK');
    expect(okRow?.amount).toBe(101);
    expect(okRow?.originalAmount).toBe(100.5);
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

  it('D2: any number of decimals is accepted (100.55 → 101) — no "decimal" error any more', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 100.55, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const row = result.rows.find((r) => r.outletId === 'WS-001');
    expect(row?.status).toBe('OK');
    expect(row?.amount).toBe(101);
    expect(row?.errors.join(' ')).not.toMatch(/decimal/i);
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

  it('E3a: NA field SKIP row carries skipReason naming the field and outlet type', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_NA]),
      [['WS-001', 'Anand Wholesale', 500, '']],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, fields: [FIELD_NA] });
    const skipRow = result.rows.find((r) => r.outletId === 'WS-001');
    expect(skipRow?.status).toBe('SKIP');
    expect(skipRow?.skipReason).toMatch(/NA Field/);          // field name
    expect(skipRow?.skipReason).toMatch(/WHOLESALER/);        // outlet type
    expect(skipRow?.skipReason).toMatch(/Not Applicable/i);
  });

  it('E2a: blank/zero SKIP row carries the blank/zero skipReason', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 0, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const skipRow = result.rows.find((r) => r.outletId === 'WS-001' && r.fieldId === 'f_vol');
    expect(skipRow?.status).toBe('SKIP');
    expect(skipRow?.skipReason).toBe('Value is blank or zero — nothing to credit for this row.');
  });

  it('E4: SKIP rows do not contribute to totals', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 0, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.summary.totalPoints).toBe(0);
    expect(result.summary.totalPayoutPaise).toBe(0);
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

// ─── E6/E7 — Regression: award resolves on outlet.type (code), message shows label ──
// Reproduces the Bajaj bug: a tenant with a per-type display label (code ≠ label). The award
// map is keyed by CODE, so the parser must match on outlet.type (= code), NOT the display label,
// and should surface the friendly label (typeLabel) in the NA skip message.
describe('E6/E7 — typeLabel ≠ code (Bajaj regression)', () => {
  const FIELD_ADHOC: CreditField = {
    id: 'f_adhoc', name: 'Adhoc', isActive: true, isSeparatePayout: false,
    outletTypeAwards: { BSC: 'POINTS' },          // keyed by OutletType.code
    createdAt: '2026-01-04T00:00:00.000Z', order: 4,
  };
  // Bajaj-style outlet: the code is 'BSC', the per-tenant display label is different.
  const OUTLET_LABELLED: TemplateOutlet = {
    id: 'OUT-BSC-1', name: 'Verma Traders', type: 'BSC', typeLabel: 'Bajaj Super Core',
  };

  it('E6: award matches on the code even when typeLabel differs → OK/POINTS (not NA)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_ADHOC]),
      [['OUT-BSC-1', 'Verma Traders', 500, '']],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, fields: [FIELD_ADHOC], outlets: [OUTLET_LABELLED] });
    const row = result.rows.find((r) => r.outletId === 'OUT-BSC-1');
    expect(row?.status).toBe('OK');
    expect(row?.awardType).toBe('POINTS');
  });

  it('E7: a genuinely-NA type → SKIP whose message shows the friendly typeLabel, not the raw code', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const FIELD_ADHOC_NA: CreditField = { ...FIELD_ADHOC, id: 'f_adhoc_na', outletTypeAwards: {} };
    const buf = buildXlsx(
      makeHeaders([FIELD_ADHOC_NA]),
      [['OUT-BSC-1', 'Verma Traders', 500, '']],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, fields: [FIELD_ADHOC_NA], outlets: [OUTLET_LABELLED] });
    const row = result.rows.find((r) => r.outletId === 'OUT-BSC-1');
    expect(row?.status).toBe('SKIP');
    expect(row?.skipReason).toMatch(/Bajaj Super Core/);   // the typeLabel, not the code
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

  it('G2: summary.totalPayoutPaise sums OK PAYOUT rows (in integer paise)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [
        ['WS-001', 'Anand Wholesale', 500, ''],   // WHOLESALER → POINTS, not counted in payout
        ['RT-001', 'Sharma Store',    300, ''],   // SSS → PAYOUT: ₹300 = 30000 paise
        ['SS-001', 'Mumbai Sub-Depot',200, ''],   // SUB_STOCKIST → PAYOUT: ₹200 = 20000 paise
      ],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    // RT-001 (30000) + SS-001 (20000) = 50000 paise
    expect(result.summary.totalPayoutPaise).toBe(50000);
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
    expect(result.summary.totalPayoutPaise).toBe(0);
  });
});

// ─── H — Whole-unit rounding (owner rule 2026-11-12) ─────────────────────────

describe('H — Whole-unit rounding (half-up)', () => {
  it('H1: POINTS 199.5 → 200 and 199.4 → 199; totals use rounded values', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [['WS-001', 'Anand Wholesale', 199.5, 199.4, '', '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const vol = result.rows.find((r) => r.fieldId === 'f_vol')!;
    const vis = result.rows.find((r) => r.fieldId === 'f_vis')!;
    expect(vol.status).toBe('OK');
    expect(vol.amount).toBe(200);
    expect(vol.originalAmount).toBe(199.5);
    expect(vis.amount).toBe(199);
    expect(vis.originalAmount).toBe(199.4);
    expect(result.summary.totalPoints).toBe(399);
    expect(result.summary.rounded).toBe(2);
  });

  it('H2: PAYOUT ₹199.5 → ₹200 = 20000 paise (always whole rupees); ₹199.4 → 19900', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [['RT-001', 'Sharma Store', 199.5, 199.4, '', '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const vol = result.rows.find((r) => r.fieldId === 'f_vol')!;
    const vis = result.rows.find((r) => r.fieldId === 'f_vis')!;
    expect(vol.awardType).toBe('PAYOUT');
    expect(vol.amount).toBe(20000);
    expect(vol.originalAmount).toBe(199.5);
    expect(vis.amount).toBe(19900);
    expect(result.summary.totalPayoutPaise).toBe(39900);
    expect(result.rows.every((r) => r.awardType !== 'PAYOUT' || r.amount % 100 === 0)).toBe(true);
  });

  it('H3: the safety cap applies to the ROUNDED value', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [['WS-001', 'Anand Wholesale', 1000.4, 1000.5, '', '']],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, safetyCapPoints: 1000 });
    const under = result.rows.find((r) => r.fieldId === 'f_vol')!;   // 1000.4 → 1000 = at cap → OK
    const over  = result.rows.find((r) => r.fieldId === 'f_vis')!;   // 1000.5 → 1001 > cap → ERROR
    expect(under.status).toBe('OK');
    expect(under.amount).toBe(1000);
    expect(over.status).toBe('ERROR');
    expect(over.errors.join(' ')).toMatch(/rounds to 1001.*safety cap of 1000/);
  });

  it('H4: a positive amount that rounds to 0 is SKIPPED (nothing to credit), not an error', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 0.4, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.rows[0].status).toBe('SKIP');
    expect(result.rows[0].skipReason).toMatch(/rounds to 0/);
    expect(result.summary.errors).toBe(0);
    expect(result.canProceed).toBe(false);
  });

  it('H5: negatives and non-numbers are still rejected', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [['WS-001', 'Anand Wholesale', -0.4, 'abc', '', '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.rows.map((r) => r.status)).toEqual(['ERROR', 'ERROR']);
  });

  it('H6: whole-number (Deoleo-style) uploads are byte-identical — no originalAmount key, rounded = 0', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL]),
      [['WS-001', 'Anand Wholesale', 500, 'May'], ['RT-001', 'Sharma Store', 250, '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    expect(result.summary.rounded).toBe(0);
    expect(result.rows.map((r) => JSON.stringify(r))).toEqual([
      JSON.stringify({ rowNum: 3, outletId: 'WS-001', outletName: 'Anand Wholesale', fieldId: 'f_vol', fieldName: 'Volume',
        amount: 500, narration: 'May', awardType: 'POINTS', status: 'OK', errors: [] }),
      JSON.stringify({ rowNum: 4, outletId: 'RT-001', outletName: 'Sharma Store', fieldId: 'f_vol', fieldName: 'Volume',
        amount: 25000, narration: '', awardType: 'PAYOUT', status: 'OK', errors: [] }),
    ]);
    expect(result.summary.totalPoints).toBe(500);
    expect(result.summary.totalPayoutPaise).toBe(25000);
  });

  it('H7: the old "Maximum 1 decimal allowed" rule is gone from the parser', () => {
    const code = src('lib/credits-payouts-parser.ts');
    expect(code).not.toMatch(/Maximum 1 decimal/);
    expect(code).not.toMatch(/moreThanOneDecimal/);
  });
});

// ─── I — Float noise trimmed before half-up rounding (audit of 0f5e9395) ─────

describe('I — Excel float noise before half-up rounding', () => {
  // Raw doubles as Excel formula cells deliver them (e.g. =116*12.5/100 → 14.499999999999998).
  const NOISY: Array<[number, number, number]> = [
    // [raw cell value, clean typed value, rounded whole]
    [14.499999999999998, 14.5, 15],      // =116*12.5/100
    [180 * 0.175, 31.5, 32],              // 31.499999999999996
    [61.49999999999999, 61.5, 62],        // =410*0.15
    [660 * 0.175, 115.5, 116],            // 115.49999999999999
    [0.145 * 100, 14.5, 15],              // 14.499999999999998 (2.675-style decimal)
    [1.005 * 1000, 1005, 1005],           // 1004.9999999999999 — noise only, nothing to round
  ];

  it('I1: roundHalfUpWhole / trimFloatNoise on noisy doubles', async () => {
    const { roundHalfUpWhole, trimFloatNoise } = await import('../credits-payouts-parser');
    for (const [raw, clean, whole] of NOISY) {
      expect(trimFloatNoise(raw)).toBe(clean);
      expect(roundHalfUpWhole(raw)).toBe(whole);
    }
    expect(roundHalfUpWhole(2.675)).toBe(3);
    expect(roundHalfUpWhole(0.5)).toBe(1);
    expect(roundHalfUpWhole(0.49)).toBe(0);
  });

  it('I2: edge values pass through trimFloatNoise unchanged (negatives, integers, huge, non-finite)', async () => {
    const { trimFloatNoise } = await import('../credits-payouts-parser');
    for (const v of [-14.499999999999998, -0.4, 0, 500, 1e11 + 0.5, 123456789012.345, 1e300,
      Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(trimFloatNoise(v)).toBe(v);
    }
    expect(Number.isNaN(trimFloatNoise(NaN))).toBe(true);
  });

  it('I3: POINTS formula cell 14.499999999999998 → 15 pts, originalAmount shown as 14.5', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [['WS-001', 'Anand Wholesale', 14.499999999999998, 660 * 0.175, '', '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const vol = result.rows.find((r) => r.fieldId === 'f_vol')!;
    const vis = result.rows.find((r) => r.fieldId === 'f_vis')!;
    expect(vol.status).toBe('OK');
    expect(vol.amount).toBe(15);
    expect(vol.originalAmount).toBe(14.5);
    expect(vis.amount).toBe(116);
    expect(vis.originalAmount).toBe(115.5);
    expect(result.summary.totalPoints).toBe(131);
  });

  it('I4: PAYOUT formula cells round half-up to whole rupees (₹31.5 → ₹32, ₹61.5 → ₹62)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [['RT-001', 'Sharma Store', 180 * 0.175, 61.49999999999999, '', '']],
    );
    const result = parseCreditUpload(buf, DEFAULT_OPTS);
    const vol = result.rows.find((r) => r.fieldId === 'f_vol')!;
    const vis = result.rows.find((r) => r.fieldId === 'f_vis')!;
    expect(vol.awardType).toBe('PAYOUT');
    expect(vol.amount).toBe(3200);
    expect(vol.originalAmount).toBe(31.5);
    expect(vis.amount).toBe(6200);
    expect(vis.originalAmount).toBe(61.5);
    expect(result.summary.totalPayoutPaise).toBe(9400);
  });

  it('I5: 0.5 → 1 (OK); 0.49 → 0 (SKIP); a noise-only whole value records no originalAmount', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [
        ['WS-001', 'Anand Wholesale', 0.5, 0.49, '', ''],
        ['WS-002', 'Bharat Traders', 1.005 * 1000, '', '', ''],
      ],
    );
    const result = parseCreditUpload(buf, { ...DEFAULT_OPTS, outlets: [...DEFAULT_OPTS.outlets, { ...DEFAULT_OPTS.outlets[0], id: 'WS-002', name: 'Bharat Traders' }] });
    const half = result.rows.find((r) => r.outletId === 'WS-001' && r.fieldId === 'f_vol')!;
    const low = result.rows.find((r) => r.outletId === 'WS-001' && r.fieldId === 'f_vis')!;
    const noise = result.rows.find((r) => r.outletId === 'WS-002' && r.fieldId === 'f_vol')!;
    expect(half.status).toBe('OK');
    expect(half.amount).toBe(1);
    expect(low.status).toBe('SKIP');
    expect(low.skipReason).toMatch(/0\.49 rounds to 0/);
    expect(noise.status).toBe('OK');
    expect(noise.amount).toBe(1005);
    expect('originalAmount' in noise).toBe(false);
  });
});

// ─── N — Negative points become deductions (tenant setting creditUploadNegativeDeductions) ──────

describe('N — negative values: deductions behind the negativeDeductions option', () => {
  const ON = { ...DEFAULT_OPTS, negativeDeductions: true };
  const one = (val: string | number, outlet = 'WS-001') =>
    buildXlsx(makeHeaders([FIELD_VOL]), [[outlet, 'Name', val, '']]);

  it('N1: setting OFF (default) — a negative value keeps the old error, row ERROR', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const r = parseCreditUpload(one(-320), DEFAULT_OPTS);
    expect(r.rows[0].status).toBe('ERROR');
    expect(r.rows[0].errors).toContain('Amount cannot be negative (got -320).');
    expect(r.canProceed).toBe(false);
    expect(r.summary.deducted).toBe(0);
    expect(r.summary.totalDeductedPoints).toBe(0);
  });

  it('N1b: explicit negativeDeductions:false behaves exactly like the default', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = one(-320);
    expect(parseCreditUpload(buf, { ...DEFAULT_OPTS, negativeDeductions: false }))
      .toEqual(parseCreditUpload(buf, DEFAULT_OPTS));
  });

  it('N2: ON — a negative POINTS value is an OK deduction row with amount −N', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const r = parseCreditUpload(one(-320), ON);
    expect(r.rows[0].status).toBe('OK');
    expect(r.rows[0].amount).toBe(-320);
    expect(r.rows[0].awardType).toBe('POINTS');
    expect(r.rows[0].errors).toEqual([]);
    expect('originalAmount' in r.rows[0]).toBe(false);
    expect(r.canProceed).toBe(true);
  });

  it('N3: ON — rounding: −199.5 → −200, −199.4 → −199 (originalAmount kept), −0.4 → SKIP', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const a = parseCreditUpload(one(-199.5), ON).rows[0];
    expect(a.status).toBe('OK');
    expect(a.amount).toBe(-200);
    expect(a.originalAmount).toBe(-199.5);
    const b = parseCreditUpload(one(-199.4), ON).rows[0];
    expect(b.amount).toBe(-199);
    expect(b.originalAmount).toBe(-199.4);
    const c = parseCreditUpload(one(-0.4), ON);
    expect(c.rows[0].status).toBe('SKIP');
    expect(c.rows[0].amount).toBe(0);
    expect(c.rows[0].skipReason).toBe(
      'Value -0.4 rounds to 0 — amounts are deducted in whole units, so nothing is deducted for this row.',
    );
    expect(c.canProceed).toBe(false);
  });

  it('N3b: ON — −0.5 rounds to −1 (half-up on the magnitude), not to 0', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const r = parseCreditUpload(one(-0.5), ON).rows[0];
    expect(r.status).toBe('OK');
    expect(r.amount).toBe(-1);
  });

  it('N4: ON — a negative PAYOUT value is an error with the exact payout message', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const r = parseCreditUpload(one(-500, 'RT-001'), ON).rows[0];
    expect(r.status).toBe('ERROR');
    expect(r.errors).toEqual(["Payout amounts can't be negative — deduct via Reversals."]);
  });

  it('N5: ON — unknown outlet with a negative value: only the "not found" error', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const r = parseCreditUpload(one(-50, 'NOPE-1'), ON).rows[0];
    expect(r.status).toBe('ERROR');
    expect(r.errors).toEqual(['Outlet ID "NOPE-1" not found in the active outlet master.']);
  });

  it('N6: ON — safety cap on the ROUNDED magnitude (−50000.5 → −50001 errors; −50000 is fine)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const over = parseCreditUpload(one(-50000.5), ON).rows[0];
    expect(over.status).toBe('ERROR');
    expect(over.errors).toEqual(['Deduction -50000.5 (rounds to -50001) exceeds the safety cap of 50000 for points.']);
    const over2 = parseCreditUpload(one(-50001), ON).rows[0];
    expect(over2.errors).toEqual(['Deduction -50001 exceeds the safety cap of 50000 for points.']);
    const at = parseCreditUpload(one(-50000), ON).rows[0];
    expect(at.status).toBe('OK');
    expect(at.amount).toBe(-50000);
  });

  it('N7: ON — summary: totalPoints = credited only, deducted totals separate, ok counts both', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(
      makeHeaders([FIELD_VOL, FIELD_VIS]),
      [
        ['WS-001', 'A', 500, -199.5, '', ''],   // credit 500, deduction 200 (rounded)
        ['RT-001', 'B', 1000, '', '', ''],      // payout ₹1000
      ],
    );
    const r = parseCreditUpload(buf, { ...ON, outlets: [...OUTLETS, { id: 'WS-002', name: 'W2', type: 'WHOLESALER' }] });
    expect(r.summary.ok).toBe(3);
    expect(r.summary.totalPoints).toBe(500);
    expect(r.summary.deducted).toBe(1);
    expect(r.summary.totalDeductedPoints).toBe(200);
    expect(r.summary.totalPayoutPaise).toBe(100000);
    expect(r.summary.rounded).toBe(1);
    expect(r.summary.errors).toBe(0);
    expect(r.canProceed).toBe(true);
  });

  it('N8: ON — float noise on a negative is trimmed on the magnitude (−14.499999999999998 → −15)', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const r = parseCreditUpload(one(-14.499999999999998), ON).rows[0];
    expect(r.amount).toBe(-15);
    expect(r.originalAmount).toBe(-14.5);
  });

  it('N9: early-return summaries carry deducted/totalDeductedPoints = 0', async () => {
    const { parseCreditUpload } = await import('../credits-payouts-parser');
    const buf = buildXlsx(['Wrong'], []);
    const r = parseCreditUpload(buf, ON);
    expect(r.headerError).not.toBeNull();
    expect(r.summary.deducted).toBe(0);
    expect(r.summary.totalDeductedPoints).toBe(0);
  });
});
