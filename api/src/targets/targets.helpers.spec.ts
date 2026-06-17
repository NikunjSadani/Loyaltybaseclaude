/**
 * Unit tests for targets.helpers.ts — pure functions, no DI required.
 *
 * Covers:
 *   • parseMonthHeader — month-label detection
 *   • getEnabledKpis — enabled filter + ordering
 *   • generateTargetTemplateBuffer — produces a valid xlsx with correct structure
 *   • parseTargetUploadBuffer:
 *       – blank cell → key OMITTED from targetValues (the critical contract)
 *       – unknown outlet → rejected_outlet
 *       – valid numbers stored verbatim (no compute)
 *       – multiple months handled correctly
 *       – fully-blank row → skipped_blank
 *       – non-numeric cell → key omitted (treated as blank)
 */

import * as XLSX from 'xlsx';
import {
  parseMonthHeader,
  getEnabledKpis,
  generateTargetTemplateBuffer,
  parseTargetUploadBuffer,
  KpiDefLike,
  OutletLike,
} from './targets.helpers';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const KPI_A: KpiDefLike = {
  code: 'MONTH_TGT',
  label: 'Month Target',
  isPrimary: true,
  hasNameOverride: false,
  nameOverrideLabel: null,
  order: 1,
  enabled: true,
};
const KPI_B: KpiDefLike = {
  code: 'FOCUS_PACK_1',
  label: 'Focus Pack - 1',
  isPrimary: false,
  hasNameOverride: true,
  nameOverrideLabel: 'Focus Pack 1 Name',
  order: 2,
  enabled: true,
};
const KPI_C_DISABLED: KpiDefLike = {
  code: 'DISABLED_KPI',
  label: 'Disabled KPI',
  isPrimary: false,
  hasNameOverride: false,
  nameOverrideLabel: null,
  order: 3,
  enabled: false,
};

const OUTLET_1: OutletLike = { outletCode: 'O001', name: 'Outlet One',  outletType: 'RETAIL' };
const OUTLET_2: OutletLike = { outletCode: 'O002', name: 'Outlet Two',  outletType: 'HORECA' };

const ALL_KPIS = [KPI_A, KPI_B, KPI_C_DISABLED];
const ENABLED_KPIS = [KPI_A, KPI_B];
const OUTLETS = [OUTLET_1, OUTLET_2];
const KNOWN_CODES = new Set(['O001', 'O002']);
const MONTHS = ['2026-07', '2026-08'];

// ─── Helper: build a minimal xlsx buffer matching the template layout ──────────

/**
 * Builds a test xlsx from raw arrays-of-arrays (row1 = group headers,
 * row2 = col headers, rest = data rows).
 */
