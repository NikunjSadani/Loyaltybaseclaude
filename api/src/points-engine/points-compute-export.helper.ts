/**
 * Points Compute Engine — Wave 1 EXPORT helpers (PURE; no Nest/Prisma/DB).
 *
 * Two outputs are produced from a read-only {@link ComputePreview}:
 *
 *  1. buildCreditUploadXlsx — the machine file the operator re-uploads, UNCHANGED, through the
 *     EXISTING credits-upload flow after the client approves the preview offline. It therefore
 *     reproduces the EXACT sheet shape that `generateCreditTemplate` emits and
 *     `parseCreditUpload` reads (platform/src/lib/credits-payouts-template.ts +
 *     credits-payouts-parser.ts):
 *
 *        Sheet[0] (any name)
 *          Row 0: a TITLE cell          (the parser skips row 0)
 *          Row 1: HEADERS               → "Outlet ID" | "Outlet Name" | <field name>… | "<field name> Narration"…
 *          Row 2+: one DATA row per outlet; each <field name> cell holds the WHOLE points for that
 *                  (outlet × field); narration cells are present (blank) to mirror the template.
 *
 *     The parser keys value columns by the CreditField NAME (headerRow.indexOf(field.name)), keys data
 *     by "Outlet ID", treats a blank/0 cell as SKIP (so outlets missing a given field are fine), and
 *     derives POINTS-vs-PAYOUT per the LIVE field config at upload time (the file never states it). The
 *     engine computes WHOLE POINTS (no ×100) — so every value cell is a whole points count and the
 *     target CreditField must be POINTS-classified for the outlet types involved.
 *
 *  2. buildPreviewReportXlsx — the full human review report the operator shares with the client
 *     offline: one row per preview row (every status, with the math explanation) + a summary.
 *
 * Both return a Buffer for a Nest StreamableFile (the controller — wired by the orchestrator — streams
 * it). Sanitisation (cellSafe) is inherited from the shared xlsx helpers.
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe, buildXlsx } from '../common/xlsx';
import type { ComputePreview, ComputePreviewRow } from './points-compute.types';

// ─── Headers the credits upload parser REQUIRES verbatim ───────────────────────
// Mirrors platform/src/lib/credits-payouts-template.ts (do not rename — the parser does an exact
// string match on these).
const OUTLET_ID_HEADER = 'Outlet ID';
const OUTLET_NAME_HEADER = 'Outlet Name';
/** Narration column suffix (`"<field name> Narration"`) the template/parser use. */
const NARRATION_SUFFIX = ' Narration';
/** The template's sheet name. The parser reads SheetNames[0] regardless, but we match for fidelity. */
const CREDIT_SHEET_NAME = 'Credits & Payouts';

/** Month label for the title row — mirrors generateCreditTemplate's `monthLabel` (display-only). */
function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  if (!y || !m) return yyyyMm;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/** Column header for a field — the CreditField NAME (what the parser matches). Falls back to the
 *  fieldId only if a name was not resolved (a non-round-tripping last resort — see fieldName docs). */
function fieldHeader(row: ComputePreviewRow): string {
  return (row.fieldName && row.fieldName.trim()) || row.fieldId || '';
}

/**
 * Build the operator-reuploadable credit-upload xlsx from the preview's OK rows ONLY.
 * Rows that are not OK, or carry no numeric points, or have no resolvable credit field, are excluded
 * (they can never credit). Multiple OK rows for the SAME (outlet × field) are SUMMED into the one cell
 * the wide template allows (which also side-steps the parser's in-file duplicate-row ERROR).
 */
