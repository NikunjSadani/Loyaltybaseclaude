/* ─── Achievement Upload Report ───────────────────────────────────────────────
 *
 * Builds a downloadable .xlsx status report from the AUTHORITATIVE backend
 * upload response. Memory-safety (2026-11-13): the backend returns only the rows
 * to act on — rejected rows + saved rows with an ignored-value remark — each capped
 * at 500; saved rows are counted, not echoed. Each row carries: rowIndex,
 * outletCode, status, remarks.
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
  accepted:        'Saved',
  rejected_outlet: 'Rejected — unknown outlet',
  rejected_kpi:    'Rejected — KPI',
  skipped_blank:   'Skipped — blank',
};

/**
 * Build an xlsx upload-status report from the backend response rows.
 * Returns an ArrayBuffer so it can be wrapped in a Blob and downloaded.
 */
export function buildAchievementReportBuffer(
  rows: AchievementReportRow[],
  opts?: { truncated?: boolean; totals?: { problem: number; warning: number } },
): ArrayBuffer {
  const headerRow = ['Row #', 'Outlet ID', 'Status', 'Remarks'];

  const dataRows = rows.map((r) => [
    r.rowIndex,
    r.outletCode,
    STATUS_LABEL[r.status] ?? r.status,
    r.remarks ?? '',
  ]);

  const footer = opts?.truncated
    ? [[], [`Showing the first 500 rows of each kind — ${opts.totals?.problem ?? 0} rejected and ${opts.totals?.warning ?? 0} partly-ignored rows in the file. Fix these and re-upload to see the rest.`]]
    : [];
  const ws = aoaToSheetSafe([headerRow, ...dataRows, ...footer]);
  ws['!cols'] = [{ wch: 8 }, { wch: 18 }, { wch: 24 }, { wch: 60 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Upload Report');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
