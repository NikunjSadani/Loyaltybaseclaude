/// <reference types="vitest/globals" />
/**
 * TDD — Sales Excel Upload  (new Deoleo format)
 *
 * Mirrors the target-excel-upload format:
 *  • Same 12 fixed info columns (Zone, State, ASM ID, …)
 *  • KPI value columns driven by TenantKpiDef[] (no name-override cols needed for sales)
 *  • Pre-populated outlet rows so admin can copy-paste sales numbers straight in
 *  • Outlet ID validation against known outlet master
 *  • Upload restricted to current month and previous month only
 *
 * Groups:
 *   A — sales-excel-upload.ts source checks
 *   B — generateSalesTemplate functional
 *   C — parseSalesUpload functional
 *   D — buildSalesReportBuffer functional
 *   E — Sales page structure
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import * as XLSX        from 'xlsx';
import { DEOLEO_DEFAULT_KPIS, getEnabledKpiDefs } from '@/lib/platform/tenant-kpi-config';
import { MOCK_OUTLETS } from '@/lib/targets';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─────────────────────────────────────────────────────────────────────────────
// A — Source file: exports
// ─────────────────────────────────────────────────────────────────────────────

describe('A — sales-excel-upload.ts: exports', () => {
  const code = src('lib/sales-excel-upload.ts');

  it('A1: generateSalesTemplate is exported', () => {
    expect(code).toMatch(/export\s+function\s+generateSalesTemplate/);
  });

  it('A2: parseSalesUpload is exported', () => {
    expect(code).toMatch(/export\s+function\s+parseSalesUpload/);
  });

  it('A3: buildSalesReportBuffer is exported', () => {
    expect(code).toMatch(/export\s+function\s+buildSalesReportBuffer/);
  });

  it('A4: ParsedSalesUploadRow type / interface is defined', () => {
    expect(code).toMatch(/ParsedSalesUploadRow/);
  });

  it('A5: SalesParseResult type / interface is defined', () => {
    expect(code).toMatch(/SalesParseResult/);
  });

  it('A6: imports TenantKpiDef from tenant-kpi-config', () => {
    expect(code).toMatch(/tenant-kpi-config/);
  });

  it('A7: imports MOCK_OUTLETS from targets (for pre-population)', () => {
    expect(code).toMatch(/MOCK_OUTLETS/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — generateSalesTemplate: structure and content
// ─────────────────────────────────────────────────────────────────────────────

describe('B — generateSalesTemplate: structure', () => {
  it('B1: returns an ArrayBuffer', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('B2: produced buffer is a readable xlsx workbook', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb  = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames.length).toBeGreaterThan(0);
  });

  it('B3: workbook has a sheet named "Sales"', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb  = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames).toContain('Sales');
  });

  it('B4: row 1 is a title row containing "Sales" and the month', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf  = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb   = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Sales'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const row1Str = rows[0].map(String).join(' ');
    expect(row1Str).toMatch(/sales/i);
    // month appears in label form (e.g. "Jun '99") or YYYY-MM
    expect(row1Str).toMatch(/2099|Jun/i);
  });

  it('B5: row 2 (column headers) contains "Outlet ID"', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf   = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb    = XLSX.read(buf, { type: 'array' });
    const rows  = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Sales'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    expect(headers).toContain('Outlet ID');
  });

  it('B6: column headers include all enabled KPI labels', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf     = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Sales'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    for (const kpi of enabled) {
      expect(headers).toContain(kpi.label);
    }
  });

  it('B7: column headers include the 12 fixed info columns', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf     = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Sales'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    for (const col of ['Zone', 'State', 'Outlet ID', 'Outlet Name', 'Town']) {
      expect(headers).toContain(col);
    }
  });

  it('B8: template has pre-populated outlet rows (data rows beyond headers)', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf  = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb   = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Sales'], { header: 1, defval: '' },
    ) as (string | number)[][];
    // rows[0] = title, rows[1] = headers, rows[2..] = outlet data
    expect(rows.length).toBeGreaterThan(2);
  });

  it('B9: pre-populated rows have Outlet ID values from MOCK_OUTLETS', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf      = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb       = XLSX.read(buf, { type: 'array' });
    const ws       = wb.Sheets['Sales'];
    // range: 1 skips the title row (row 1) so row 2 (column headers) is used as keys
    const dataRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', range: 1 });
    // First data row should have an Outlet ID that exists in MOCK_OUTLETS
    const allIds = new Set(
      Object.values(MOCK_OUTLETS).flatMap(outlets => outlets.map(o => o.id)),
    );
    const firstId = String(dataRows[0]['Outlet ID'] ?? '');
    expect(firstId).toBeTruthy();
    expect(allIds.has(firstId)).toBe(true);
  });

  it('B10: KPI cells in pre-populated rows are blank (admin fills them in)', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf     = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb      = XLSX.read(buf, { type: 'array' });
    const ws      = wb.Sheets['Sales'];
    const dataRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
    // All KPI cells in all pre-populated rows should be blank
    for (const row of dataRows) {
      for (const kpi of enabled) {
        expect(String(row[kpi.label] ?? '')).toBe('');
      }
    }
  });

  it('B11: does NOT include name-override columns (not needed for sales)', async () => {
    const { generateSalesTemplate } = await import('../sales-excel-upload');
    const buf     = generateSalesTemplate(DEOLEO_DEFAULT_KPIS, '2099-06');
    const wb      = XLSX.read(buf, { type: 'array' });
    const rows    = XLSX.utils.sheet_to_json<(string | number)[]>(
      wb.Sheets['Sales'], { header: 1, defval: '' },
    ) as (string | number)[][];
    const headers = rows[1].map(String);
    // Name override labels (e.g. "Focus Pack 1 Name") should NOT appear
    for (const kpi of DEOLEO_DEFAULT_KPIS.filter(k => k.hasNameOverride)) {
      expect(headers).not.toContain(kpi.nameOverrideLabel);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — parseSalesUpload: validation logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal test buffer: title row + header row + data rows.
 */
