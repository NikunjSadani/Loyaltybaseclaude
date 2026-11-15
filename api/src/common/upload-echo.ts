/**
 * Upload responses stop echoing every parsed row (memory-safety, 2026-11-13).
 *
 * Spreadsheet uploads used to return `rows: <every parsed row>` (~1.8 MB of JSON for a
 * 6,500-row target file) — built, serialised and buffered while the upload's own parse
 * state was still live. A response now carries the counts/summary fields it already had
 * plus ONLY the rows the operator must act on (rejected / warning rows), capped at
 * {@link UPLOAD_ECHO_MAX_ROWS}, with a flag saying the list was cut. The operator still
 * sees every problem row up to the cap and the true total in `problemRowCount`.
 *
 * Wire shape (spread into the upload response):
 *   problemRows:          T[]      — the first ≤ cap problem rows, in file order
 *   problemRowCount:      number   — how many problem rows the file had in total
 *   problemRowsTruncated: boolean  — true when problemRowCount > problemRows.length
 */
export const UPLOAD_ECHO_MAX_ROWS = 500;

export interface ProblemRowsEcho<T> {
  problemRows: T[];
  problemRowCount: number;
  problemRowsTruncated: boolean;
}

export function problemRowsEcho<T>(
  rows: Iterable<T>,
  isProblem: (row: T) => boolean,
  max: number = UPLOAD_ECHO_MAX_ROWS,
): ProblemRowsEcho<T> {
  const problemRows: T[] = [];
  let problemRowCount = 0;
  for (const row of rows) {
    if (!isProblem(row)) continue;
    problemRowCount++;
    if (problemRows.length < max) problemRows.push(row);
  }
  return { problemRows, problemRowCount, problemRowsTruncated: problemRowCount > problemRows.length };
}

/**
 * Previews that precede an IRREVERSIBLE apply (UTR uploads → "Apply UTR Results" marks entries PAID / FAILED) must show
 * the operator EVERY row about to be applied — not only the problem rows. These keep the full parsed row list (OK rows
 * with outlet / UTR / payment date, SKIP rows with their notice, ERROR rows with their errors), in file order, bounded
 * by a generous cap so a pathological file can't balloon the response.
 *
 * Wire shape (spread into the preview's parseResult):
 *   rows:          T[]      — the first ≤ cap parsed rows (exactly the pre-2026-11-13 `rows`)
 *   rowCount:      number   — how many rows the file parsed to in total
 *   rowsTruncated: boolean  — true when rowCount > rows.length
 */
export const PREVIEW_FULL_ROWS_MAX = 20_000;

export interface FullRowsEcho<T> {
  rows: T[];
  rowCount: number;
  rowsTruncated: boolean;
}

export function fullRowsEcho<T>(rows: readonly T[], max: number = PREVIEW_FULL_ROWS_MAX): FullRowsEcho<T> {
  const kept = rows.length > max ? rows.slice(0, max) : [...rows];
  return { rows: kept, rowCount: rows.length, rowsTruncated: rows.length > kept.length };
}
