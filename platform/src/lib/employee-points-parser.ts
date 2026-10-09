/**
 * Employee Rewards Phase C — Points Upload Parser (pure)
 *
 * The EMPLOYEE mirror of `credits-payouts-parser.ts`, but POINTS-ONLY and ONE ROW PER EMPLOYEE
 * (keyed by Employee Code). Parses the xlsx produced by `generateEmployeePointsTemplate`, validates
 * each row, and returns an EmployeeParseResult for the dry-run preview. The server (confirmEmployeeBatch)
 * is the authoritative validator (it re-resolves each employeeCode → SalesUser and skips-with-reason);
 * this client pass is a fail-fast UX pre-flight.
 *
 * Validation per row:
 *  1. Blank Employee Code → ignored (blank spreadsheet row).
 *  2. Points blank or 0 AND no Target Points → SKIP (nothing to credit, no target to set).
 *  3. Employee Code not in the known roster → ERROR  (ONLY when a roster is supplied; if the roster
 *     is unavailable we defer entirely to the server's EMPLOYEE_NOT_FOUND skip — see knownCodes=null).
 *  4. Points not a valid number / negative / NON-integer (points are a whole count; the API is @IsInt)
 *     / exceeds the points safety cap → ERROR.
 *  5. Duplicate Employee Code in the same upload → ERROR on the second occurrence.
 *  6. Target Points (OPTIONAL trailing column): blank/absent → no target (undefined). If present it
 *     must be a non-negative whole number (same numeric rules as Points: negative/decimal/NaN → ERROR).
 *     A TARGET-ONLY row (valid Target Points, Points blank/0) is VALID (status OK) — it sets a target
 *     and credits nothing — so it is NOT skipped and NOT dropped; it rides to the server to upsert.
 *
 * Expected sheet: row 0 = title (skipped), row 1 = headers, row 2+ = data.
 */

import * as XLSX from 'xlsx';
import { EMPLOYEE_POINTS_HEADERS } from './employee-points-template';

export interface EmployeePointsRow {
  rowNum: number;
  employeeCode: string;
  employeeName: string;
  points: number;
  narration: string;
  /** Optional per-row target (whole, non-negative). undefined when the Target Points cell is blank/absent. */
  targetPoints?: number;
  status: 'OK' | 'ERROR' | 'SKIP';
  errors: string[];
  skipReason?: string;
}

export interface EmployeeParseResult {
  headerError: string | null;
  rows: EmployeePointsRow[];
  hasErrors: boolean;
  canProceed: boolean;
  summary: { total: number; ok: number; skipped: number; errors: number; totalPoints: number; targetsSet: number };
}

export interface ParseEmployeePointsOpts {
  /** Known roster employee codes for pre-flight validation; pass `null` when the roster is
   *  unavailable so unknown-code validation is SKIPPED (the server still validates at confirm). */
  knownCodes: Set<string> | null;
  safetyCapPoints: number;
}

const empty = (headerError: string | null): EmployeeParseResult => ({
  headerError,
  rows: [],
  hasErrors: false,
  canProceed: false,
  summary: { total: 0, ok: 0, skipped: 0, errors: 0, totalPoints: 0, targetsSet: 0 },
});

