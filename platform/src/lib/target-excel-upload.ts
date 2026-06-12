/* ─── Excel-based target upload ──────────────────────────────────────────────
 *
 * Three public functions:
 *  • generateTargetTemplate  — build a downloadable .xlsx template
 *  • parseTargetUpload       — parse an uploaded .xlsx, validate, extract targets
 *  • buildErrorReportBuffer  — build a downloadable upload-status report
 *
 * All functions are config-driven via TenantKpiDef[].  Adding or removing a KPI
 * requires only a config change — no code changes here.
 * ─────────────────────────────────────────────────────────────────────────── */

import * as XLSX from 'xlsx';
import type { TenantKpiDef } from '@/lib/platform/tenant-kpi-config';
import { getEnabledKpiDefs }  from '@/lib/platform/tenant-kpi-config';
import { isMonthLocked, formatMonth } from '@/lib/targets';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RowStatus = 'updated' | 'skipped_outlet' | 'skipped_locked' | 'error';

export interface MonthData {
  targets:       Record<string, number>;  // kpiId → numeric target
  nameOverrides: Record<string, string>;  // kpiId → display name override
  locked:        boolean;                 // true when month is in the past
}

export interface ParsedTargetRow {
  rowIndex:   number;   // 1-based row number for user-facing messages
  outletId:   string;
  outletName: string;
  zone:       string;
  state:      string;
  asmId:      string;
  soId:       string;
  dbCode:     string;
  dbName:     string;
  town:       string;
  channel:    string;
  program:    string;
  subProgram: string;
  monthData:  Record<string, MonthData>;  // month (YYYY-MM) → data
  status:     RowStatus;
  remarks:    string;
}

export interface ParseResult {
  rows:             ParsedTargetRow[];
  /** month → outletId → kpiId → numeric target */
  targetValues:     Record<string, Record<string, Record<string, number>>>;
  /** month → outletId → kpiId → display name */
  kpiNameOverrides: Record<string, Record<string, Record<string, string>>>;
  summary: {
    total:   number;
    updated: number;
    skipped: number;
    errors:  number;
  };
}

// ── Fixed columns (always present, always in this order) ──────────────────────

const FIXED_COLS = [
  'Zone', 'State', 'ASM ID', 'SO ID', 'DB Code', 'DB Name',
  'Outlet ID', 'Outlet Name', 'Town', 'Channel', 'Program', 'Sub Program',
] as const;

// ── Month name → month number map ─────────────────────────────────────────────

const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// ── generateTargetTemplate ────────────────────────────────────────────────────

/**
 * Generate a blank Excel template for the given KPI config and months.
 *
 * Layout:
 *   Row 1: merged month-group headers (e.g. "Jul '26 Target")
 *   Row 2: individual column headers
 *   Rows 3+: empty — admin fills in outlet rows
 */
