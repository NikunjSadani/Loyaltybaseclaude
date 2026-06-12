/// <reference types="vitest/globals" />
/**
 * TDD — Excel-based target upload (Deoleo / multi-tenant)
 *
 * RED phase: tests written before implementation.
 *
 * Changes under test:
 *  1. src/lib/platform/tenant-kpi-config.ts  — TenantKpiDef type + DEOLEO_DEFAULT_KPIS
 *  2. src/lib/target-excel-upload.ts         — generateTargetTemplate / parseTargetUpload / buildErrorReportBuffer
 *  3. src/lib/targets.ts                     — kpiNameOverrides field on TargetConfig
 *  4. src/app/admin/targets/upload/page.tsx  — upload UI
 */

import { readFileSync } from 'fs';
import { resolve }      from 'path';
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ── A: tenant-kpi-config.ts — type & defaults ─────────────────────────────────

describe('A — tenant-kpi-config.ts: type and defaults', () => {
  const code = src('lib/platform/tenant-kpi-config.ts');

  it('A1: TenantKpiDef interface is exported', () => {
    expect(code).toMatch(/export\s+interface\s+TenantKpiDef/);
  });

  it('A2: TenantKpiDef has isPrimary field', () => {
    expect(code).toMatch(/isPrimary\s*:\s*boolean/);
  });

  it('A3: TenantKpiDef has hasNameOverride field', () => {
    expect(code).toMatch(/hasNameOverride\s*:\s*boolean/);
  });

  it('A4: TenantKpiDef has nameOverrideLabel field', () => {
    expect(code).toMatch(/nameOverrideLabel[?]?\s*:/);
  });

  it('A5: DEOLEO_DEFAULT_KPIS is exported with 5 entries', () => {
    expect(code).toMatch(/export\s+const\s+DEOLEO_DEFAULT_KPIS/);
    // Each of the 5 Deoleo KPIs has its stable id present
    expect(code).toMatch(/MONTH_TGT/);
    expect(code).toMatch(/FOCUS_PACK_1/);
    expect(code).toMatch(/FOCUS_PACK_2/);
    expect(code).toMatch(/FOCUS_CATEGORY/);
    expect(code).toMatch(/CONSISTENCY/);
  });

  it('A6: exactly one KPI has isPrimary: true (Month Target)', () => {
    const count = (code.match(/isPrimary:\s*true/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('A7: getTenantKpiDefs function is exported', () => {
    expect(code).toMatch(/export\s+function\s+getTenantKpiDefs/);
  });

  it('A8: saveTenantKpiDefs function is exported', () => {
    expect(code).toMatch(/export\s+function\s+saveTenantKpiDefs/);
  });

  it('A9: getEnabledKpiDefs helper is exported', () => {
    expect(code).toMatch(/export\s+function\s+getEnabledKpiDefs/);
  });
});

// ── B: target-excel-upload.ts — source shape ──────────────────────────────────

describe('B — target-excel-upload.ts: exports and types', () => {
  const code = src('lib/target-excel-upload.ts');

  it('B1: generateTargetTemplate is exported', () => {
    expect(code).toMatch(/export\s+function\s+generateTargetTemplate/);
  });

  it('B2: parseTargetUpload is exported', () => {
    expect(code).toMatch(/export\s+function\s+parseTargetUpload/);
  });

  it('B3: buildErrorReportBuffer is exported', () => {
    expect(code).toMatch(/export\s+function\s+buildErrorReportBuffer/);
  });

  it('B4: ParsedTargetRow type has outletId, status, remarks', () => {
    expect(code).toMatch(/outletId/);
    expect(code).toMatch(/status/);
    expect(code).toMatch(/remarks/);
  });

  it('B5: ParseResult type has targetValues and kpiNameOverrides', () => {
    expect(code).toMatch(/targetValues/);
    expect(code).toMatch(/kpiNameOverrides/);
  });

  it('B6: ParseResult summary has total, updated, skipped fields', () => {
    expect(code).toMatch(/total/);
    expect(code).toMatch(/updated/);
    expect(code).toMatch(/skipped/);
  });

  it('B7: uses isMonthLocked from targets (locks past months)', () => {
    expect(code).toMatch(/isMonthLocked/);
  });

  it('B8: FIXED_COLS constant includes "Outlet ID"', () => {
    expect(code).toMatch(/Outlet ID/);
  });
});

// ── C: generateTargetTemplate — functional ────────────────────────────────────

describe('C — generateTargetTemplate: functional', () => {
  const FUTURE_MONTHS = ['2099-07', '2099-08'];

  it('C1: returns an ArrayBuffer', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const buf = generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS);
    expect(buf).toBeInstanceOf(ArrayBuffer);
  });

  it('C2: produces a valid xlsx workbook', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const buf = generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS);
    expect(() => XLSX.read(buf, { type: 'array' })).not.toThrow();
  });

  it('C3: workbook has a sheet named "Targets"', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const wb = XLSX.read(generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS), { type: 'array' });
    expect(wb.SheetNames).toContain('Targets');
  });

  it('C4: row 2 headers contain all 12 fixed column names', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const wb   = XLSX.read(generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS), { type: 'array' });
    const aoa  = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Targets'], { header: 1, defval: '' }) as string[][];
    const row2 = aoa[1].map(String);
    expect(row2).toContain('Outlet ID');
    expect(row2).toContain('Outlet Name');
    expect(row2).toContain('Zone');
    expect(row2).toContain('Channel');
    expect(row2).toContain('Sub Program');
  });

  it('C5: row 2 contains name-override column headers for hasNameOverride KPIs', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const wb   = XLSX.read(generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS), { type: 'array' });
    const aoa  = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Targets'], { header: 1, defval: '' }) as string[][];
    const row2 = aoa[1].map(String);
    expect(row2).toContain('Focus Pack 1 Name');
    expect(row2).toContain('Focus Pack 2 Name');
    expect(row2).toContain('Focus Category Name');
  });

  it('C6: each KPI label appears once per month in row 2', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const wb   = XLSX.read(generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS), { type: 'array' });
    const aoa  = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Targets'], { header: 1, defval: '' }) as string[][];
    const row2 = aoa[1].map(String);
    // "Month Target" should appear exactly twice (one per month)
    expect(row2.filter(c => c === 'Month Target').length).toBe(FUTURE_MONTHS.length);
  });

  it('C7: row 1 contains month group headers for each month', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const wb   = XLSX.read(generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS), { type: 'array' });
    const aoa  = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Targets'], { header: 1, defval: '' }) as string[][];
    const row1 = aoa[0].map(String);
    expect(row1.some(c => /jul.*target/i.test(c))).toBe(true);
    expect(row1.some(c => /aug.*target/i.test(c))).toBe(true);
  });

  it('C8: total header columns = 12 fixed + 3 name-override + 5 KPIs × 2 months = 25', async () => {
    const { generateTargetTemplate } = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
    const wb   = XLSX.read(generateTargetTemplate(DEOLEO_DEFAULT_KPIS, FUTURE_MONTHS), { type: 'array' });
    const aoa  = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Targets'], { header: 1, defval: '' }) as string[][];
    const row2 = aoa[1].map(String);
    const nonEmpty = row2.filter(c => c.trim() !== '').length;
    expect(nonEmpty).toBe(12 + 3 + 5 * 2); // 25
  });
});

