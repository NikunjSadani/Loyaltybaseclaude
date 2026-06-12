/**
 * Sales Data Upload — core library
 *
 * Pure functions that can be tested without a browser/DOM.
 *
 * Key exports:
 *   getKpisForOutletType  — union of KPI displayNames from ACTIVE configs for a type+month
 *   parseSalesRows        — validate & classify uploaded rows (ACCEPTED / REJECTED)
 *   generateSalesTemplate — build multi-sheet Excel template (Uint8Array)
 */

import * as XLSX from 'xlsx';
import {
  MOCK_OUTLETS,
  type NewOutletType,
  type TargetConfig,
  resolveNewConfig,
} from './targets';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedSalesRow = {
  /** Original outlet_code cell value */
  outletCode: string;
  /** Human-readable outlet name (blank when outlet is unknown) */
  outletName: string;
  /** ACCEPTED = row saved; REJECTED = row skipped due to hard error */
  rowStatus: 'ACCEPTED' | 'REJECTED';
  /**
   * KPI displayName → numeric value.
   * Only populated for KPIs that are (a) configured for this outlet and
   * (b) had a valid numeric value in the upload.
   */
  kpiValues: Record<string, number>;
  /**
   * KPI names that were present in the upload row but are NOT configured
   * for this outlet's resolved target config → silently ignored (row accepted).
   */
  ignoredKpis: string[];
  /**
   * Human-readable explanation shown in the report download.
   * Empty string when there are no remarks.
   */
  errorRemarks: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const SALES_UPLOAD_INSTRUCTIONS: string[] = [
  'How to fill this template:',
  '1. Fill one sheet per outlet type (SSS, Wholesaler, Sub-Stockist, SSS TOT).',
  '2. Do NOT modify the outlet_code or outlet_name columns.',
  '3. Enter numeric (non-negative) values for KPI columns only.',
  '4. Leave a KPI cell blank if you have no data for that outlet.',
  '5. Rows with text values in KPI columns will be REJECTED.',
  '6. KPI values for outlets that do not have that KPI configured will be IGNORED (row still accepted).',
  '7. Save the file and upload it back through the portal for the selected month.',
];

const OUTLET_TYPE_SHEET_NAMES: Record<NewOutletType, string> = {
  SSS:          'SSS',
  WHOLESALER:   'Wholesaler',
  SUB_STOCKIST: 'Sub-Stockist',
  SSS_TOT:      'SSS TOT',
};

// ─────────────────────────────────────────────────────────────────────────────
// getKpisForOutletType
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the de-duplicated union of KPI displayNames from all ACTIVE configs
 * that cover the given outlet type + month combination.
 *
 * Only ACTIVE configs count — a DRAFT config means targets haven't been
 * finalised yet, so those KPIs should not appear in the sales template or
 * be accepted during upload validation.
 */
export function getKpisForOutletType(
  outletType: NewOutletType,
  month: string,
  configs: TargetConfig[],
): string[] {
  const seen = new Set<string>();
  for (const cfg of configs) {
    if (cfg.status !== 'ACTIVE') continue;
    if (cfg.outletType !== outletType) continue;
    if (!cfg.months.includes(month)) continue;
    for (const kpi of cfg.kpis) {
      seen.add(kpi.displayName);
    }
  }
  return Array.from(seen);
}

// ─────────────────────────────────────────────────────────────────────────────
// parseSalesRows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and classify rows parsed from an uploaded Excel sheet.
 *
 * Rules (in order):
 *  • outlet_code missing or blank         → REJECTED
 *  • outlet_code unknown in master list   → REJECTED
 *  • non-numeric value in any KPI column  → REJECTED (entire row)
 *  • negative value in any KPI column     → REJECTED (entire row)
 *  • KPI not in outlet's resolved config  → ignored (row still ACCEPTED)
 *  • blank/missing KPI cell               → skipped silently
 *  • everything else                      → ACCEPTED, value stored
 */
export function parseSalesRows(
  rawRows: Record<string, unknown>[],
  outletType: NewOutletType,
  month: string,
  configs: TargetConfig[],
): ParsedSalesRow[] {
  const outlets = MOCK_OUTLETS[outletType];

  return rawRows.map((row) => {
    const outletCode = String(row['outlet_code'] ?? '').trim();

    // ── Hard error: missing outlet_code ──────────────────────────────────────
    if (!outletCode) {
      return {
        outletCode: '',
        outletName: '',
        rowStatus: 'REJECTED',
        kpiValues: {},
        ignoredKpis: [],
        errorRemarks: 'Missing outlet_code: every row must have a valid outlet code',
      };
    }

    // ── Hard error: unknown outlet ────────────────────────────────────────────
    const outlet = outlets.find((o) => o.id === outletCode);
    if (!outlet) {
      return {
        outletCode,
        outletName: '',
        rowStatus: 'REJECTED',
        kpiValues: {},
        ignoredKpis: [],
        errorRemarks: `Outlet code "${outletCode}" does not exist in the ${outletType} master list`,
      };
    }

    // ── Resolve which KPIs are configured for this specific outlet ───────────
    const resolvedCfg = resolveNewConfig(outlet, outletType, month, configs);
    const configuredKpis = resolvedCfg
      ? new Set(resolvedCfg.kpis.map((k) => k.displayName))
      : new Set<string>();

    // ── Process KPI columns ───────────────────────────────────────────────────
    const kpiValues: Record<string, number> = {};
    const ignoredKpis: string[] = [];
    const errors: string[] = [];

    for (const [key, val] of Object.entries(row)) {
      if (key === 'outlet_code' || key === 'outlet_name') continue;

      // D8: blank cell → skip silently (not an error, not ignored)
      if (val === undefined || val === null || val === '') continue;

      // Check numeric
      const num = Number(val);
      if (isNaN(num)) {
        errors.push(`Invalid (non-numeric) value for KPI "${key}": "${val}"`);
        continue;
      }

      // Check non-negative
      if (num < 0) {
        errors.push(`Negative value not allowed for KPI "${key}": ${val}`);
        continue;
      }

      // Check configured for this outlet
      if (!configuredKpis.has(key)) {
        ignoredKpis.push(key);
        continue;
      }

      kpiValues[key] = num;
    }

    // ── Hard errors → REJECTED ────────────────────────────────────────────────
    if (errors.length > 0) {
      return {
        outletCode,
        outletName: outlet.name,
        rowStatus: 'REJECTED',
        kpiValues: {},
        ignoredKpis: [],
        errorRemarks: errors.join('; '),
      };
    }

    // ── ACCEPTED ──────────────────────────────────────────────────────────────
    return {
      outletCode,
      outletName: outlet.name,
      rowStatus: 'ACCEPTED',
      kpiValues,
      ignoredKpis,
      errorRemarks:
        ignoredKpis.length > 0
          ? `Ignored KPIs (not configured for this outlet): ${ignoredKpis.join(', ')}`
          : '',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// generateSalesTemplate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a multi-sheet Excel template for the given month.
 *
 * Sheet layout:
 *   Sheet 1 — "Instructions"  (how to fill the file)
 *   Sheet 2 — "SSS"           (outlet_code | outlet_name | [KPI columns])
 *   Sheet 3 — "Wholesaler"
 *   Sheet 4 — "Sub-Stockist"
 *   Sheet 5 — "SSS TOT"
 *
 * Rows are pre-populated with all known outlet codes for that type.
 * KPI columns appear only when there is at least one ACTIVE config
 * covering that outlet type + month; otherwise the sheet has only
 * outlet_code and outlet_name.
 */
export async function generateSalesTemplate(
  month: string,
  configs: TargetConfig[],
): Promise<Uint8Array> {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Instructions ─────────────────────────────────────────────────
  const instructionData = [
    [`Sales Data Upload Template — ${month}`],
    [],
    ...SALES_UPLOAD_INSTRUCTIONS.map((line) => [line]),
  ];
  const wsInstructions = XLSX.utils.aoa_to_sheet(instructionData);
  XLSX.utils.book_append_sheet(wb, wsInstructions, 'Instructions');

  // ── One sheet per outlet type ─────────────────────────────────────────────
  for (const outletType of ['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT'] as NewOutletType[]) {
    const sheetName = OUTLET_TYPE_SHEET_NAMES[outletType];
    const kpis = getKpisForOutletType(outletType, month, configs);
    const headers = ['outlet_code', 'outlet_name', ...kpis];

    const dataRows = MOCK_OUTLETS[outletType].map((outlet) => [
      outlet.id,
      outlet.name,
      ...kpis.map(() => ''),
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf);
}

// ─────────────────────────────────────────────────────────────────────────────
// generateReportExcel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the upload report Excel (one sheet per outlet type, one row per
 * parsed row, columns: outlet_code | outlet_name | row_status | accepted_kpis |
 * ignored_kpis | error_remarks).
 */
export function generateReportExcel(
  parsedByType: Record<NewOutletType, ParsedSalesRow[]>,
): Uint8Array {
  const wb = XLSX.utils.book_new();

  for (const outletType of ['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT'] as NewOutletType[]) {
    const rows = parsedByType[outletType];
    if (!rows || rows.length === 0) continue;

    const headers = [
      'outlet_code',
      'outlet_name',
      'row_status',
      'accepted_kpis',
      'ignored_kpis',
      'error_remarks',
    ];

    const dataRows = rows.map((r) => [
      r.outletCode,
      r.outletName,
      r.rowStatus,
      Object.keys(r.kpiValues).join(', '),
      r.ignoredKpis.join(', '),
      r.errorRemarks,
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    XLSX.utils.book_append_sheet(wb, ws, OUTLET_TYPE_SHEET_NAMES[outletType]);
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf);
}
