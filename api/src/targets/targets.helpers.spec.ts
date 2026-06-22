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
  buildResolvedTargetsBuffer,
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
    // Block width = 3 (Month Target value + Focus Pack value + Focus Pack name —
    // KPI_B has a name override). So "Aug '26 Target" starts at col 3 + 3 = 6.
    expect(row1[6]).toMatch(/aug.*26.*target/i);
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
    // Month 1 block (width 3): value, value, name-override.
    expect(row2[3]).toBe('Month Target');     // KPI_A value (no override)
    expect(row2[4]).toBe('Focus Pack - 1');   // KPI_B value
    expect(row2[5]).toBe('Focus Pack 1 Name'); // KPI_B name-override column
    // Month 2 block starts at col 6.
    expect(row2[6]).toBe('Month Target');
    expect(row2[7]).toBe('Focus Pack - 1');
    expect(row2[8]).toBe('Focus Pack 1 Name');
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

  // ── Locale thousands separators (en-IN) ────────────────────────────────────

  it('locale string "1,234" → 1234 (thousands comma stripped, NOT truncated to 1)', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', '1,234', 50]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    expect(kpiMap['MONTH_TGT']).toBe(1234);
    expect(kpiMap['FOCUS_PACK_1']).toBe(50);
  });

  it('Indian-grouped string "1,23,456.78" → 123456.78 stored verbatim', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', '1,23,456.78', 100]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    expect(kpiMap['MONTH_TGT']).toBe(123456.78);
    expect(kpiMap['FOCUS_PACK_1']).toBe(100);
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

  // ── DATA-INTEGRITY: name-based KPI→column mapping (anchor drift / order) ─────
  //
  // The merged month-group header in row 1 can drift relative to the row-2 KPI
  // block (Excel re-save / inserted column / shifted merge). The OLD parser read
  // KPIs at `startCol + offset`, so a one-column drift slid the whole window and
  // every value landed on the WRONG KpiDef — exposed when a KPI cell is blank.
  // The fix maps each KPI by its row-2 header NAME at its ABSOLUTE column.

  it('REGRESSION: row-1 anchor drifted ONE COLUMN LEFT of the KPI block + a blank KPI cell → values still map to the CORRECT KpiDef', () => {
    // The row-1 month-group label is anchored ONE COLUMN to the LEFT of the first
    // KPI header — the merge did not shift with the data. There are THREE KPIs
    // enabled so the OLD positional window [startCol, startCol+3) genuinely
    // mis-reads: it slides one column left of the real KPI columns.
    //   Row1: [ , , , "Jul '26 Target"(col 3), "", "", "" ]   (anchor = col 3)
    //   Row2: [Outlet ID, Outlet Name, Outlet Type, "",  Monthly,      Consistency, Focus Product]
    //   Data: [O002,      Outlet Two,  HORECA,       "",  100,          5,           ""          ]
    // OLD code window = cols 3,4,5 → reads labels "", "Monthly", "Consistency"
    //   and VALUES from cols 3,4,5 = "", 100, 5 → MONTHLY=100, CONSISTENCY=5
    //   BUT "Focus Product" (col 6) is OUTSIDE the window → dropped, and worse the
    //   value alignment is one column short of the real layout. With the blank
    //   Focus-Product cell the shift surfaces: the OLD reader cannot see col 6.
    // FIX: name-match the absolute cols 4,5,6 → MONTHLY=100, CONSISTENCY=5,
    //   FOCUS_PRODUCT blank (omitted) — correct.
    const kpiMonthly: KpiDefLike = {
      code: 'MONTHLY', label: 'Monthly', isPrimary: true,
      hasNameOverride: false, nameOverrideLabel: null, order: 1, enabled: true,
    };
    const kpiConsistency: KpiDefLike = {
      code: 'CONSISTENCY', label: 'Consistency', isPrimary: false,
      hasNameOverride: false, nameOverrideLabel: null, order: 2, enabled: true,
    };
    const kpiFocus: KpiDefLike = {
      code: 'FOCUS_PRODUCT', label: 'Focus Product', isPrimary: false,
      hasNameOverride: false, nameOverrideLabel: null, order: 3, enabled: true,
    };
    const kpis = [kpiMonthly, kpiConsistency, kpiFocus];

    const row1 = ['', '', '', "Jun '26 Target", '', '', ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', '', 'Monthly', 'Consistency', 'Focus Product'];
    const data = ['O002', 'Outlet Two', 'HORECA', '', 100, 5, ''];
    const buf = makeXlsx([row1, row2, data]);

    const result = parseTargetUploadBuffer(buf, kpis, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-06']?.['O002'];
    expect(kpiMap).toBeDefined();
    // Each value maps to the CORRECT KpiDef; Focus Product blank → omitted.
    expect(kpiMap['MONTHLY']).toBe(100);
    expect(kpiMap['CONSISTENCY']).toBe(5);
    expect('FOCUS_PRODUCT' in kpiMap).toBe(false);
  });

  it('REGRESSION: reordered + drifted block with a blank KPI cell → values still map correctly by name', () => {
    // The KPI block is BOTH reordered (Focus Pack before Month Target) AND the
    // Focus Pack cell is blank. Under positional reads this is exactly the case
    // that mis-assigns: the OLD code would have read MONTH_TGT from the first KPI
    // column (Focus Pack header) and slid the 100 onto the wrong code.
    //   Row1: [ , , , "Jul '26 Target", "" ]   (anchor at col 3)
    //   Row2: [Outlet ID, Outlet Name, Outlet Type, Focus Pack - 1, Month Target]
    //   Data: [O002,      Outlet Two,  HORECA,       "",             100         ]
    const row1 = ['', '', '', "Jul '26 Target", ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Focus Pack - 1', 'Month Target'];
    const data = ['O002', 'Outlet Two', 'HORECA', '', 100];
    const buf = makeXlsx([row1, row2, data]);

    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O002'];
    expect(kpiMap).toBeDefined();
    // Focus Pack column is blank → omitted; Month Target column holds 100.
    expect(kpiMap['MONTH_TGT']).toBe(100);
    expect('FOCUS_PACK_1' in kpiMap).toBe(false);
  });

  it('ORDER-INDEPENDENCE: KPI columns in non-template order → mapped correctly by name', () => {
    // Row 2 lists Focus Pack BEFORE Month Target (reverse of template order).
    //   Row2: [Outlet ID, Outlet Name, Outlet Type, Focus Pack - 1, Month Target]
    //   Data: [O001,      Outlet One,  RETAIL,       77,             42          ]
    const row1 = ['', '', '', "Jul '26 Target", ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Focus Pack - 1', 'Month Target'];
    const data = ['O001', 'Outlet One', 'RETAIL', 77, 42];
    const buf = makeXlsx([row1, row2, data]);

    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    // Mapped by NAME, not position: Focus Pack=77, Month Target=42.
    expect(kpiMap['FOCUS_PACK_1']).toBe(77);
    expect(kpiMap['MONTH_TGT']).toBe(42);
  });

  it('CLEAN TEMPLATE still parses correctly (no regression)', () => {
    const buf = buildTestXlsx([['O001', 'Outlet One', 'RETAIL', 100, 50]]);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    const kpiMap = result.acceptedTargets['2026-07']?.['O001'];
    expect(kpiMap).toBeDefined();
    expect(kpiMap['MONTH_TGT']).toBe(100);
    expect(kpiMap['FOCUS_PACK_1']).toBe(50);
  });

  // ── Integrity guard: KPI columns don't match the configured KPIs ────────────

  it('INTEGRITY GUARD: a block whose columns do not cover the enabled KPIs → file rejected', () => {
    // Only ONE of the two enabled KPI labels is present in row 2 → the block
    // cannot be unambiguously mapped → reject the whole upload.
    const row1 = ['', '', '', "Jul '26 Target", ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Some Other Column'];
    const data = ['O001', 'Outlet One', 'RETAIL', 100, 50];
    const buf = makeXlsx([row1, row2, data]);

    expect(() => parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES)).toThrow(
      /KPI columns don't match the configured KPIs/i,
    );
  });

  it('INTEGRITY GUARD: a block resolving ZERO KPI columns → file rejected', () => {
    const row1 = ['', '', '', "Jul '26 Target", ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Foo', 'Bar'];
    const data = ['O001', 'Outlet One', 'RETAIL', 100, 50];
    const buf = makeXlsx([row1, row2, data]);

    expect(() => parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES)).toThrow(
      /re-download the template/i,
    );
  });
});

// ─── buildResolvedTargetsBuffer round-trip ────────────────────────────────────
//
// The "Download Final Targets" export must produce a file that can be re-uploaded
// straight back through parseTargetUploadBuffer (it shares the month-group 2-row
// layout). A single-header export parses to 0 rows — this guards that regression.

describe('buildResolvedTargetsBuffer ↔ parseTargetUploadBuffer round-trip', () => {
  it('a Final-Targets export re-parses to the same accepted values', () => {
    const month = '2026-07';
    const storedRows = [
      {
        outletCode: 'O001',
        outletName: 'Outlet One',
        outletType: 'RETAIL',
        // MONTH_TGT configured, FOCUS_PACK_1 omitted (not configured → blank cell)
        targetValues: { MONTH_TGT: 1234 } as Record<string, unknown>,
      },
      {
        outletCode: 'O002',
        outletName: 'Outlet Two',
        outletType: 'HORECA',
        targetValues: { MONTH_TGT: 500, FOCUS_PACK_1: 78.5 } as Record<string, unknown>,
      },
    ];

    const buf = buildResolvedTargetsBuffer(month, ENABLED_KPIS, storedRows);
    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);

    // Both rows accepted (non-empty), nothing skipped as blank.
    expect(result.summary.accepted).toBe(2);

    const o1 = result.acceptedTargets[month]?.['O001'];
    expect(o1).toBeDefined();
    expect(o1['MONTH_TGT']).toBe(1234);
    // blank export cell → key omitted on re-parse (the no-compute contract)
    expect('FOCUS_PACK_1' in o1).toBe(false);

    const o2 = result.acceptedTargets[month]?.['O002'];
    expect(o2).toBeDefined();
    expect(o2['MONTH_TGT']).toBe(500);
    expect(o2['FOCUS_PACK_1']).toBe(78.5);
  });

  it('does NOT surface the reserved __names key as a column in the export', () => {
    // A stored row whose targetValues carries a __names override must export only
    // KPI-value columns — __names is read by code, never enumerated as a column.
    const buf = buildResolvedTargetsBuffer('2026-07', ENABLED_KPIS, [
      {
        outletCode: 'O001',
        outletName: 'Outlet One',
        outletType: 'RETAIL',
        targetValues: {
          MONTH_TGT: 10,
          FOCUS_PACK_1: 5,
          __names: { FOCUS_PACK_1: 'Diwali Combo' },
        },
      },
    ]);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });
    const row2 = (aoa[1] as string[]).map((c) => String(c));
    // Only the fixed cols + KPI value labels — no "__names" / "Diwali Combo" col.
    expect(row2.join(',')).not.toContain('__names');
    expect(row2.join(',')).not.toContain('Diwali Combo');
  });

  it('the export emits the two-row month-group header (row1 month label, row2 fixed cols)', () => {
    const buf = buildResolvedTargetsBuffer('2026-07', ENABLED_KPIS, [
      {
        outletCode: 'O001',
        outletName: 'Outlet One',
        outletType: 'RETAIL',
        targetValues: { MONTH_TGT: 10 },
      },
    ]);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });

    const row1 = aoa[0] as string[];
    const row2 = aoa[1] as string[];
    // Month-group label sits at the first KPI column (after 3 fixed cols).
    expect(String(row1[3])).toMatch(/jul.*26.*target/i);
    expect(row2[0]).toBe('Outlet ID');
    expect(row2[1]).toBe('Outlet Name');
    expect(row2[2]).toBe('Outlet Type');
    expect(row2[3]).toBe('Month Target');
  });
});

