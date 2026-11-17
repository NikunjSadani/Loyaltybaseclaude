/**
 * Target / achievement upload responses (memory-safety 2026-11-13): the API returns only the
 * REJECTED rows (`problemRows`) and the saved rows carrying an ignored-value remark
 * (`warningRows`), each capped at 500 with the true totals — not every parsed row.
 *
 * `normalizeRowsEcho` makes a screen safe against an older API build that still sends
 * `rows` (front-end and API deploy separately), and against a missing list.
 */
export interface EchoRow {
  rowIndex: number;
  outletCode?: string;
  status: string;
  remarks?: string;
}

export interface RowsEcho<R extends EchoRow> {
  problemRows: R[];
  problemRowCount: number;
  problemRowsTruncated: boolean;
  warningRows: R[];
  warningRowCount: number;
  warningRowsTruncated: boolean;
  skippedBlankCount?: number;
}

const REJECTED = new Set(['rejected_outlet', 'rejected_kpi', 'rejected', 'error']);

export function normalizeRowsEcho<R extends EchoRow, T extends Partial<RowsEcho<R>> & { rows?: R[] }>(
  data: T,
): Omit<T, 'rows'> & RowsEcho<R> {
  const { rows, ...rest } = data;
  if (!data.problemRows && Array.isArray(rows)) {
    // Older API build: derive the same split from the full echo.
    const problemRows = rows.filter((r) => REJECTED.has(r.status));
    const warningRows = rows.filter((r) => !REJECTED.has(r.status) && /not applicable/i.test(r.remarks ?? ''));
    return {
      ...rest,
      problemRows,
      problemRowCount: problemRows.length,
      problemRowsTruncated: false,
      warningRows,
      warningRowCount: warningRows.length,
      warningRowsTruncated: false,
      skippedBlankCount: rows.filter((r) => r.status === 'skipped_blank').length,
    };
  }
  const problemRows = data.problemRows ?? [];
  const warningRows = data.warningRows ?? [];
  return {
    ...rest,
    problemRows,
    problemRowCount: data.problemRowCount ?? problemRows.length,
    problemRowsTruncated: data.problemRowsTruncated ?? false,
    warningRows,
    warningRowCount: data.warningRowCount ?? warningRows.length,
    warningRowsTruncated: data.warningRowsTruncated ?? false,
  };
}