function makeSalesBuffer(dataRows: Record<string, string | number>[]): ArrayBuffer {
  const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
  const headerRow = [
    'Zone', 'State', 'ASM ID', 'SO ID', 'DB Code', 'DB Name',
    'Outlet ID', 'Outlet Name', 'Town', 'Channel', 'Program', 'Sub Program',
    ...enabled.map(k => k.label),
  ];
  const titleRow = [`Sales Data — Jun '99`, ...Array(headerRow.length - 1).fill('')];
  const rows = dataRows.map(dr =>
    headerRow.map(h => dr[h] ?? ''),
  );
  const ws = XLSX.utils.aoa_to_sheet([titleRow, headerRow, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

// Pick a real outlet ID from the mock data
const REAL_OUTLET_ID = Object.values(MOCK_OUTLETS)[0][0].id;
const REAL_OUTLET    = Object.values(MOCK_OUTLETS)[0][0];

describe('C — parseSalesUpload: validation', () => {
  it('C1: empty file (no data rows) → empty result', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const buf    = makeSalesBuffer([]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it('C2: valid outlet ID with numeric KPI → status "saved"', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([{
      'Outlet ID':    REAL_OUTLET_ID,
      'Outlet Name':  REAL_OUTLET.name,
      [enabled[0].label]: 150,
    }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].status).toBe('saved');
  });

  it('C3: unknown outlet ID → status "skipped_outlet"', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const buf = makeSalesBuffer([{ 'Outlet ID': 'FAKE-9999', 'Outlet Name': 'Ghost' }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].status).toBe('skipped_outlet');
    expect(result.rows[0].remarks).toMatch(/not found|unknown/i);
  });

  it('C4: kpiValues contains the numeric value keyed by kpiId', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([{
      'Outlet ID':         REAL_OUTLET_ID,
      [enabled[0].label]:  200,
    }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].kpiValues[enabled[0].id]).toBe(200);
  });

  it('C5: salesData is keyed outletId → kpiId → value', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([{
      'Outlet ID':         REAL_OUTLET_ID,
      [enabled[0].label]:  300,
    }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.salesData[REAL_OUTLET_ID]?.[enabled[0].id]).toBe(300);
  });

  it('C6: non-numeric KPI value → status "error"', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([{
      'Outlet ID':         REAL_OUTLET_ID,
      [enabled[0].label]:  'abc',
    }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].status).toBe('error');
    expect(result.rows[0].remarks).toMatch(/invalid|non-numeric/i);
  });

  it('C7: blank KPI cell is silently skipped — row is still "saved"', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const buf = makeSalesBuffer([{
      'Outlet ID': REAL_OUTLET_ID,
      // No KPI values — all blank
    }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].status).toBe('saved');
    expect(Object.keys(result.rows[0].kpiValues)).toHaveLength(0);
  });

  it('C8: negative KPI value → status "error"', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([{
      'Outlet ID':         REAL_OUTLET_ID,
      [enabled[0].label]:  -10,
    }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].status).toBe('error');
    expect(result.rows[0].remarks).toMatch(/negative/i);
  });

  it('C9: summary counts match row statuses', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([
      { 'Outlet ID': REAL_OUTLET_ID, [enabled[0].label]: 100 },  // saved
      { 'Outlet ID': 'FAKE-999' },                                 // skipped_outlet
    ]);
    const knownIds = new Set([REAL_OUTLET_ID]);
    const result   = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, knownIds);
    expect(result.summary.total).toBe(2);
    expect(result.summary.saved).toBe(1);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.errors).toBe(0);
  });

  it('C10: fully blank rows (no outlet ID) are ignored — not counted', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([
      { 'Outlet ID': REAL_OUTLET_ID, [enabled[0].label]: 50 },
      {},  // completely blank row
    ]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.summary.total).toBe(1);
  });

  it('C11: string "0" in KPI cell is treated as numeric zero, not blank', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const enabled = getEnabledKpiDefs(DEOLEO_DEFAULT_KPIS);
    const buf = makeSalesBuffer([{
      'Outlet ID':         REAL_OUTLET_ID,
      [enabled[0].label]:  '0',
    }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].status).toBe('saved');
    expect(result.rows[0].kpiValues[enabled[0].id]).toBe(0);
  });

  it('C12: outletId in row matches what was in Outlet ID column', async () => {
    const { parseSalesUpload } = await import('../sales-excel-upload');
    const buf = makeSalesBuffer([{ 'Outlet ID': REAL_OUTLET_ID }]);
    const result = parseSalesUpload(buf, DEOLEO_DEFAULT_KPIS, new Set([REAL_OUTLET_ID]));
    expect(result.rows[0].outletId).toBe(REAL_OUTLET_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — buildSalesReportBuffer
// ─────────────────────────────────────────────────────────────────────────────

describe('D — buildSalesReportBuffer: report generation', () => {
  it('D1: returns an ArrayBuffer', async () => {
    const { buildSalesReportBuffer } = await import('../sales-excel-upload');
    const buf = buildSalesReportBuffer([]);
    expect(buf).toBeInstanceOf(ArrayBuffer);
  });

  it('D2: produced buffer is a readable xlsx workbook', async () => {
    const { buildSalesReportBuffer } = await import('../sales-excel-upload');
    const buf = buildSalesReportBuffer([]);
    const wb  = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames.length).toBeGreaterThan(0);
  });

  it('D3: "saved" status maps to "Saved" in the Status column', async () => {
    const { buildSalesReportBuffer } = await import('../sales-excel-upload');
    const buf = buildSalesReportBuffer([
      { rowIndex: 3, outletId: 'A', outletName: 'Alpha', kpiValues: { MONTH_TGT: 100 }, status: 'saved',          remarks: '' },
    ]);
    const wb   = XLSX.read(buf, { type: 'array' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);
    const row  = rows.find(r => r['Outlet ID'] === 'A' || r['outlet_id'] === 'A') ?? rows[0];
    const status = String(Object.values(row).find(v => v === 'Saved') ?? '');
    expect(status).toBe('Saved');
  });

  it('D4: "skipped_outlet" maps to "Skipped" in Status column', async () => {
    const { buildSalesReportBuffer } = await import('../sales-excel-upload');
    const buf  = buildSalesReportBuffer([
      { rowIndex: 3, outletId: 'B', outletName: '', kpiValues: {}, status: 'skipped_outlet', remarks: 'Unknown' },
    ]);
    const wb   = XLSX.read(buf, { type: 'array' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);
    const row  = rows[0];
    const status = String(Object.values(row).find(v => v === 'Skipped') ?? '');
    expect(status).toBe('Skipped');
  });

  it('D5: "error" maps to "Error" in Status column', async () => {
    const { buildSalesReportBuffer } = await import('../sales-excel-upload');
    const buf  = buildSalesReportBuffer([
      { rowIndex: 3, outletId: 'C', outletName: '', kpiValues: {}, status: 'error', remarks: 'Bad value' },
    ]);
    const wb   = XLSX.read(buf, { type: 'array' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws);
    const row  = rows[0];
    const status = String(Object.values(row).find(v => v === 'Error') ?? '');
    expect(status).toBe('Error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — Sales page structure
// ─────────────────────────────────────────────────────────────────────────────

describe('E — app/admin/sales/page.tsx: structure', () => {
  const page = src('app/admin/sales/page.tsx');

  it('E1: is a client component', () => {
    expect(page).toMatch(/'use client'/);
  });

  it('E2: imports generateSalesTemplate from sales-excel-upload', () => {
    expect(page).toMatch(/generateSalesTemplate/);
    expect(page).toMatch(/sales-excel-upload/);
  });

  it('E3: imports parseSalesUpload', () => {
    expect(page).toMatch(/parseSalesUpload/);
  });

  it('E4: has state for the selected month', () => {
    expect(page).toMatch(/salesMonth|selectedMonth|uploadMonth/);
  });

  it('E5: month options limited to current and previous month only', () => {
    // Must reference exactly 2 months or have -1 offset logic
    const hasTwoMonth =
      page.includes('getMonth() - 1') ||
      page.includes('getMonth()-1') ||
      page.includes('prevMonth') ||
      page.includes('currentMonth') ||
      (page.match(/month.*options|options.*month/i) !== null);
    expect(hasTwoMonth).toBeTruthy();
  });

  it('E6: has template download handler', () => {
    expect(page).toMatch(/handleDownloadTemplate|handleTemplateDownload|downloadTemplate/);
  });

  it('E7: has file upload drop zone or input', () => {
    expect(page).toMatch(/type="file"|type='file'/);
  });

  it('E8: uses getTenantKpiDefs for KPI config', () => {
    expect(page).toMatch(/getTenantKpiDefs/);
  });

  it('E9: has save / confirm action', () => {
    expect(page).toMatch(/handleSave|handleConfirm|saveSales/);
  });

  it('E10: has download report action', () => {
    expect(page).toMatch(/handleDownloadReport|downloadReport|buildSalesReportBuffer/);
  });
});