// ─── KPI name-override (__names) round-trip ───────────────────────────────────
//
// A KPI configured with hasNameOverride + nameOverrideLabel emits an EXTRA Row-2
// column (the nameOverrideLabel) right after its value column. On upload, the
// per-outlet string typed in that column is stored at targetValues.__names[code].
// KPIs WITHOUT an override are byte-identical to before (single value column).
//
// Fixture KPI_B (FOCUS_PACK_1) has hasNameOverride:true, nameOverrideLabel:'Focus
// Pack 1 Name'. KPI_A (MONTH_TGT) has no override.

describe('KPI name-override (__names) round-trip', () => {
  it('template emits the nameOverrideLabel as an extra Row-2 header after the value column', () => {
    const buf = generateTargetTemplateBuffer(ENABLED_KPIS, ['2026-07'], OUTLETS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    const row2 = aoa[1] as string[];
    // [Outlet ID, Outlet Name, Outlet Type, Month Target, Focus Pack - 1, Focus Pack 1 Name]
    expect(row2[3]).toBe('Month Target');           // KPI_A value (no override)
    expect(row2[4]).toBe('Focus Pack - 1');         // KPI_B value
    expect(row2[5]).toBe('Focus Pack 1 Name');      // KPI_B override-name column
    // KPI_A (no override) must NOT have emitted a name column.
    expect(row2).not.toContain('');                 // no stray blank header in the block
  });

  it('a KPI WITHOUT an override stays single-column (round-trip unchanged)', () => {
    // Only KPI_A enabled → no override columns at all; row 2 = fixed + Month Target.
    const buf = generateTargetTemplateBuffer([KPI_A], ['2026-07'], OUTLETS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    const row2 = aoa[1] as string[];
    expect(row2).toEqual(['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target']);
  });

  it('upload stores a per-outlet name at targetValues.__names[code] AND keeps the KPI value', () => {
    // Row 2: fixed + Month Target + Focus Pack - 1 + Focus Pack 1 Name
    const row1 = ['', '', '', "Jul '26 Target", '', ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1', 'Focus Pack 1 Name'];
    // O001: MONTH_TGT=100, FOCUS_PACK_1=20, name="Diwali Combo"
    const data = ['O001', 'Outlet One', 'RETAIL', 100, 20, 'Diwali Combo'];
    const buf = makeXlsx([row1, row2, data]);

    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);
    const kpiMap = result.acceptedTargets['2026-07']?.['O001'] as Record<string, unknown>;
    expect(kpiMap).toBeDefined();
    // KPI values still parsed correctly.
    expect(kpiMap['MONTH_TGT']).toBe(100);
    expect(kpiMap['FOCUS_PACK_1']).toBe(20);
    // The custom name landed under the reserved __names key, keyed by KPI code.
    expect(kpiMap['__names']).toEqual({ FOCUS_PACK_1: 'Diwali Combo' });
  });

  it('a numeric-looking name cell is coerced to a trimmed string', () => {
    const row1 = ['', '', '', "Jul '26 Target", '', ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1', 'Focus Pack 1 Name'];
    // SheetJS may hand back a number for "2024" — must be stored as the string "2024".
    const data = ['O001', 'Outlet One', 'RETAIL', 100, 20, 2024];
    const buf = makeXlsx([row1, row2, data]);

    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);
    const kpiMap = result.acceptedTargets['2026-07']?.['O001'] as Record<string, unknown>;
    expect(kpiMap['__names']).toEqual({ FOCUS_PACK_1: '2024' });
  });

  it('a BLANK name cell → __names key OMITTED entirely (never {})', () => {
    const row1 = ['', '', '', "Jul '26 Target", '', ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1', 'Focus Pack 1 Name'];
    // Name column blank → no override stored.
    const data = ['O001', 'Outlet One', 'RETAIL', 100, 20, ''];
    const buf = makeXlsx([row1, row2, data]);

    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);
    const kpiMap = result.acceptedTargets['2026-07']?.['O001'] as Record<string, unknown>;
    expect(kpiMap['MONTH_TGT']).toBe(100);
    expect(kpiMap['FOCUS_PACK_1']).toBe(20);
    expect('__names' in kpiMap).toBe(false);
  });

  it('full template→upload round-trip: generated template parses names back', () => {
    // Build the real template, then simulate an admin filling in values + a name.
    const tmpl = generateTargetTemplateBuffer(ENABLED_KPIS, ['2026-07'], OUTLETS);
    const wb = XLSX.read(tmpl, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });
    // Row 2 layout: [..fixed, Month Target(3), Focus Pack - 1(4), Focus Pack 1 Name(5)]
    // Fill O001 (first data row, index 2): value cols + the name col.
    (aoa[2] as (string | number)[])[3] = 150;            // MONTH_TGT
    (aoa[2] as (string | number)[])[4] = 30;             // FOCUS_PACK_1
    (aoa[2] as (string | number)[])[5] = 'Festive Pack'; // FOCUS_PACK_1 name override
    const filled = makeXlsx(aoa as (string | number | null)[][]);

    const result = parseTargetUploadBuffer(filled, ENABLED_KPIS, KNOWN_CODES);
    const kpiMap = result.acceptedTargets['2026-07']?.['O001'] as Record<string, unknown>;
    expect(kpiMap['MONTH_TGT']).toBe(150);
    expect(kpiMap['FOCUS_PACK_1']).toBe(30);
    expect(kpiMap['__names']).toEqual({ FOCUS_PACK_1: 'Festive Pack' });
  });

  it('a name with NO numeric value in the block → __names omitted (name only is not a value)', () => {
    // O001 has only the name filled, both KPI value cells blank → row is skipped
    // as blank (names ride with values; a name alone is meaningless).
    const row1 = ['', '', '', "Jul '26 Target", '', ''];
    const row2 = ['Outlet ID', 'Outlet Name', 'Outlet Type', 'Month Target', 'Focus Pack - 1', 'Focus Pack 1 Name'];
    const data = ['O001', 'Outlet One', 'RETAIL', '', '', 'Orphan Name'];
    const buf = makeXlsx([row1, row2, data]);

    const result = parseTargetUploadBuffer(buf, ENABLED_KPIS, KNOWN_CODES);
    expect(result.rows[0].status).toBe('skipped_blank');
    expect(result.acceptedTargets['2026-07']?.['O001']).toBeUndefined();
  });
});