export function generateTargetTemplate(
  kpiDefs: TenantKpiDef[],
  months:  string[],
): ArrayBuffer {
  const enabled        = getEnabledKpiDefs(kpiDefs);
  const nameOverrideDefs = enabled.filter(d => d.hasNameOverride);

  // ── Row 1: month group headers ──────────────────────────────────────────
  const row1: (string | number)[] = [
    ...Array(FIXED_COLS.length).fill(''),
    ...Array(nameOverrideDefs.length).fill(''),
  ];
  for (const month of months) {
    row1.push(`${formatMonth(month)} Target`);
    for (let i = 1; i < enabled.length; i++) row1.push('');
  }

  // ── Row 2: column headers ────────────────────────────────────────────────
  const row2: string[] = [
    ...FIXED_COLS,
    ...nameOverrideDefs.map(d => d.nameOverrideLabel),
  ];
  for (const _month of months) {
    for (const kpi of enabled) row2.push(kpi.label);
  }

  // ── Workbook ─────────────────────────────────────────────────────────────
  const ws = XLSX.utils.aoa_to_sheet([row1, row2]);

  // Column widths
  const colWidths: { wch: number }[] = [
    ...FIXED_COLS.map(() => ({ wch: 14 })),
    ...nameOverrideDefs.map(() => ({ wch: 22 })),
  ];
  for (const _month of months) {
    for (const kpi of enabled) {
      colWidths.push({ wch: kpi.isPrimary ? 14 : 18 });
    }
  }
  ws['!cols'] = colWidths;

  // Merge month-group header cells
  const merges: XLSX.Range[] = [];
  let colOffset = FIXED_COLS.length + nameOverrideDefs.length;
  for (let mi = 0; mi < months.length; mi++) {
    merges.push({
      s: { r: 0, c: colOffset },
      e: { r: 0, c: colOffset + enabled.length - 1 },
    });
    colOffset += enabled.length;
  }
  ws['!merges'] = merges;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Targets');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

// ── parseTargetUpload ─────────────────────────────────────────────────────────

/**
 * Parse an uploaded target Excel file.
 *
 * Expected structure (same as generated template):
 *   Row 1: month group headers
 *   Row 2: column headers
 *   Row 3+: data rows
 *
 * Rules:
 *   • Past months are skipped (isMonthLocked = true) — never overwrite history
 *   • Outlet IDs not in knownOutletIds are skipped with an error remark
 *   • Name overrides in the name-override columns apply to all months in the file
 */
export function parseTargetUpload(
  buffer:         ArrayBuffer,
  kpiDefs:        TenantKpiDef[],
  knownOutletIds: Set<string>,
): ParseResult {
  const enabled          = getEnabledKpiDefs(kpiDefs);
  const nameOverrideDefs = enabled.filter(d => d.hasNameOverride);

  const wb     = XLSX.read(buffer, { type: 'array' });
  const ws     = wb.Sheets[wb.SheetNames[0]];
  const rawAoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' });

  if (rawAoa.length < 2) {
    return {
      rows: [], targetValues: {}, kpiNameOverrides: {},
      summary: { total: 0, updated: 0, skipped: 0, errors: 0 },
    };
  }

  const headerRow1 = (rawAoa[0] as (string | number)[]).map(c => String(c ?? '').trim());
  const headerRow2 = (rawAoa[1] as (string | number)[]).map(c => String(c ?? '').trim());

  // ── Detect month blocks from row 1 ────────────────────────────────────
  // Matches: "Jul '26 Target", "July 2026 Target", "Apr '26 Target", etc.
  const MONTH_BLOCK_RE = /^([a-z]{3})[a-z]*\s+[''`]?(\d{2,4})\s+target$/i;

  const monthBlocks: { month: string; startCol: number }[] = [];
  for (let ci = 0; ci < headerRow1.length; ci++) {
    const cell  = headerRow1[ci].toLowerCase().replace(/[''`]/g, "'");
    const match = cell.match(MONTH_BLOCK_RE);
    if (match) {
      const monthNum  = MONTH_NUM[match[1].toLowerCase()];
      const yearPart  = match[2].length === 2 ? `20${match[2]}` : match[2];
      if (monthNum) {
        monthBlocks.push({
          month:    `${yearPart}-${String(monthNum).padStart(2, '0')}`,
          startCol: ci,
        });
      }
    }
  }

  // ── Find fixed column indices from row 2 ───────────────────────────────
  const colIdx = (label: string) => headerRow2.indexOf(label);

  const fixedIdx = {
    outletId:   colIdx('Outlet ID'),
    outletName: colIdx('Outlet Name'),
    zone:       colIdx('Zone'),
    state:      colIdx('State'),
    asmId:      colIdx('ASM ID'),
    soId:       colIdx('SO ID'),
    dbCode:     colIdx('DB Code'),
    dbName:     colIdx('DB Name'),
    town:       colIdx('Town'),
    channel:    colIdx('Channel'),
    program:    colIdx('Program'),
    subProgram: colIdx('Sub Program'),
  };

  // ── Map name-override column positions ────────────────────────────────
  const nameOverrideColMap: Record<string, number> = {}; // kpiId → col index
  for (const def of nameOverrideDefs) {
    const ci = colIdx(def.nameOverrideLabel);
    if (ci >= 0) nameOverrideColMap[def.id] = ci;
  }

  // ── Parse data rows ────────────────────────────────────────────────────
  const rows:             ParsedTargetRow[] = [];
  const targetValues:     Record<string, Record<string, Record<string, number>>> = {};
  const kpiNameOverrides: Record<string, Record<string, Record<string, string>>> = {};

  for (let ri = 2; ri < rawAoa.length; ri++) {
    const row = rawAoa[ri] as (string | number)[];
    if (!row || row.every(c => String(c ?? '').trim() === '')) continue;

    const outletId = String(row[fixedIdx.outletId] ?? '').trim();
    if (!outletId) continue;

    const str = (i: number) => String(row[i] ?? '').trim();

    const parsedRow: ParsedTargetRow = {
      rowIndex:   ri + 1,
      outletId,
      outletName: str(fixedIdx.outletName),
      zone:       str(fixedIdx.zone),
      state:      str(fixedIdx.state),
      asmId:      str(fixedIdx.asmId),
      soId:       str(fixedIdx.soId),
      dbCode:     str(fixedIdx.dbCode),
      dbName:     str(fixedIdx.dbName),
      town:       str(fixedIdx.town),
      channel:    str(fixedIdx.channel),
      program:    str(fixedIdx.program),
      subProgram: str(fixedIdx.subProgram),
      monthData:  {},
      status:     'updated',
      remarks:    '',
    };

    // ── Validate outlet ID ───────────────────────────────────────────────
    if (!knownOutletIds.has(outletId)) {
      parsedRow.status  = 'skipped_outlet';
      parsedRow.remarks = `Outlet ID "${outletId}" not found in system — row skipped`;
      rows.push(parsedRow);
      continue;
    }

    // ── Read name overrides (apply to all months in this file) ──────────
    const globalNameOverrides: Record<string, string> = {};
    for (const def of nameOverrideDefs) {
      const ci  = nameOverrideColMap[def.id];
      if (ci !== undefined) {
        const val = str(ci);
        if (val) globalNameOverrides[def.id] = val;
      }
    }

    // ── Process each month block ─────────────────────────────────────────
    const lockedMonthLabels: string[] = [];
    let   hasUpdated = false;

    for (const block of monthBlocks) {
      const { month, startCol } = block;
      const locked = isMonthLocked(month);

      const targets: Record<string, number> = {};
      for (let ki = 0; ki < enabled.length; ki++) {
        const kpi    = enabled[ki];
        const rawVal = row[startCol + ki];
        const num    = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal ?? ''));
        if (!isNaN(num) && num > 0) targets[kpi.id] = num;
      }

      const nameOverridesForMonth = { ...globalNameOverrides };

      parsedRow.monthData[month] = {
        targets,
        nameOverrides: nameOverridesForMonth,
        locked,
      };

      if (locked) {
        lockedMonthLabels.push(formatMonth(month));
        continue;
      }

      // Write current/future month data.
      // Name overrides are always written when present (even if the row has no
      // numeric target for that month) so they apply correctly for all months.
      const hasTargets   = Object.keys(targets).length > 0;
      const hasOverrides = Object.keys(nameOverridesForMonth).length > 0;

      if (hasTargets || hasOverrides) {
        if (!targetValues[month])     targetValues[month]     = {};
        if (!kpiNameOverrides[month]) kpiNameOverrides[month] = {};
        if (hasTargets)   { targetValues[month][outletId]     = targets; }
        if (hasOverrides) { kpiNameOverrides[month][outletId] = nameOverridesForMonth; }
        if (hasTargets)   { hasUpdated = true; }
      }
    }

    // ── Build remarks ────────────────────────────────────────────────────
    const remarkParts: string[] = [];
    if (lockedMonthLabels.length > 0) {
      const plural = lockedMonthLabels.length > 1;
      remarkParts.push(
        `${lockedMonthLabels.join(', ')} ${plural ? 'are' : 'is'} in the past and cannot be updated — ` +
        `${plural ? 'those months were' : 'that month was'} skipped`,
      );
    }
    if (hasUpdated) {
      remarkParts.push('Updated');
    } else if (lockedMonthLabels.length === monthBlocks.length) {
      // All months locked → treat as skipped
      parsedRow.status = 'skipped_locked';
    }

    parsedRow.status  = hasUpdated ? 'updated' : (parsedRow.status !== 'error' ? 'skipped_locked' : 'error');
    parsedRow.remarks = remarkParts.join('; ');
    rows.push(parsedRow);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const summary = {
    total:   rows.length,
    updated: rows.filter(r => r.status === 'updated').length,
    skipped: rows.filter(r => r.status !== 'updated' && r.status !== 'error').length,
    errors:  rows.filter(r => r.status === 'error').length,
  };

  return { rows, targetValues, kpiNameOverrides, summary };
}

// ── buildErrorReportBuffer ────────────────────────────────────────────────────

const STATUS_LABEL: Record<RowStatus, string> = {
  updated:        'Updated',
  skipped_outlet: 'Skipped',
  skipped_locked: 'Skipped',
  error:          'Error',
};

/**
 * Build a downloadable upload-status report.
 * Every input row appears with a Status and Remarks column.
 */
export function buildErrorReportBuffer(rows: ParsedTargetRow[]): ArrayBuffer {
  const headerRow = [
    'Row #', 'Outlet ID', 'Outlet Name', 'Zone', 'State',
    'ASM ID', 'SO ID', 'DB Code', 'DB Name', 'Town',
    'Channel', 'Program', 'Sub Program', 'Status', 'Remarks',
  ];

  const dataRows = rows.map(r => [
    r.rowIndex, r.outletId, r.outletName, r.zone, r.state,
    r.asmId,    r.soId,     r.dbCode,     r.dbName, r.town,
    r.channel,  r.program,  r.subProgram,
    STATUS_LABEL[r.status] ?? r.status,
    r.remarks,
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  ws['!cols'] = [
    { wch: 6 }, { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 14 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 14 },
    { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 60 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Upload Report');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