export function parseEmployeePointsUpload(
  buffer: ArrayBuffer,
  opts: ParseEmployeePointsOpts,
): EmployeeParseResult {
  const { knownCodes, safetyCapPoints } = opts;

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'array' });
  } catch {
    return empty('Could not read the uploaded file. Please upload a valid .xlsx file.');
  }

  const sheetName = wb.SheetNames[0];
  if (!sheetName) return empty('The uploaded file has no sheets.');

  const ws = wb.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: '' }) as (string | number)[][];
  if (allRows.length < 2) return empty('The file has no header row.');

  const headerRow = allRows[1].map((h) => String(h).trim());
  const codeIdx = headerRow.indexOf(EMPLOYEE_POINTS_HEADERS[0]); // 'Employee Code'
  const nameIdx = headerRow.indexOf(EMPLOYEE_POINTS_HEADERS[1]); // 'Employee Name'
  const pointsIdx = headerRow.indexOf(EMPLOYEE_POINTS_HEADERS[2]); // 'Points'
  const narrIdx = headerRow.indexOf(EMPLOYEE_POINTS_HEADERS[3]); // 'Narration'
  const targetIdx = headerRow.indexOf(EMPLOYEE_POINTS_HEADERS[4]); // 'Target Points' (OPTIONAL trailing col)

  if (codeIdx === -1) return empty('Missing "Employee Code" column. Please use the official template.');
  if (pointsIdx === -1) return empty('Missing "Points" column. Please use the official template.');

  const seen = new Set<string>();
  const rows: EmployeePointsRow[] = [];
  let totalPoints = 0;

  for (let rIdx = 2; rIdx < allRows.length; rIdx++) {
    const row = allRows[rIdx];
    const employeeCode = String(row[codeIdx] ?? '').trim();
    if (!employeeCode) continue; // blank spreadsheet row

    const employeeName = nameIdx !== -1 ? String(row[nameIdx] ?? '').trim() : '';
    const narration = narrIdx !== -1 ? String(row[narrIdx] ?? '').trim() : '';
    const rawVal = String(row[pointsIdx] ?? '').trim();
    const numVal = Number(rawVal.replace(/,/g, ''));

    // Optional Target Points (trailing column). Blank/absent → no target. CATCH a parsed zero so a
    // "0" target is treated as "no target" (nothing to upsert), consistent with Points.
    const rawTarget = targetIdx !== -1 ? String(row[targetIdx] ?? '').trim() : '';
    const targetNum = Number(rawTarget.replace(/,/g, ''));
    const hasTarget = rawTarget !== '' && !(!isNaN(targetNum) && targetNum === 0);

    // Points blank or ZERO — nothing to credit. Catch a parsed zero (e.g. '0', '0.0', '0.00', 0) — NOT
    // just the literal string '0' — so a "0.0" cell isn't silently accepted as an OK row of 0 points
    // that the server then drops with no reason (FE audit #4).
    const pointsBlankOrZero = rawVal === '' || (!isNaN(numVal) && numVal === 0);

    // SKIP only when there is NOTHING to do: no points AND no target. A target-only row (Target set,
    // Points blank/0) is a VALID row that sets a target and credits nothing — it must NOT be skipped.
    if (pointsBlankOrZero && !hasTarget) {
      rows.push({
        rowNum: rIdx + 1,
        employeeCode,
        employeeName,
        points: 0,
        narration,
        status: 'SKIP',
        errors: [],
        skipReason: 'Points are blank or zero — nothing to credit for this employee.',
      });
      continue;
    }

    const errors: string[] = [];

    // Unknown employee — ONLY when a roster is supplied (else defer to the server's skip-with-reason).
    if (knownCodes && !knownCodes.has(employeeCode)) {
      errors.push(`Employee Code "${employeeCode}" is not in the active roster.`);
    }

    // Points validation — only when points are actually present (a target-only row leaves Points
    // blank/0 and is NOT validated as an amount; it simply credits nothing).
    if (!pointsBlankOrZero) {
      if (isNaN(numVal)) {
        errors.push(`Points "${rawVal}" is not a valid number.`);
      } else {
        if (numVal < 0) errors.push(`Points cannot be negative (got ${numVal}).`);
        if (!Number.isInteger(numVal)) errors.push(`Points must be a whole number (got ${numVal}).`);
        if (numVal > safetyCapPoints) {
          errors.push(`Points ${numVal} exceed the safety cap of ${safetyCapPoints.toLocaleString('en-IN')}.`);
        }
      }
    }

    // Target Points validation — same numeric rules as Points (non-negative whole number). Only runs
    // when a target is present; a valid target is carried onto the row (undefined otherwise).
    let targetPoints: number | undefined;
    if (hasTarget) {
      if (isNaN(targetNum)) {
        errors.push(`Target Points "${rawTarget}" is not a valid number.`);
      } else {
        if (targetNum < 0) errors.push(`Target Points cannot be negative (got ${targetNum}).`);
        if (!Number.isInteger(targetNum)) errors.push(`Target Points must be a whole number (got ${targetNum}).`);
        if (targetNum >= 0 && Number.isInteger(targetNum)) targetPoints = targetNum;
      }
    }

    // Duplicate employee code in this upload (only register the dedup key once the row is otherwise
    // clean). CASE-SENSITIVE to match the server resolver + the @@unique([clientId, employeeCode])
    // (FE audit #7): "EMP01" and "emp01" are DISTINCT employees, so neither should be flagged a dup.
    const key = employeeCode;
    if (seen.has(key)) {
      errors.push(`Duplicate entry: Employee "${employeeCode}" appears more than once in this upload.`);
    } else if (errors.length === 0) {
      seen.add(key);
    }

    // A target-only row leaves Points blank/0 → points 0 (credits nothing); a bad numeric points
    // cell also resolves to 0 but will have raised an error above.
    const points = pointsBlankOrZero || isNaN(numVal) ? 0 : numVal;
    const status: 'OK' | 'ERROR' = errors.length > 0 ? 'ERROR' : 'OK';
    if (status === 'OK') totalPoints += points;
    // Only carry a target onto a row that is otherwise OK (a target on an ERROR row isn't upserted).
    const rowTarget = status === 'OK' ? targetPoints : undefined;

    rows.push({
      rowNum: rIdx + 1,
      employeeCode,
      employeeName,
      points,
      narration,
      status,
      errors,
      ...(rowTarget !== undefined ? { targetPoints: rowTarget } : {}),
    });
  }

  const okCount = rows.filter((r) => r.status === 'OK').length;
  const skippedCount = rows.filter((r) => r.status === 'SKIP').length;
  const errorCount = rows.filter((r) => r.status === 'ERROR').length;
  const targetsSet = rows.filter((r) => r.targetPoints !== undefined).length;
  const hasErrors = errorCount > 0;

  return {
    headerError: null,
    rows,
    hasErrors,
    canProceed: !hasErrors && okCount > 0,
    summary: { total: okCount + errorCount, ok: okCount, skipped: skippedCount, errors: errorCount, totalPoints, targetsSet },
  };
}

