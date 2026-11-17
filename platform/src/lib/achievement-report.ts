/* ─── Achievement Upload — "problem rows" file ────────────────────────────────
 *
 * Builds a downloadable .xlsx from the AUTHORITATIVE backend upload response.
 * Memory-safety (2026-11-13): the backend returns only the rows to act on —
 * rejected rows + saved rows with an ignored-value remark — each capped at 500;
 * saved rows are COUNTED, not echoed. So this file is a "problem rows" file, not a
 * full row-by-row report: a Summary sheet carries the counts (total / saved /
 * skipped / rejected / partly ignored) and the Problem Rows sheet lists the rows,
 * with a "showing the first N of M" line when the API cut the list.
 *
 * Status codes come straight from the backend RowStatus union:
 *   accepted · rejected_outlet · rejected_kpi · skipped_blank
 * ─────────────────────────────────────────────────────────────────────────── */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';

/** One row of the backend achievement-upload response. */
export interface AchievementReportRow {
  rowIndex:   number;
  outletCode: string;
  status:     string;
  remarks:    string;
}

/** Human-friendly label for each backend RowStatus value. */
const STATUS_LABEL: Record<string, string> = {
  accepted:        'Saved (some values ignored)',
  rejected_outlet: 'Rejected — unknown outlet',
  rejected_kpi:    'Rejected — KPI',
  skipped_blank:   'Skipped — blank',
};

export interface AchievementReportSummary {
  month?: string;
  total: number;
  saved: number;
  skippedBlank: number;
  rejected: number;
  /** Saved rows where some values were ignored (warning rows). */
  partlyIgnored: number;
}

export interface AchievementReportOptions {
  summary?: AchievementReportSummary;
  /** Per-kind cut: problem = rejected rows, warning = partly-ignored rows. */
  problem?: { shown: number; total: number; truncated: boolean };
  warning?: { shown: number; total: number; truncated: boolean };
}

/** Plain lines that explain a cut list (empty when nothing was cut). */
export function achievementTruncationLines(opts: AchievementReportOptions): string[] {
  const lines: string[] = [];
  if (opts.problem?.truncated) {
    lines.push(`Showing the first ${opts.problem.shown.toLocaleString('en-IN')} of ${opts.problem.total.toLocaleString('en-IN')} rejected rows.`);
  }
  if (opts.warning?.truncated) {
    lines.push(`Showing the first ${opts.warning.shown.toLocaleString('en-IN')} of ${opts.warning.total.toLocaleString('en-IN')} partly-ignored rows.`);
  }
  if (lines.length) lines.push('Fix these, then re-upload only those rows — the next upload lists any that are left.');
  return lines;
}

/** Build the problem-rows workbook (Summary + Problem Rows). Returns an ArrayBuffer. */
export function buildAchievementReportBuffer(
  rows: AchievementReportRow[],
  opts: AchievementReportOptions = {},
): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const cut = achievementTruncationLines(opts);

  if (opts.summary) {
    const s = opts.summary;
    const summary: (string | number)[][] = [
      ['Item', 'Count'],
      ...(s.month ? [['Month', s.month] as (string | number)[]] : []),
      ['Rows in file', s.total],
      ['Saved', s.saved],
      ['Skipped (blank)', s.skippedBlank],
      ['Rejected', s.rejected],
      ['Saved with some values ignored', s.partlyIgnored],
      [],
      ['This file lists only the rows that need attention (rejected or partly ignored). Saved rows are counted above, not listed.'],
      ...cut.map((l) => [l]),
    ];
    const ws = aoaToSheetSafe(summary);
    ws['!cols'] = [{ wch: 40 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Summary');
  }

  const headerRow = ['Row #', 'Outlet ID', 'Status', 'Remarks'];
  const dataRows = rows.map((r) => [
    r.rowIndex,
    r.outletCode,
    STATUS_LABEL[r.status] ?? r.status,
    r.remarks ?? '',
  ]);
  const footer = cut.length ? [[], ...cut.map((l) => [l])] : [];
  const ws = aoaToSheetSafe([headerRow, ...dataRows, ...footer]);
  ws['!cols'] = [{ wch: 8 }, { wch: 18 }, { wch: 28 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Problem Rows');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array;
  if (out instanceof ArrayBuffer) return out;
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  return ab;
}