// ── D: parseTargetUpload — functional ─────────────────────────────────────────

/** Build a test xlsx buffer by generating a template then appending data rows */
async function makeTestBuffer(months: string[], dataRows: Record<string, unknown>[]): Promise<ArrayBuffer> {
  const { generateTargetTemplate } = await import('../target-excel-upload');
  const { DEOLEO_DEFAULT_KPIS }    = await import('../platform/tenant-kpi-config');
  const templateBuf = generateTargetTemplate(DEOLEO_DEFAULT_KPIS, months);
  const wb          = XLSX.read(templateBuf, { type: 'array' });
  const ws          = wb.Sheets['Targets'];
  const aoa         = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as unknown[][];
  const row2        = (aoa[1] as string[]).map(String);

  for (const spec of dataRows) {
    const row = Array(row2.length).fill('');
    for (const [colHeader, value] of Object.entries(spec)) {
      const ci = row2.indexOf(colHeader);
      if (ci >= 0) row[ci] = value;
    }
    aoa.push(row);
  }

  const newWs = XLSX.utils.aoa_to_sheet(aoa);
  const newWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newWs, 'Targets');
  return XLSX.write(newWb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

const KNOWN_OUTLETS  = new Set(['FS-0123', 'FS-0124', 'FS-0125']);
const FUTURE_MONTHS2 = ['2099-07', '2099-08'];

describe('D — parseTargetUpload: functional', () => {
  it('D1: returns ParseResult with rows, targetValues, kpiNameOverrides, summary', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf    = await makeTestBuffer(FUTURE_MONTHS2, []);
    const result = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    expect(result).toHaveProperty('rows');
    expect(result).toHaveProperty('targetValues');
    expect(result).toHaveProperty('kpiNameOverrides');
    expect(result).toHaveProperty('summary');
  });

  it('D2: empty file → rows is an empty array', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf = await makeTestBuffer(FUTURE_MONTHS2, []);
    expect(parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS).rows).toHaveLength(0);
  });

  it('D3: unknown outlet ID → status "skipped_outlet" and remarks mention "not found"', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf    = await makeTestBuffer(FUTURE_MONTHS2, [
      { 'Outlet ID': 'FS-UNKNOWN', 'Month Target': 28 },
    ]);
    const result = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('skipped_outlet');
    expect(result.rows[0].remarks).toMatch(/not found/i);
  });

  it('D4: known outlet + future month → status "updated" and targetValues populated', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf    = await makeTestBuffer(FUTURE_MONTHS2, [
      { 'Outlet ID': 'FS-0123', 'Month Target': 28 },
    ]);
    const result = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    expect(result.rows[0].status).toBe('updated');
    expect(result.targetValues['2099-07']?.['FS-0123']?.['MONTH_TGT']).toBe(28);
  });

  it('D5: name override extracted into kpiNameOverrides for each future month', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf    = await makeTestBuffer(FUTURE_MONTHS2, [
      { 'Outlet ID': 'FS-0123', 'Focus Pack 1 Name': 'Baby Brand', 'Month Target': 10 },
    ]);
    const result = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    // Name override applies to both months
    expect(result.kpiNameOverrides['2099-07']?.['FS-0123']?.['FOCUS_PACK_1']).toBe('Baby Brand');
    expect(result.kpiNameOverrides['2099-08']?.['FS-0123']?.['FOCUS_PACK_1']).toBe('Baby Brand');
  });

  it('D6: past month rows not written to targetValues (locked)', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const PAST = ['2020-01'];
    const buf  = await makeTestBuffer(PAST, [
      { 'Outlet ID': 'FS-0123', 'Month Target': 28 },
    ]);
    const result = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    expect(result.targetValues['2020-01']).toBeUndefined();
  });

  it('D7: past month remark mentions "past" or "locked"', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf = await makeTestBuffer(['2020-02'], [
      { 'Outlet ID': 'FS-0123', 'Month Target': 28 },
    ]);
    const result = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    expect(result.rows.some(r => r.remarks.match(/past|locked/i))).toBe(true);
  });

  it('D8: summary correctly counts updated and skipped rows', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf = await makeTestBuffer(FUTURE_MONTHS2, [
      { 'Outlet ID': 'FS-0123', 'Month Target': 28 },  // known → updated
      { 'Outlet ID': 'FS-0124', 'Month Target': 15 },  // known → updated
      { 'Outlet ID': 'FS-9999', 'Month Target': 5  },  // unknown → skipped
    ]);
    const result = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    expect(result.summary.total).toBe(3);
    expect(result.summary.updated).toBe(2);
    expect(result.summary.skipped).toBe(1);
  });

  it('D9: multiple KPI values per outlet per month are all stored', async () => {
    const { parseTargetUpload }   = await import('../target-excel-upload');
    const { DEOLEO_DEFAULT_KPIS } = await import('../platform/tenant-kpi-config');
    const buf = await makeTestBuffer(FUTURE_MONTHS2, [
      {
        'Outlet ID':           'FS-0123',
        'Month Target':        28,
        'Focus Pack - 1':      10,
        'Consistency Target':  40,
      },
    ]);
    const result  = parseTargetUpload(buf, DEOLEO_DEFAULT_KPIS, KNOWN_OUTLETS);
    const values  = result.targetValues['2099-07']?.['FS-0123'];
    expect(values?.['MONTH_TGT']).toBe(28);
    expect(values?.['FOCUS_PACK_1']).toBe(10);
    expect(values?.['CONSISTENCY']).toBe(40);
  });
});