export function buildCreditUploadXlsx(preview: ComputePreview): Buffer {
  const okRows = preview.rows.filter(
    (r) =>
      r.status === 'OK' &&
      typeof r.points === 'number' &&
      Number.isFinite(r.points) &&
      fieldHeader(r) !== '',
  );

  // Field columns: first-seen order, keyed by the resolved header (the CreditField name the parser
  // matches). Keyed by header rather than fieldId so a (missing-name) fallback can't collide.
  const fieldOrder: string[] = [];
  const seenField = new Set<string>();
  // Outlet rows: first-seen order; keep the first non-empty name seen for each outlet.
  const outletOrder: string[] = [];
  const outletName = new Map<string, string>();
  // (outletCode → header → summed whole points).
  const cell = new Map<string, Map<string, number>>();

  for (const r of okRows) {
    const header = fieldHeader(r);
    if (!seenField.has(header)) {
      seenField.add(header);
      fieldOrder.push(header);
    }
    if (!outletName.has(r.outletCode)) {
      outletOrder.push(r.outletCode);
      outletName.set(r.outletCode, (r.outletName && r.outletName.trim()) || r.outletCode);
    } else if (
      (!outletName.get(r.outletCode) || outletName.get(r.outletCode) === r.outletCode) &&
      r.outletName &&
      r.outletName.trim()
    ) {
      outletName.set(r.outletCode, r.outletName.trim());
    }
    let byField = cell.get(r.outletCode);
    if (!byField) {
      byField = new Map<string, number>();
      cell.set(r.outletCode, byField);
    }
    byField.set(header, (byField.get(header) ?? 0) + (r.points as number));
  }

  // Header row: fixed cols + value cols + narration cols (value cols THEN narration cols, as template).
  const headers: string[] = [
    OUTLET_ID_HEADER,
    OUTLET_NAME_HEADER,
    ...fieldOrder,
    ...fieldOrder.map((f) => `${f}${NARRATION_SUFFIX}`),
  ];

  // Data rows: one per outlet. Value = whole points (blank when this outlet has no such field).
  // Narration cells are present but blank — the parser treats them as optional display text.
  const dataRows: (string | number)[][] = outletOrder.map((code) => {
    const byField = cell.get(code) ?? new Map<string, number>();
    const row: (string | number)[] = [code, outletName.get(code) ?? code];
    for (const f of fieldOrder) {
      const v = byField.get(f);
      row.push(v === undefined ? '' : v);
    }
    for (let i = 0; i < fieldOrder.length; i++) row.push('');
    return row;
  });

  // aoa (NOT json_to_sheet) so row 0 is the TITLE and row 1 is the header — the exact layout
  // parseCreditUpload expects (it reads headers at index 1, data at index 2+).
  const wsData: (string | number)[][] = [
    [`Credits & Payouts Data — ${monthLabel(preview.period)}`],
    headers,
    ...dataRows,
  ];

  const ws = aoaToSheetSafe(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, CREDIT_SHEET_NAME);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── Preview report (human review) ─────────────────────────────────────────────

/** Column headers of the "Preview Rows" sheet — stable, explicit order. */
export const PREVIEW_REPORT_COLUMNS = [
  'Outlet Code',
  'Outlet Name',
  'Program',
  'KPI Code',
  'Achievement',
  'Target',
  'Status',
  'Points',
  'Reason / Explanation',
  'Rule ID',
  'Rule Version',
] as const;

/** Column headers of the "Summary" sheet. */
export const PREVIEW_SUMMARY_COLUMNS = [
  'Client',
  'Period',
  'Total',
  'OK',
  'Skip',
  'Error',
  'No Rule',
  'Total Points',
  'Engine Disabled',
] as const;

function num(v: number | null | undefined): number | string {
  return typeof v === 'number' && Number.isFinite(v) ? v : '';
}

/**
 * Build the full human-readable preview report: a "Preview Rows" sheet (one row per preview row, EVERY
 * status, with the math explanation) + a "Summary" sheet (the run's counts + total points + the
 * engine-disabled flag). This is what the operator shares with the client offline for approval before
 * re-uploading the credit-upload file.
 */
export function buildPreviewReportXlsx(preview: ComputePreview): Buffer {
  const rows: Record<string, unknown>[] = preview.rows.map((r) => ({
    'Outlet Code': r.outletCode,
    'Outlet Name': (r.outletName && r.outletName.trim()) || '',
    Program: (r.program && r.program.trim()) || '',
    'KPI Code': r.kpiCode,
    Achievement: num(r.achievement),
    Target: num(r.target),
    Status: r.status,
    // Whole points only on OK rows; blank otherwise (no points to show).
    Points: r.status === 'OK' ? num(r.points) : '',
    // SKIP/ERROR/NO_RULE carry a `reason`; OK rows carry the trace `explanation`.
    'Reason / Explanation': r.reason ?? r.explanation ?? '',
    'Rule ID': r.ruleId ?? '',
    'Rule Version': typeof r.ruleVersion === 'number' ? r.ruleVersion : '',
  }));

  const summary: Record<string, unknown>[] = [
    {
      Client: preview.clientId,
      Period: preview.period,
      Total: preview.counts.total,
      OK: preview.counts.ok,
      Skip: preview.counts.skip,
      Error: preview.counts.error,
      'No Rule': preview.counts.noRule,
      'Total Points': preview.totalPoints,
      'Engine Disabled': preview.engineDisabled,
    },
  ];

  return buildXlsx([
    { name: 'Preview Rows', rows },
    { name: 'Summary', rows: summary },
  ]);
}
