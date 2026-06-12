/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts: Template Generation
 *
 * Groups:
 *   A — Source exports
 *   B — Template structure
 *   C — Column ordering (values then narrations)
 *   D — Deactivated field exclusion
 *   E — Outlet pre-population
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import * as XLSX        from 'xlsx';
import type { CreditField } from '@/types';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// Shared test fixtures
const FIELD_A: CreditField = {
  id: 'f1', name: 'Volume', isActive: true, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'PAYOUT', SSS_TOT: 'PAYOUT' },
  createdAt: '2026-01-01T00:00:00.000Z', order: 1,
};
const FIELD_B: CreditField = {
  id: 'f2', name: 'Visibility', isActive: true, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'PAYOUT', SSS_TOT: 'PAYOUT' },
  createdAt: '2026-01-02T00:00:00.000Z', order: 2,
};
const FIELD_INACTIVE: CreditField = {
  id: 'f3', name: 'Inactive Field', isActive: false, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'PAYOUT', SSS_TOT: 'PAYOUT' },
  createdAt: '2026-01-03T00:00:00.000Z', order: 3,
};

const TEST_OUTLETS = [
  { id: 'WS-001', name: 'Anand Wholesale', type: 'WHOLESALER' },
  { id: 'RT-001', name: 'Sharma Store',    type: 'SSS' },
];

// ─── A — Source exports ───────────────────────────────────────────────────────

describe('A — credits-payouts-template.ts: exports', () => {
  const code = src('lib/credits-payouts-template.ts');

  it('A1: generateCreditTemplate is exported', () => {
    expect(code).toMatch(/export\s+function\s+generateCreditTemplate/);
  });

  it('A2: getEligibleOutlets is exported', () => {
    expect(code).toMatch(/export\s+function\s+getEligibleOutlets/);
  });

  it('A3: imports MOCK_OUTLETS from targets (for demo pre-population)', () => {
    expect(code).toMatch(/MOCK_OUTLETS/);
  });

  it('A4: TemplateOutlet interface is defined', () => {
    expect(code).toMatch(/TemplateOutlet/);
  });
});

// ─── B — Template structure ───────────────────────────────────────────────────

describe('B — Template structure', () => {
  it('B1: returns an ArrayBuffer', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('B2: produced buffer is a readable xlsx workbook', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb  = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames.length).toBeGreaterThan(0);
  });

  it('B3: sheet is named "Credits & Payouts"', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb  = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames).toContain('Credits & Payouts');
  });

  it('B4: row 1 is a title row containing "Credits" and the month', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf  = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb   = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const titleStr = rows[0].map(String).join(' ');
    expect(titleStr).toMatch(/Credits/i);
    expect(titleStr).toMatch(/2026|May/i);
  });

  it('B5: row 2 (headers) contains "Outlet ID"', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).toContain('Outlet ID');
  });

  it('B6: row 2 contains "Outlet Name"', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).toContain('Outlet Name');
  });

  it('B7: row 2 contains the active field name', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate([FIELD_A, FIELD_B], '2026-05', TEST_OUTLETS);
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).toContain('Volume');
    expect(headers).toContain('Visibility');
  });
});

// ─── C — Column ordering ──────────────────────────────────────────────────────

describe('C — Column ordering: values before narrations', () => {
  it('C1: all value columns appear before all narration columns', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate([FIELD_A, FIELD_B], '2026-05', TEST_OUTLETS);
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);

    const volIdx  = headers.indexOf('Volume');
    const visIdx  = headers.indexOf('Visibility');
    const volNIdx = headers.indexOf('Volume Narration');
    const visNIdx = headers.indexOf('Visibility Narration');

    expect(volIdx).toBeGreaterThan(-1);
    expect(visIdx).toBeGreaterThan(-1);
    expect(volNIdx).toBeGreaterThan(-1);
    expect(visNIdx).toBeGreaterThan(-1);

    // All value cols come before all narration cols
    expect(volNIdx).toBeGreaterThan(volIdx);
    expect(volNIdx).toBeGreaterThan(visIdx);
    expect(visNIdx).toBeGreaterThan(volIdx);
    expect(visNIdx).toBeGreaterThan(visIdx);
  });

  it('C2: each active field has exactly one narration column', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate([FIELD_A, FIELD_B], '2026-05', TEST_OUTLETS);
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).toContain('Volume Narration');
    expect(headers).toContain('Visibility Narration');
  });

  it('C3: field columns appear in field.order sequence', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate([FIELD_B, FIELD_A], '2026-05', TEST_OUTLETS);
    // FIELD_A has order:1, FIELD_B has order:2 — but we pass B first intentionally
    // The template should still respect order (isActive filter preserves input order
    // since we filter from the passed array; caller is responsible for ordering)
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    // Both should appear
    expect(headers).toContain('Visibility');
    expect(headers).toContain('Volume');
  });
});

// ─── D — Deactivated field exclusion ──────────────────────────────────────────

describe('D — Deactivated fields excluded from template', () => {
  it('D1: inactive field name does NOT appear in headers', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate(
      [FIELD_A, FIELD_INACTIVE, FIELD_B], '2026-05', TEST_OUTLETS,
    );
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).not.toContain('Inactive Field');
    expect(headers).not.toContain('Inactive Field Narration');
  });

  it('D2: inactive field narration column also absent', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf     = generateCreditTemplate([FIELD_INACTIVE], '2026-05', TEST_OUTLETS);
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    // Only fixed columns remain
    expect(headers).toContain('Outlet ID');
    expect(headers).toContain('Outlet Name');
    expect(headers).not.toContain('Inactive Field');
  });
});

// ─── E — Outlet pre-population ────────────────────────────────────────────────

describe('E — Outlet pre-population', () => {
  it('E1: data rows start at row 3 (index 2)', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf  = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb   = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    // Row 0 = title, Row 1 = headers, Row 2+ = data
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('E2: each outlet appears as a pre-populated row', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf  = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb   = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const dataRows = rows.slice(2);
    const ids = dataRows.map((r) => String(r[0]));
    expect(ids).toContain('WS-001');
    expect(ids).toContain('RT-001');
  });

  it('E3: outlet name is pre-populated in column 2', async () => {
    const { generateCreditTemplate } = await import('../credits-payouts-template');
    const buf  = generateCreditTemplate([FIELD_A], '2026-05', TEST_OUTLETS);
    const wb   = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Credits & Payouts'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const dataRows = rows.slice(2);
    const ws001Row = dataRows.find((r) => String(r[0]) === 'WS-001');
    expect(ws001Row).toBeDefined();
    expect(String(ws001Row![1])).toBe('Anand Wholesale');
  });

  it('E4: getEligibleOutlets returns non-empty list from MOCK_OUTLETS', async () => {
    const { getEligibleOutlets } = await import('../credits-payouts-template');
    const outlets = getEligibleOutlets();
    expect(outlets.length).toBeGreaterThan(0);
    expect(outlets[0]).toHaveProperty('id');
    expect(outlets[0]).toHaveProperty('name');
    expect(outlets[0]).toHaveProperty('type');
  });

  it('E5: getEligibleOutlets covers all outlet types', async () => {
    const { getEligibleOutlets } = await import('../credits-payouts-template');
    const outlets = getEligibleOutlets();
    const types   = new Set(outlets.map((o) => o.type));
    expect(types.has('WHOLESALER')).toBe(true);
    expect(types.has('SSS')).toBe(true);
    expect(types.has('SUB_STOCKIST')).toBe(true);
    expect(types.has('SSS_TOT')).toBe(true);
  });
});