/**
 * Map parsed rows → the API UploadRowDto[] shape the employee batch endpoint expects. Points are
 * whole counts (NOT paise). `outletId` is set to the employeeCode so the server resolves it even
 * though `employeeCode` is also sent (confirm uses `employeeCode ?? outletId`). Only OK + SKIP rows
 * are sent (the caller gates confirm on canProceed, so there are no ERROR rows); SKIP rows carry
 * amount 0 and are naturally filtered server-side.
 */
export function toEmployeeUploadRows(rows: EmployeePointsRow[]): Array<{
  rowNum: number;
  outletId: string;
  outletName: string;
  employeeCode: string;
  fieldId: string;
  fieldName: string;
  amount: number;
  narration: string;
  awardType: 'POINTS';
  targetPoints?: number;
  status: 'OK' | 'ERROR' | 'SKIP';
  errors: string[];
  skipReason?: string;
}> {
  return rows.map((r) => ({
    rowNum: r.rowNum,
    outletId: r.employeeCode,
    outletName: r.employeeName || r.employeeCode,
    employeeCode: r.employeeCode,
    fieldId: 'POINTS',
    fieldName: 'Points',
    amount: r.points,
    narration: r.narration,
    awardType: 'POINTS' as const,
    // Optional per-row target rides along to the server (upserted even on a target-only row).
    ...(r.targetPoints !== undefined ? { targetPoints: r.targetPoints } : {}),
    status: r.status,
    errors: r.errors,
    ...(r.skipReason ? { skipReason: r.skipReason } : {}),
  }));
}
