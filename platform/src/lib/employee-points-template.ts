/**
 * Employee Rewards Phase C — Points Upload Excel Template Generator (pure)
 *
 * The EMPLOYEE mirror of `credits-payouts-template.ts`, but POINTS-ONLY and ONE ROW PER
 * EMPLOYEE (keyed by Employee Code), per ADMIN-DESIGN §5.2 ("bulk-upload point credits —
 * one row per employee, keyed by Employee Code"). There is NO field matrix, no payout/paise,
 * no outlet-type award logic — the employee earn side is a flat points credit.
 *
 * Column layout:
 *   Employee Code | Employee Name | Points | Narration | Target Points
 *
 * - Employee Code + Name are pre-filled from the active roster (caller passes them from
 *   /api/admin/sales-users/options). Points + Narration + Target Points are left blank for the
 *   admin to fill. Target Points is OPTIONAL (a trailing column) — blank/absent means no target.
 * - If the roster is unavailable, a header-only template is produced (the admin fills codes).
 *
 * Sheet name: "Employee Points". Title row: "Employee Points — {Month Label}".
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';

export interface TemplateEmployee {
  employeeCode: string;
  name: string;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

export const EMPLOYEE_POINTS_HEADERS = ['Employee Code', 'Employee Name', 'Points', 'Narration', 'Target Points'] as const;

/**
 * Generates the employee points upload template buffer.
 *
 * @param employees Active roster (from /api/admin/sales-users/options → managers). May be empty.
 * @param month     'YYYY-MM' — shown in the title row.
 */
export function generateEmployeePointsTemplate(
  employees: TemplateEmployee[],
  month: string,
): ArrayBuffer {
  const headers = [...EMPLOYEE_POINTS_HEADERS];

  // One row per employee, Points + Narration + Target Points blank (ready for the admin to fill).
  const dataRows = employees.map((e) => [e.employeeCode, e.name, '', '', '']);

  const wsData: (string | number)[][] = [
    [`Employee Points — ${monthLabel(month)}`],
    headers,
    ...dataRows,
  ];

  const ws = aoaToSheetSafe(wsData);
  ws['!freeze'] = { xSplit: 0, ySplit: 2 };
  ws['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 30 }, { wch: 14 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employee Points');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
