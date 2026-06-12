/* ─── Sales Excel Upload ──────────────────────────────────────────────────────
 *
 * Same column format as the target Excel upload, but for actual sales data.
 * Targets define the KPI structure for a month; this module lets admins upload
 * the actual sales numbers for that same structure.
 *
 * Three public functions:
 *  • generateSalesTemplate  — pre-populated .xlsx with all known outlets + KPI columns
 *  • parseSalesUpload       — validates outlet IDs, extracts KPI sales values
 *  • buildSalesReportBuffer — downloadable status report (Saved / Skipped / Error)
 *
 * Restricted to current month and previous month only — sales data is historical.
 * ─────────────────────────────────────────────────────────────────────────── */

import * as XLSX from 'xlsx';
import type { TenantKpiDef } from '@/lib/platform/tenant-kpi-config';
import { getEnabledKpiDefs }  from '@/lib/platform/tenant-kpi-config';
import { MOCK_OUTLETS, formatMonth } from '@/lib/targets';
import type { NewOutletType }        from '@/lib/targets';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SalesRowStatus = 'saved' | 'skipped_outlet' | 'error';

export interface ParsedSalesUploadRow {
  rowIndex:   number;                   // 1-based row number for user messages
  outletId:   string;
  outletName: string;
  kpiValues:  Record<string, number>;   // kpiId → actual sales value
  status:     SalesRowStatus;
  remarks:    string;
}

export interface SalesParseResult {
  rows:      ParsedSalesUploadRow[];
  /** outletId → kpiId → actual sales value */
  salesData: Record<string, Record<string, number>>;
  summary: {
    total:   number;
    saved:   number;
    skipped: number;
    errors:  number;
  };
}

// ── Fixed columns (identical to target upload for visual consistency) ─────────

const FIXED_COLS = [
  'Zone', 'State', 'ASM ID', 'SO ID', 'DB Code', 'DB Name',
  'Outlet ID', 'Outlet Name', 'Town', 'Channel', 'Program', 'Sub Program',
] as const;

const OUTLET_TYPES: NewOutletType[] = ['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT'];

// ── generateSalesTemplate ─────────────────────────────────────────────────────

/**
 * Generate a pre-populated Excel template for sales data upload.
 *
 * Layout (single sheet named "Sales"):
 *   Row 1: title — "Sales Data — {month}" merged across all columns
 *   Row 2: column headers (12 fixed + KPI value columns)
 *   Rows 3+: one row per outlet, pre-populated with outlet info; KPI cells blank
 *
 * No name-override columns — sales upload only needs the numbers.
 * Outlet rows come from MOCK_OUTLETS (all types) sorted by type then ID.
 */