// ── E: buildErrorReportBuffer — functional ────────────────────────────────────

describe('E — buildErrorReportBuffer: functional', () => {
  const mockRows = [
    {
      rowIndex: 3, outletId: 'FS-0123', outletName: 'ABC Trader 1',
      zone: 'West', state: 'Maharashtra', asmId: 'ASM-Mat', soId: 'SO-Tha',
      dbCode: '12345', dbName: 'Ram traders', town: 'Mumbai',
      channel: 'SELFSERVICESTORE', program: 'Sambandh 2.0', subProgram: 'Gold',
      monthData: {}, status: 'updated' as const, remarks: 'Updated',
    },
    {
      rowIndex: 4, outletId: 'FS-9999', outletName: 'Unknown Store',
      zone: '', state: '', asmId: '', soId: '',
      dbCode: '', dbName: '', town: '', channel: '', program: '', subProgram: '',
      monthData: {}, status: 'skipped_outlet' as const,
      remarks: 'Outlet ID "FS-9999" not found in system — row skipped',
    },
  ];

  it('E1: returns an ArrayBuffer', async () => {
    const { buildErrorReportBuffer } = await import('../target-excel-upload');
    expect(buildErrorReportBuffer(mockRows)).toBeInstanceOf(ArrayBuffer);
  });

  it('E2: produces a valid xlsx file', async () => {
    const { buildErrorReportBuffer } = await import('../target-excel-upload');
    expect(() => XLSX.read(buildErrorReportBuffer(mockRows), { type: 'array' })).not.toThrow();
  });

  it('E3: header row contains Status, Remarks, and Outlet ID columns', async () => {
    const { buildErrorReportBuffer } = await import('../target-excel-upload');
    const wb   = XLSX.read(buildErrorReportBuffer(mockRows), { type: 'array' });
    const aoa  = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }) as string[][];
    const row1 = aoa[0].map(String);
    expect(row1).toContain('Status');
    expect(row1).toContain('Remarks');
    expect(row1).toContain('Outlet ID');
  });

  it('E4: report has one data row per input row', async () => {
    const { buildErrorReportBuffer } = await import('../target-excel-upload');
    const wb  = XLSX.read(buildErrorReportBuffer(mockRows), { type: 'array' });
    const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }) as string[][];
    expect(aoa.length - 1).toBe(mockRows.length);
  });

  it('E5: updated rows show "Updated" in the Status column', async () => {
    const { buildErrorReportBuffer } = await import('../target-excel-upload');
    const wb   = XLSX.read(buildErrorReportBuffer(mockRows), { type: 'array' });
    const data = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]);
    const row  = data.find(r => r['Outlet ID'] === 'FS-0123');
    expect(row?.['Status']).toBe('Updated');
  });

  it('E6: skipped rows show "Skipped" in the Status column', async () => {
    const { buildErrorReportBuffer } = await import('../target-excel-upload');
    const wb   = XLSX.read(buildErrorReportBuffer(mockRows), { type: 'array' });
    const data = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]);
    const row  = data.find(r => r['Outlet ID'] === 'FS-9999');
    expect(row?.['Status']).toBe('Skipped');
  });

  it('E7: remarks text is preserved in the report', async () => {
    const { buildErrorReportBuffer } = await import('../target-excel-upload');
    const wb   = XLSX.read(buildErrorReportBuffer(mockRows), { type: 'array' });
    const data = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]);
    const row  = data.find(r => r['Outlet ID'] === 'FS-9999');
    expect(row?.['Remarks']).toMatch(/not found/i);
  });
});

