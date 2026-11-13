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