export function generateSalesTemplate(
  kpiDefs: TenantKpiDef[],
  month:   string,
): ArrayBuffer {
  const enabled = getEnabledKpiDefs(kpiDefs);

  // ── Row 1: title ─────────────────────────────────────────────────────────
  const totalCols = FIXED_COLS.length + enabled.length;
  const titleRow: (string | number)[] = [
    `Sales Data — ${formatMonth(month)}`,
    ...Array(totalCols - 1).fill(''),
  ];

  // ── Row 2: column headers ─────────────────────────────────────────────────
  const headerRow: string[] = [...FIXED_COLS, ...enabled.map(k => k.label)];

  // ── Rows 3+: one row per outlet ───────────────────────────────────────────
  const outletRows: (string | number)[][] = [];
  for (const ot of OUTLET_TYPES) {
    for (const outlet of MOCK_OUTLETS[ot]) {
      outletRows.push([
        '',           // Zone
        outlet.state, // State
        outlet.asm,   // ASM ID
        '',           // SO ID
        '',           // DB Code
        '',           // DB Name
        outlet.id,    // Outlet ID
        outlet.name,  // Outlet Name
        outlet.city,  // Town
        '',           // Channel
        '',           // Program
        '',           // Sub Program
        ...enabled.map(() => ''),  // KPI cells — blank for admin to fill
      ]);
    }
  }

  // ── Workbook ──────────────────────────────────────────────────────────────
  const ws = XLSX.utils.aoa_to_sheet([titleRow, headerRow, ...outletRows]);

  // Merge title row across all columns
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }];

  // Column widths
  ws['!cols'] = [
    ...FIXED_COLS.map(() => ({ wch: 14 })),
    ...enabled.map(k => ({ wch: k.isPrimary ? 14 : 18 })),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

// ── parseSalesUpload ──────────────────────────────────────────────────────────

/**
 * Parse an uploaded sales Excel file.
 *
 * Expected format (matches generateSalesTemplate output):
 *   Row 1: title row (skipped)
 *   Row 2: column headers
 *   Row 3+: outlet rows with sales values
 *
 * Validation rules:
 *   • Outlet ID missing → row ignored (not counted)
 *   • Outlet ID not in knownOutletIds → status = 'skipped_outlet'
 *   • Non-numeric value in any KPI column → status = 'error'
 *   • Negative value in any KPI column → status = 'error'
 *   • Blank KPI cell → silently skipped (no error, value not stored)
 *   • Everything else → status = 'saved', value stored in kpiValues
 */
export function parseSalesUpload(
  buffer:         ArrayBuffer,
  kpiDefs:        TenantKpiDef[],
  knownOutletIds: Set<string>,
): SalesParseResult {
  const enabled = getEnabledKpiDefs(kpiDefs);

  const wb     = XLSX.read(buffer, { type: 'array' });
  const ws     = wb.Sheets[wb.SheetNames[0]];
  const rawAoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });

  if (rawAoa.length < 2) {
    return emptyResult();
  }

  // Row 1 is title; row 2 is headers. Find which row has "Outlet ID".
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rawAoa.length, 3); i++) {
    const row = (rawAoa[i] as (string | number)[]).map(c => String(c ?? '').trim());
    if (row.includes('Outlet ID')) { headerRowIdx = i; break; }
  }
  if (headerRowIdx < 0) return emptyResult();

  const headerRow = (rawAoa[headerRowIdx] as (string | number)[]).map(c => String(c ?? '').trim());

  // Map column label → index
  const colIdx = (label: string) => headerRow.indexOf(label);
  const outletIdCol = colIdx('Outlet ID');
  if (outletIdCol < 0) return emptyResult();

  // KPI label → { id, colIndex }
  const kpiCols: Array<{ id: string; label: string; col: number }> = [];
  for (const kpi of enabled) {
    const ci = colIdx(kpi.label);
    if (ci >= 0) kpiCols.push({ id: kpi.id, label: kpi.label, col: ci });
  }

  const rows:      ParsedSalesUploadRow[] = [];
  const salesData: Record<string, Record<string, number>> = {};

  for (let ri = headerRowIdx + 1; ri < rawAoa.length; ri++) {
    const row = rawAoa[ri] as (string | number)[];

    // Skip fully blank rows
    if (!row || row.every(c => String(c ?? '').trim() === '')) continue;

    const outletId = String(row[outletIdCol] ?? '').trim();
    if (!outletId) continue;  // no outlet ID → ignore silently

    const str = (ci: number) => String(row[ci] ?? '').trim();
    const outletName = str(colIdx('Outlet Name'));

    const parsedRow: ParsedSalesUploadRow = {
      rowIndex:  ri + 1,
      outletId,
      outletName,
      kpiValues: {},
      status:    'saved',
      remarks:   '',
    };

    // Validate outlet ID
    if (!knownOutletIds.has(outletId)) {
      parsedRow.status  = 'skipped_outlet';
      parsedRow.remarks = `Outlet ID "${outletId}" not found in system — row skipped`;
      rows.push(parsedRow);
      continue;
    }

    // Parse KPI values
    let hasError = false;
    const kpiValues: Record<string, number> = {};

    for (const { id, label, col } of kpiCols) {
      const rawVal = row[col];
      const rawStr = String(rawVal ?? '').trim();

      if (rawStr === '') continue;  // blank — silently skip

      const num = typeof rawVal === 'number' ? rawVal : parseFloat(rawStr);

      if (isNaN(num)) {
        parsedRow.status  = 'error';
        parsedRow.remarks = `Invalid (non-numeric) value "${rawStr}" in column "${label}"`;
        hasError = true;
        break;
      }

      if (num < 0) {
        parsedRow.status  = 'error';
        parsedRow.remarks = `Negative value ${num} in column "${label}" — sales values must be 0 or greater`;
        hasError = true;
        break;
      }

      kpiValues[id] = num;
    }

    if (!hasError) {
      parsedRow.kpiValues = kpiValues;
      if (Object.keys(kpiValues).length > 0) {
        salesData[outletId] = { ...(salesData[outletId] ?? {}), ...kpiValues };
      }
    }

    rows.push(parsedRow);
  }

  const summary = {
    total:   rows.length,
    saved:   rows.filter(r => r.status === 'saved').length,
    skipped: rows.filter(r => r.status === 'skipped_outlet').length,
    errors:  rows.filter(r => r.status === 'error').length,
  };

  return { rows, salesData, summary };
}

// ── buildSalesReportBuffer ────────────────────────────────────────────────────

const STATUS_LABEL: Record<SalesRowStatus, string> = {
  saved:          'Saved',
  skipped_outlet: 'Skipped',
  error:          'Error',
};

/**
 * Build a downloadable upload-status report.
 * Every parsed row appears with a Status and Remarks column.
 */
export function buildSalesReportBuffer(rows: ParsedSalesUploadRow[]): ArrayBuffer {
  const headerRow = [
    'Row #', 'Outlet ID', 'Outlet Name', 'KPIs Saved', 'Status', 'Remarks',
  ];

  const dataRows = rows.map(r => [
    r.rowIndex,
    r.outletId,
    r.outletName,
    Object.entries(r.kpiValues).map(([k, v]) => `${k}=${v}`).join(', '),
    STATUS_LABEL[r.status] ?? r.status,
    r.remarks,
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  ws['!cols'] = [
    { wch: 6 }, { wch: 16 }, { wch: 22 }, { wch: 40 }, { wch: 10 }, { wch: 60 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales Upload Report');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyResult(): SalesParseResult {
  return {
    rows: [], salesData: {},
    summary: { total: 0, saved: 0, skipped: 0, errors: 0 },
  };
}