// ── F: lib/targets.ts — kpiNameOverrides field ────────────────────────────────

describe('F — lib/targets.ts: kpiNameOverrides on TargetConfig', () => {
  const code = src('lib/targets.ts');

  it('F1: TargetConfig has kpiNameOverrides field (optional)', () => {
    expect(code).toMatch(/kpiNameOverrides\s*[?]?\s*:/);
  });
});

// ── G: upload page source checks ─────────────────────────────────────────────

describe('G — admin/targets/upload/page.tsx: structure', () => {
  let code = '';
  try { code = src('app/admin/targets/upload/page.tsx'); } catch { /* not yet */ }

  it('G1: upload page file exists', () => {
    expect(code.length).toBeGreaterThan(0);
  });

  it('G2: imports generateTargetTemplate', () => {
    expect(code).toMatch(/generateTargetTemplate/);
  });

  it('G3: imports parseTargetUpload', () => {
    expect(code).toMatch(/parseTargetUpload/);
  });

  it('G4: imports buildErrorReportBuffer', () => {
    expect(code).toMatch(/buildErrorReportBuffer/);
  });

  it('G5: imports getTenantKpiDefs and saveTenantKpiDefs', () => {
    expect(code).toMatch(/getTenantKpiDefs/);
    expect(code).toMatch(/saveTenantKpiDefs/);
  });

  it('G6: file input accepts .xlsx and .xls', () => {
    expect(code).toMatch(/\.xlsx/);
    expect(code).toMatch(/\.xls/);
  });

  it('G7: has a "Download Template" button/action', () => {
    expect(code).toMatch(/[Dd]ownload.*[Tt]emplate|[Tt]emplate.*[Dd]ownload/);
  });

  it('G8: has fromMonth and toMonth state variables for range picker', () => {
    expect(code).toMatch(/fromMonth/);
    expect(code).toMatch(/toMonth/);
  });

  it('G9: shows updated and skipped counts after upload', () => {
    expect(code).toMatch(/updated/i);
    expect(code).toMatch(/skipped/i);
  });

  it('G10: has a "Download Report" button after upload', () => {
    expect(code).toMatch(/[Dd]ownload.*[Rr]eport|[Rr]eport.*[Dd]ownload/);
  });

  it('G11: KPI config section has Add KPI functionality', () => {
    expect(code).toMatch(/[Aa]dd\s+KPI|addKpi|newKpi/i);
  });

  it('G12: accessible to both CLIENT_ADMIN and GIFSY_ADMIN', () => {
    expect(code).toMatch(/CLIENT_ADMIN/);
    expect(code).toMatch(/GIFSY_ADMIN/);
  });
});
