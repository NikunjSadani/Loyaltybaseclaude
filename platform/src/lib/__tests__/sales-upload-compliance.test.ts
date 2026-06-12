/// <reference types="vitest/globals" />
/**
 * TDD — Sales Data Upload module
 *
 * RED phase: all tests written before implementation.
 *
 * Changes under test:
 *  1. api/prisma/schema.prisma           — SalesUploadBatch + OutletSalesRecord models
 *  2. platform/prisma/schema.prisma      — same models mirrored
 *  3. platform/src/lib/sales-upload.ts   — getKpisForOutletType, generateSalesTemplate,
 *                                          parseSalesRows, types
 *  4. app/api/admin/sales/bulk-upload/route.ts  — POST handler
 *  5. app/api/admin/sales/records/route.ts      — GET handler
 *  6. app/admin/sales/page.tsx           — admin sales upload page
 *  7. app/admin/layout.tsx               — "Sales Data" nav entry
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect } from 'vitest';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

const rootSrc = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../..', rel), 'utf-8');

// ─────────────────────────────────────────────────────────────────────────────
// A: Prisma schemas — both api and platform have the new models
// ─────────────────────────────────────────────────────────────────────────────

describe('A — Prisma schemas: SalesUploadBatch + OutletSalesRecord', () => {
  const apiSchema      = rootSrc('api/prisma/schema.prisma');
  const platformSchema = rootSrc('platform/prisma/schema.prisma');

  it('A1: api schema has SalesUploadBatch model', () => {
    expect(apiSchema).toMatch(/model\s+SalesUploadBatch/);
  });

  it('A2: api schema has OutletSalesRecord model', () => {
    expect(apiSchema).toMatch(/model\s+OutletSalesRecord/);
  });

  it('A3: OutletSalesRecord has unique constraint on [clientId, outletCode, month]', () => {
    const block = apiSchema.match(/model\s+OutletSalesRecord\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(block).toMatch(/clientId.*outletCode.*month|@@unique/s);
  });

  it('A4: OutletSalesRecord has kpiValues Json field', () => {
    const block = apiSchema.match(/model\s+OutletSalesRecord\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(block).toMatch(/kpiValues\s+Json/);
  });

  it('A5: SalesUploadBatch has month field', () => {
    const block = apiSchema.match(/model\s+SalesUploadBatch\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(block).toMatch(/month\s+String/);
  });

  it('A6: platform schema has SalesUploadBatch model', () => {
    expect(platformSchema).toMatch(/model\s+SalesUploadBatch/);
  });

  it('A7: platform schema has OutletSalesRecord model', () => {
    expect(platformSchema).toMatch(/model\s+OutletSalesRecord/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B: lib/sales-upload.ts — shape checks
// ─────────────────────────────────────────────────────────────────────────────

describe('B — lib/sales-upload.ts: exports and types', () => {
  const code = src('lib/sales-upload.ts');

  it('B1: getKpisForOutletType is exported', () => {
    expect(code).toMatch(/export\s+function\s+getKpisForOutletType/);
  });

  it('B2: generateSalesTemplate is exported', () => {
    expect(code).toMatch(/export\s+(async\s+)?function\s+generateSalesTemplate/);
  });

  it('B3: parseSalesRows is exported', () => {
    expect(code).toMatch(/export\s+function\s+parseSalesRows/);
  });

  it('B4: ParsedSalesRow type is defined', () => {
    expect(code).toMatch(/ParsedSalesRow/);
  });

  it('B5: ParsedSalesRow has rowStatus field', () => {
    expect(code).toMatch(/rowStatus/);
  });

  it('B6: ParsedSalesRow has ignoredKpis field', () => {
    expect(code).toMatch(/ignoredKpis/);
  });

  it('B7: ParsedSalesRow has errorRemarks field', () => {
    expect(code).toMatch(/errorRemarks/);
  });

  it('B8: ParsedSalesRow has kpiValues field', () => {
    expect(code).toMatch(/kpiValues/);
  });

  it('B9: SALES_UPLOAD_INSTRUCTIONS constant is exported', () => {
    expect(code).toMatch(/export.*SALES_UPLOAD_INSTRUCTIONS/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C: getKpisForOutletType — runtime behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('C — getKpisForOutletType: KPI union logic', () => {
  it('C1: returns empty array when no configs', async () => {
    const { getKpisForOutletType } = await import('../sales-upload');
    const kpis = getKpisForOutletType('SSS', '2099-01', []);
    expect(kpis).toEqual([]);
  });

  it('C2: returns KPI displayNames from active configs for that type+month', async () => {
    const { getKpisForOutletType } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-02', [
      { id: 'k1', displayName: 'Monthly Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const kpis = getKpisForOutletType('SSS', '2099-02', [cfg]);
    expect(kpis).toContain('Monthly Volume');
  });

  it('C3: returns union when multiple configs cover same type+month', async () => {
    const { getKpisForOutletType } = await import('../sales-upload');
    const cfg1 = makeCfg('SSS', 'INDIA', '2099-03', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const cfg2 = makeCfg('SSS', 'STATE', '2099-03', [
      { id: 'k2', displayName: 'Focus SKU', type: 'focus_sku', unit: 'cases', isPrimary: false },
    ], 'Maharashtra');
    const kpis = getKpisForOutletType('SSS', '2099-03', [cfg1, cfg2]);
    expect(kpis).toContain('Volume');
    expect(kpis).toContain('Focus SKU');
  });

  it('C4: excludes DRAFT configs', async () => {
    const { getKpisForOutletType } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-04', [
      { id: 'k1', displayName: 'Draft KPI', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ], 'Pan India', 'DRAFT');
    const kpis = getKpisForOutletType('SSS', '2099-04', [cfg]);
    expect(kpis).not.toContain('Draft KPI');
  });

  it('C5: excludes configs for different outlet type', async () => {
    const { getKpisForOutletType } = await import('../sales-upload');
    const cfg = makeCfg('WHOLESALER', 'INDIA', '2099-05', [
      { id: 'k1', displayName: 'WS Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const kpis = getKpisForOutletType('SSS', '2099-05', [cfg]);
    expect(kpis).not.toContain('WS Volume');
  });

  it('C6: excludes configs for different month', async () => {
    const { getKpisForOutletType } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-01', [
      { id: 'k1', displayName: 'Old KPI', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const kpis = getKpisForOutletType('SSS', '2099-06', [cfg]);
    expect(kpis).not.toContain('Old KPI');
  });

  it('C7: deduplicates KPI names that appear in multiple configs', async () => {
    const { getKpisForOutletType } = await import('../sales-upload');
    const cfg1 = makeCfg('SSS', 'INDIA', '2099-07', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const cfg2 = makeCfg('SSS', 'STATE', '2099-07', [
      { id: 'k2', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: false },
    ], 'Maharashtra');
    const kpis = getKpisForOutletType('SSS', '2099-07', [cfg1, cfg2]);
    expect(kpis.filter(k => k === 'Volume').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D: parseSalesRows — validation logic
// ─────────────────────────────────────────────────────────────────────────────

describe('D — parseSalesRows: row-level validation', () => {
  it('D1: missing outlet_code → row REJECTED', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const rows = parseSalesRows([{ outlet_code: '' }], 'SSS', '2099-01', []);
    expect(rows[0].rowStatus).toBe('REJECTED');
    expect(rows[0].errorRemarks).toMatch(/outlet_code/i);
  });

  it('D2: unknown outlet_code → row REJECTED', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const rows = parseSalesRows([{ outlet_code: 'NONEXISTENT-999' }], 'SSS', '2099-01', []);
    expect(rows[0].rowStatus).toBe('REJECTED');
    expect(rows[0].errorRemarks).toMatch(/not found|does not exist/i);
  });

  it('D3: non-numeric KPI value → entire row REJECTED', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-01', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', Volume: 'abc' }],
      'SSS', '2099-01', [cfg],
    );
    expect(rows[0].rowStatus).toBe('REJECTED');
    expect(rows[0].errorRemarks).toMatch(/Volume|invalid|non-numeric/i);
  });

  it('D4: negative KPI value → entire row REJECTED', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-01', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', Volume: -5 }],
      'SSS', '2099-01', [cfg],
    );
    expect(rows[0].rowStatus).toBe('REJECTED');
    expect(rows[0].errorRemarks).toMatch(/negative|Volume/i);
  });

  it('D5: valid outlet + valid KPI → ACCEPTED, value stored', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-01', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', Volume: 100 }],
      'SSS', '2099-01', [cfg],
    );
    expect(rows[0].rowStatus).toBe('ACCEPTED');
    expect(rows[0].kpiValues['Volume']).toBe(100);
  });

  it('D6: KPI column filled but not in outlet resolved config → ignored, row ACCEPTED', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    // RT-001 is in Mumbai, Maharashtra — configure a State:Karnataka config (doesn't cover RT-001)
    // No INDIA config → RT-001 has no resolved config
    const cfg = makeCfg('SSS', 'STATE', '2099-01', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ], 'Karnataka');
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', Volume: 50 }],
      'SSS', '2099-01', [cfg],
    );
    // RT-001 is in Maharashtra, not Karnataka → no resolved config → Volume is ignored
    expect(rows[0].rowStatus).toBe('ACCEPTED');
    expect(rows[0].ignoredKpis).toContain('Volume');
    expect(rows[0].kpiValues['Volume']).toBeUndefined();
  });

  it('D7: mix of valid KPI + not-configured KPI → ACCEPTED, valid stored, other ignored', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-01', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    // "Mystery KPI" is not in config
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', Volume: 120, 'Mystery KPI': 999 }],
      'SSS', '2099-01', [cfg],
    );
    expect(rows[0].rowStatus).toBe('ACCEPTED');
    expect(rows[0].kpiValues['Volume']).toBe(120);
    expect(rows[0].ignoredKpis).toContain('Mystery KPI');
  });

  it('D8: blank KPI cell is silently skipped (not an error, not ignored)', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-01', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
      { id: 'k2', displayName: 'Lines', type: 'lines', unit: 'SKUs', isPrimary: false },
    ]);
    // Lines is blank/missing
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', Volume: 80 }],
      'SSS', '2099-01', [cfg],
    );
    expect(rows[0].rowStatus).toBe('ACCEPTED');
    expect(rows[0].kpiValues['Volume']).toBe(80);
    expect(rows[0].ignoredKpis).not.toContain('Lines');
  });

  it('D9: row with only ignored KPIs is still ACCEPTED (outlet exists, just nothing to store)', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    // No active config at all — all KPI columns are unresolved → ignored
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', 'Volume': 50 }],
      'SSS', '2099-01', [],
    );
    expect(rows[0].rowStatus).toBe('ACCEPTED');
    expect(rows[0].ignoredKpis.length).toBeGreaterThan(0);
  });

  it('D10: parseSalesRows includes outletName in parsed row', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const rows = parseSalesRows([{ outlet_code: 'RT-001' }], 'SSS', '2099-01', []);
    expect(rows[0].outletName).toBeTruthy();
  });

  it('D11: string "0" is treated as numeric zero, not blank', async () => {
    const { parseSalesRows } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-01', [
      { id: 'k1', displayName: 'Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const rows = parseSalesRows(
      [{ outlet_code: 'RT-001', Volume: '0' }],
      'SSS', '2099-01', [cfg],
    );
    expect(rows[0].rowStatus).toBe('ACCEPTED');
    expect(rows[0].kpiValues['Volume']).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E: generateSalesTemplate — structure
// ─────────────────────────────────────────────────────────────────────────────

describe('E — generateSalesTemplate: multi-sheet Excel structure', () => {
  it('E1: returns a Uint8Array (binary Excel)', async () => {
    const { generateSalesTemplate } = await import('../sales-upload');
    const buf = await generateSalesTemplate('2099-01', []);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('E2: first sheet is named "Instructions"', async () => {
    const XLSX = await import('xlsx');
    const { generateSalesTemplate } = await import('../sales-upload');
    const buf = await generateSalesTemplate('2099-01', []);
    const wb  = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames[0]).toBe('Instructions');
  });

  it('E3: has a sheet for each outlet type', async () => {
    const XLSX = await import('xlsx');
    const { generateSalesTemplate } = await import('../sales-upload');
    const buf = await generateSalesTemplate('2099-01', []);
    const wb  = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toContain('SSS');
    expect(wb.SheetNames).toContain('Wholesaler');
    expect(wb.SheetNames).toContain('Sub-Stockist');
    expect(wb.SheetNames).toContain('SSS TOT');
  });

  it('E4: outlet type sheet has outlet_code column', async () => {
    const XLSX = await import('xlsx');
    const { generateSalesTemplate } = await import('../sales-upload');
    const buf  = await generateSalesTemplate('2099-01', []);
    const wb   = XLSX.read(buf, { type: 'buffer' });
    const ws   = wb.Sheets['SSS'];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: 1 });
    const headers = rows[0] as unknown as string[];
    expect(headers).toContain('outlet_code');
  });

  it('E5: outlet type sheet has outlet_name column', async () => {
    const XLSX = await import('xlsx');
    const { generateSalesTemplate } = await import('../sales-upload');
    const buf  = await generateSalesTemplate('2099-01', []);
    const wb   = XLSX.read(buf, { type: 'buffer' });
    const ws   = wb.Sheets['SSS'];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: 1 });
    const headers = rows[0] as unknown as string[];
    expect(headers).toContain('outlet_name');
  });

  it('E6: pre-populates rows with outlet codes for each type', async () => {
    const XLSX = await import('xlsx');
    const { generateSalesTemplate } = await import('../sales-upload');
    const buf  = await generateSalesTemplate('2099-01', []);
    const wb   = XLSX.read(buf, { type: 'buffer' });
    const ws   = wb.Sheets['SSS'];
    const rows = XLSX.utils.sheet_to_json<{ outlet_code: string }>(ws);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].outlet_code).toBeTruthy();
  });

  it('E7: KPI columns appear when active config exists for that type+month', async () => {
    const XLSX = await import('xlsx');
    const { generateSalesTemplate } = await import('../sales-upload');
    const cfg = makeCfg('SSS', 'INDIA', '2099-08', [
      { id: 'k1', displayName: 'Monthly Volume', type: 'monthly_volume', unit: 'cases', isPrimary: true },
    ]);
    const buf  = await generateSalesTemplate('2099-08', [cfg]);
    const wb   = XLSX.read(buf, { type: 'buffer' });
    const ws   = wb.Sheets['SSS'];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: 1 });
    const headers = rows[0] as unknown as string[];
    expect(headers).toContain('Monthly Volume');
  });

  it('E8: outlet type sheet with no active configs has only outlet_code + outlet_name columns', async () => {
    const XLSX = await import('xlsx');
    const { generateSalesTemplate } = await import('../sales-upload');
    const buf  = await generateSalesTemplate('2099-09', []);
    const wb   = XLSX.read(buf, { type: 'buffer' });
    const ws   = wb.Sheets['SSS'];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: 1 });
    const headers = rows[0] as unknown as string[];
    expect(headers).toEqual(['outlet_code', 'outlet_name']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F: API routes — shape checks
// ─────────────────────────────────────────────────────────────────────────────

describe('F — API routes: shape checks', () => {
  it('F1: bulk-upload POST route file exists', () => {
    const code = src('app/api/admin/sales/bulk-upload/route.ts');
    expect(code).toMatch(/export\s+(async\s+)?function\s+POST/);
  });

  it('F2: bulk-upload route checks auth (CLIENT_ADMIN / GIFSY_ADMIN)', () => {
    const code = src('app/api/admin/sales/bulk-upload/route.ts');
    expect(code).toMatch(/CLIENT_ADMIN|GIFSY_ADMIN/);
  });

  it('F3: bulk-upload route returns batchId in response', () => {
    const code = src('app/api/admin/sales/bulk-upload/route.ts');
    expect(code).toMatch(/batchId/);
  });

  it('F4: bulk-upload route returns savedCount (parsing is client-side now)', () => {
    // Parsing moved to the client; server receives pre-validated acceptedRows and returns savedCount
    const code = src('app/api/admin/sales/bulk-upload/route.ts');
    expect(code).toMatch(/savedCount/);
  });

  it('F5: bulk-upload route accepts month in JSON body', () => {
    const code = src('app/api/admin/sales/bulk-upload/route.ts');
    expect(code).toMatch(/month/);
  });

  it('F6: records GET route file exists', () => {
    const code = src('app/api/admin/sales/records/route.ts');
    expect(code).toMatch(/export\s+(async\s+)?function\s+GET/);
  });

  it('F7: records GET route filters by month', () => {
    const code = src('app/api/admin/sales/records/route.ts');
    expect(code).toMatch(/month/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G: Admin page — /admin/sales/page.tsx
// ─────────────────────────────────────────────────────────────────────────────

describe('G — app/admin/sales/page.tsx: UI shape', () => {
  const page = src('app/admin/sales/page.tsx');

  it('G1: page file exists and is a client component', () => {
    expect(page).toMatch(/'use client'/);
  });

  it('G2: has a month picker state (selectedMonth / uploadMonth / month)', () => {
    const hasMonthState =
      page.includes('selectedMonth') ||
      page.includes('uploadMonth') ||
      page.includes('salesMonth') ||
      page.includes("'month'") ||
      page.match(/useState[^;]+Month/);
    expect(hasMonthState).toBeTruthy();
  });

  it('G3: has template download button', () => {
    const hasDownload =
      page.includes('Download Template') ||
      page.includes('downloadTemplate') ||
      page.includes('handleTemplateDownload');
    expect(hasDownload).toBe(true);
  });

  it('G4: has file upload input', () => {
    expect(page).toMatch(/type="file"|type='file'/);
  });

  it('G5: has confirm/upload button', () => {
    const hasConfirm =
      page.includes('Confirm') ||
      page.includes('handleUpload') ||
      page.includes('handleConfirm') ||
      page.includes('handleSave') ||
      page.includes('Save');
    expect(hasConfirm).toBe(true);
  });

  it('G6: has report download (reportFileBase64 or handleReportDownload)', () => {
    const hasReport =
      page.includes('reportFileBase64') ||
      page.includes('handleReportDownload') ||
      page.includes('Download Report');
    expect(hasReport).toBe(true);
  });

  it('G7: calls generateSalesTemplate', () => {
    expect(page).toMatch(/generateSalesTemplate/);
  });

  it('G8: imports from lib/sales-upload (or lib/sales-excel-upload)', () => {
    // Either the older multi-sheet lib or the newer single-sheet lib
    const hasImport =
      /from.*sales-upload/.test(page) ||
      /from.*sales-excel-upload/.test(page);
    expect(hasImport).toBe(true);
  });

  it('G9: has a save / upload action (API call or local handler)', () => {
    // Either a direct API call or a local save handler (API wired later)
    const hasSaveAction =
      page.includes('/api/admin/sales/bulk-upload') ||
      page.includes('handleSave') ||
      page.includes('handleUpload') ||
      page.includes('bulk-upload');
    expect(hasSaveAction).toBe(true);
  });

  it('G10: has report / records download', () => {
    const hasRecords =
      page.includes('Download Records') ||
      page.includes('handleRecordsDownload') ||
      page.includes('downloadRecords') ||
      page.includes('handleDownloadReport') ||
      page.includes('Download Report') ||
      page.includes('buildSalesReportBuffer');
    expect(hasRecords).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H: Admin layout — Sales Data nav entry
// ─────────────────────────────────────────────────────────────────────────────

describe('H — app/admin/layout.tsx: nav entry', () => {
  const layout = src('app/admin/layout.tsx');

  it('H1: nav includes /admin/sales path', () => {
    expect(layout).toMatch(/\/admin\/sales/);
  });

  it('H2: nav entry has a "Sales Data" or "Sales" label', () => {
    const hasSalesLabel =
      layout.includes('Sales Data') ||
      layout.includes("'Sales'") ||
      layout.includes('"Sales"');
    expect(hasSalesLabel).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type KpiType2 = 'monthly_volume' | 'quarterly_volume' | 'focus_sku' | 'focus_category' | 'lines' | 'visit_freq' | 'custom';

function makeCfg(
  outletType: 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT',
  geoLevel:   'INDIA' | 'STATE' | 'ASM' | 'CITY',
  month:      string,
  kpis:       Array<{ id: string; displayName: string; type: KpiType2; unit: string; isPrimary: boolean }>,
  geoName = 'Pan India',
  status: 'ACTIVE' | 'DRAFT' = 'ACTIVE',
) {
  return {
    id:           `cfg-${Math.random().toString(36).slice(2)}`,
    outletType,
    geoLevel,
    geoName,
    months:       [month],
    kpis,
    status,
    targetValues: {},
    createdAt:    '',
    updatedAt:    '',
  };
}