function makeXlsx(aoa: (string | number | null)[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'Targets');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── parseMonthHeader ─────────────────────────────────────────────────────────

describe('parseMonthHeader', () => {
  it("parses \"Jul '26 Target\" → \"2026-07\"", () => {
    expect(parseMonthHeader("Jul '26 Target")).toBe('2026-07');
  });
  it('parses "July 2026 Target" → "2026-07"', () => {
    expect(parseMonthHeader('July 2026 Target')).toBe('2026-07');
  });
  it('parses "Jan \'26 Target" → "2026-01"', () => {
    expect(parseMonthHeader("Jan '26 Target")).toBe('2026-01');
  });
  it('returns null for unrecognised strings', () => {
    expect(parseMonthHeader('Month Target')).toBeNull();
    expect(parseMonthHeader('')).toBeNull();
    expect(parseMonthHeader('2026-07')).toBeNull();
  });
  it('is case-insensitive', () => {
    expect(parseMonthHeader("JUL '26 TARGET")).toBe('2026-07');
  });
});

// ─── getEnabledKpis ───────────────────────────────────────────────────────────

describe('getEnabledKpis', () => {
  it('filters out disabled KPIs', () => {
    const result = getEnabledKpis(ALL_KPIS);
    expect(result.map((k) => k.code)).toEqual(['MONTH_TGT', 'FOCUS_PACK_1']);
  });
  it('sorts by order ascending', () => {
    const shuffled: KpiDefLike[] = [
      { ...KPI_B },
      { ...KPI_A },
    ];
    const result = getEnabledKpis(shuffled);
    expect(result[0].code).toBe('MONTH_TGT');
    expect(result[1].code).toBe('FOCUS_PACK_1');
  });
  it('returns empty array when all disabled', () => {
    expect(getEnabledKpis([KPI_C_DISABLED])).toEqual([]);
  });
});

// ─── generateTargetTemplateBuffer ────────────────────────────────────────────

describe('generateTargetTemplateBuffer', () => {
  it('returns a non-empty Buffer', () => {
    const buf = generateTargetTemplateBuffer(ENABLED_KPIS, MONTHS, OUTLETS);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('contains the correct month group headers in row 1', () => {
    const buf = generateTargetTemplateBuffer(ENABLED_KPIS, MONTHS, OUTLETS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });
    const row1 = aoa[0] as string[];
    // "Jul '26 Target" should appear at column 3 (after 3 fixed cols)
    expect(row1[3]).toMatch(/jul.*26.*target/i);
    // "Aug '26 Target" at column 3 + 2 (2 enabled KPIs)
    expect(row1[5]).toMatch(/aug.*26.*target/i);
  });

  it('contains KPI labels in row 2 for each month', () => {
    const buf = generateTargetTemplateBuffer(ENABLED_KPIS, MONTHS, OUTLETS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    const row2 = aoa[1] as string[];
    // Fixed cols
    expect(row2[0]).toBe('Outlet ID');
    expect(row2[1]).toBe('Outlet Name');
    expect(row2[2]).toBe('Outlet Type');
    // KPIs for month 1 at cols 3, 4
    expect(row2[3]).toBe('Month Target');
    expect(row2[4]).toBe('Focus Pack - 1');
    // KPIs for month 2 at cols 5, 6
    expect(row2[5]).toBe('Month Target');
    expect(row2[6]).toBe('Focus Pack - 1');
  });

  it('pre-fills outlet rows (data starts at row 3)', () => {
    const buf = generateTargetTemplateBuffer(ENABLED_KPIS, MONTHS, OUTLETS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });
    const row3 = aoa[2] as string[];
    expect(row3[0]).toBe('O001');
    expect(row3[1]).toBe('Outlet One');
    expect(row3[2]).toBe('RETAIL');
  });

  it('leaves KPI cells blank in the outlet rows', () => {
    const buf = generateTargetTemplateBuffer(ENABLED_KPIS, MONTHS, OUTLETS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });
    const row3 = aoa[2] as (string | number)[];
    // KPI columns (indices 3 onwards) should be blank
    for (let ci = 3; ci < row3.length; ci++) {
      expect(String(row3[ci]).trim()).toBe('');
    }
  });

  it('excludes disabled KPIs', () => {
    const buf = generateTargetTemplateBuffer(ALL_KPIS, ['2026-07'], OUTLETS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    const row2 = (aoa[1] as string[]).map((c) => c.toLowerCase());
    expect(row2.join(',')).not.toContain('disabled');
  });
});

// ─── parseTargetUploadBuffer ──────────────────────────────────────────────────

describe('parseTargetUploadBuffer', () => {
  /**
   * Builds a minimal test xlsx with:
   *   Row 1: [, , , "Jul '26 Target", ""]
   *   Row 2: [Outlet ID, Outlet Name, Outlet Type, Month Target, Focus Pack - 1]
   *   Row 3+: data rows
   */
  function buildTestXlsx(
    dataRows: (string | number | null)[][],
    months = ["Jul '26 Target"],
  ): Buffer {
    const numKpis = ENABLED_KPIS.length;
    // Row 1: fixed blanks + month header + blanks for remaining KPI cols
    const row1: (string | null)[] = ['', '', ''];
    for (const mHeader of months) {
      row1.push(mHeader);
      for (let i = 1; i < numKpis; i++) row1.push('');
    }
    // Row 2: fixed cols + KPI labels per month
    const row2: string[] = ['Outlet ID', 'Outlet Name', 'Outlet Type'];
    for (let mi = 0; mi < months.length; mi++) {
      for (const kpi of ENABLED_KPIS) row2.push(kpi.label);
    }

    return makeXlsx([row1, row2, ...dataRows]);
  }

  // ── CRITICAL: blank cell → omitted key ────────────────────────────────────

  it('CRITICAL: blank cell in a KPI column → key OMITTED from targetValues (not 0)', () => {
    // O001 has MONTH_TGT=100, FOCUS_PACK_1=blank
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, null]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    expect(kpiMap['MONTH_TGT']).toBe(100);
    // FOCUS_PACK_1 was blank → must NOT be present
    expect('FOCUS_PACK_1' in kpiMap).toBe(false);
  });

  it('CRITICAL: empty string cell → key OMITTED (not stored as 0)', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', '', 50]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    expect('MONTH_TGT' in kpiMap).toBe(false);
    expect(kpiMap['FOCUS_PACK_1']).toBe(50);
  });

  it('stores numbers verbatim (no rounding, no compute)', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 123.456, 789]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap['MONTH_TGT']).toBe(123.456);
    expect(kpiMap['FOCUS_PACK_1']).toBe(789);
  });

  it('non-numeric cell (e.g. "N/A") → key OMITTED', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 'N/A', 200]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    expect('MONTH_TGT' in kpiMap).toBe(false);
    expect(kpiMap['FOCUS_PACK_1']).toBe(200);
  });

  // ── Unknown outlet ────────────────────────────────────────────────────────

  it('unknown outlet code → status=rejected_outlet, excluded from acceptedTargets', () => {
    const buf = buildTestXlsx([['GHOST', 'Ghost Outlet', 'RETAIL', 100, 200]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    expect(result.rows[0].status).toBe('rejected_outlet');
    expect(result.acceptedTargets['2026-07']?.['GHOST']).toBeUndefined();
    expect(result.summary.rejected).toBe(1);
    expect(result.summary.accepted).toBe(0);
  });

  // ── Fully-blank row ───────────────────────────────────────────────────────

  it('fully blank KPI row (known outlet) → status=skipped_blank', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', null, null]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    expect(result.rows[0].status).toBe('skipped_blank');
    expect(result.acceptedTargets['2026-07']?.['O001']).toBeUndefined();
    expect(result.summary.accepted).toBe(0);
  });

  // ── Multiple months ───────────────────────────────────────────────────────

  it('handles two months in one upload', () => {
    const buf = buildTestXlsx(
      [
        ['O001', 'Outlet One', 'RETAIL', 100, 50, 120, 60],
        ['O002', 'Outlet Two', 'HORECA', 200, null, 250, null],
      ],
      ["Jul '26 Target", "Aug '26 Target"],
    );
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    // July O001
    expect(result.acceptedTargets['2026-07']['O001']['MONTH_TGT']).toBe(100);
    expect(result.acceptedTargets['2026-07']['O001']['FOCUS_PACK_1']).toBe(50);

    // August O001
    expect(result.acceptedTargets['2026-08']['O001']['MONTH_TGT']).toBe(120);
    expect(result.acceptedTargets['2026-08']['O001']['FOCUS_PACK_1']).toBe(60);

    // July O002 — FOCUS_PACK_1 blank → omitted
    expect(result.acceptedTargets['2026-07']['O002']['MONTH_TGT']).toBe(200);
    expect('FOCUS_PACK_1' in result.acceptedTargets['2026-07']['O002']).toBe(false);
  });

  // ── Summary counters ──────────────────────────────────────────────────────

  it('summary: 1 accepted + 1 rejected + 1 skipped_blank', () => {
    const buf = buildTestXlsx([
      ['O001', 'Outlet One', 'RETAIL', 100, 50],  // accepted
      ['GHOST', 'Ghost', 'RETAIL', 10, 20],         // rejected_outlet
      ['O002', 'Outlet Two', 'HORECA', null, null], // skipped_blank
    ]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    expect(result.summary.total).toBe(3);
    expect(result.summary.accepted).toBe(1);
    expect(result.summary.rejected).toBe(1);
  });

  // ── Empty file ────────────────────────────────────────────────────────────

  it('file with only headers (no data rows) → empty result', () => {
    const buf = buildTestXlsx([]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    expect(result.rows).toHaveLength(0);
    expect(result.acceptedTargets).toEqual({});
    expect(result.summary.total).toBe(0);
  });

  // ── Zero and negative numbers ──────────────────────────────────────────────

  it('zero value is stored verbatim (0 is a valid configured target)', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 0, 100]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    expect(kpiMap['MONTH_TGT']).toBe(0);
    expect(kpiMap['FOCUS_PACK_1']).toBe(100);
  });
});
