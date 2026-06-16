/**
 * Visibility upload helpers — ported locally from the platform's
 * `@/lib/visibility-upload.ts` (only the server-side parsing bits needed by the
 * bulk-upload route; the client-side fetch / template / demo-map exports are
 * intentionally NOT ported).
 */

import { OutletVisibilityStatus } from '@prisma/client';

/** Exact column headers required in the upload Excel file (case-insensitive). */
export const VISIBILITY_UPLOAD_HEADERS = [
  'outlet_id',
  'month',
  'status',
  'date_of_capture',
  'approved_by',
  'captured_by_employee_id',
  'captured_by_employee_name',
  'captured_by_employee_phone',
] as const;

/**
 * Normalise a free-text status string to the canonical OutletVisibilityStatus.
 * Accepts any casing, spaces, hyphens, or underscores. Returns null when
 * unrecognised.
 */
export function parseVisibilityStatus(input: string): OutletVisibilityStatus | null {
  const normalised = input.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalised === 'PENDING') return OutletVisibilityStatus.PENDING;
  if (normalised === 'UNDER_REVIEW') return OutletVisibilityStatus.UNDER_REVIEW;
  if (normalised === 'APPROVED') return OutletVisibilityStatus.APPROVED;
  return null;
}

/**
 * Parse a date value from an Excel cell — handles DD-MM-YYYY / DD/MM/YYYY
 * strings, Excel serial numbers, and native Dates. Returns null for empty /
 * unrecognised inputs.
 */
export function parseExcelDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const utcMs = (value - 25569) * 86400 * 1000;
    const date = new Date(utcMs);
    return isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (match) {
      const [, dd, mm, yyyy] = match;
      const date = new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
      return isNaN(date.getTime()) ? null : date;
    }
  }

  return null;
}
