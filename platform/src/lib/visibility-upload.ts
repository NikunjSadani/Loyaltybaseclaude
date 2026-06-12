/**
 * Outlet Visibility Upload — shared types, helpers, and API client.
 *
 * Handles the admin Excel-upload visibility workflow (distinct from the
 * partner in-app photo-capture flow in lib/visibility.ts).
 *
 * Monthly cycle: each YYYY-MM is independent — no carry-forward between months.
 * Eligible outlet types: SSS and SSS_TOT (SSS TOT).
 */

import * as XLSX from 'xlsx';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OutletVisibilityStatus = 'PENDING' | 'UNDER_REVIEW' | 'APPROVED';

export interface VisibilityStatusData {
  status:                 OutletVisibilityStatus;
  dateOfCapture:          string | null;
  approvedBy:             string | null;
  capturedByEmployeeName: string | null;
}

/** Map of outletCode → visibility status data for a given month */
export type VisibilityStatusMap = Record<string, VisibilityStatusData>;

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Outlet type codes that are eligible for visibility tracking.
 * Only cards for these types show the visibility status badge.
 */
export const VISIBILITY_ELIGIBLE_OUTLET_TYPES: readonly string[] = ['SSS', 'SSS_TOT'] as const;

/**
 * Exact column headers required in the upload Excel file.
 * Parsed case-insensitively on the server; presented verbatim in the template.
 */
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

export type VisibilityUploadHeader = (typeof VISIBILITY_UPLOAD_HEADERS)[number];

// ─── Status parser ────────────────────────────────────────────────────────────

/**
 * Normalise a free-text status string to the canonical OutletVisibilityStatus.
 * Accepts any casing, spaces, hyphens, or underscores as separators.
 * Returns null when the value is not recognised.
 *
 * Examples:
 *   'PENDING'       → 'PENDING'
 *   'pending'       → 'PENDING'
 *   'Under Review'  → 'UNDER_REVIEW'
 *   'under-review'  → 'UNDER_REVIEW'
 *   'APPROVED'      → 'APPROVED'
 *   'Approvd'       → null  (typo — returned to caller as an error row)
 */
export function parseVisibilityStatus(input: string): OutletVisibilityStatus | null {
  const normalised = input.trim().toUpperCase().replace(/[\s\-]+/g, '_');
  if (normalised === 'PENDING')      return 'PENDING';
  if (normalised === 'UNDER_REVIEW') return 'UNDER_REVIEW';
  if (normalised === 'APPROVED')     return 'APPROVED';
  return null;
}

// ─── Date parser ──────────────────────────────────────────────────────────────

/**
 * Parse a date value from an Excel cell.
 *
 * Handles:
 *  • DD-MM-YYYY and DD/MM/YYYY strings (as per the client's SFA export format)
 *  • Excel serial date numbers (days since Dec 30 1899 — Lotus 1-2-3 epoch)
 *  • Native Date objects (pass-through)
 *
 * Returns null for empty / null / unrecognised inputs.
 */
export function parseExcelDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  // Excel serial number — days from Dec 30 1899 (25569 days before Unix epoch)
  if (typeof value === 'number') {
    const utcMs = (value - 25569) * 86400 * 1000;
    const date  = new Date(utcMs);
    return isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    // DD-MM-YYYY  or  DD/MM/YYYY  (1 or 2 digit day/month)
    const match = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (match) {
      const [, dd, mm, yyyy] = match;
      const date = new Date(
        parseInt(yyyy, 10),
        parseInt(mm,   10) - 1,
        parseInt(dd,   10),
      );
      return isNaN(date.getTime()) ? null : date;
    }
  }

  return null;
}

// ─── Auth helper (client-side only) ──────────────────────────────────────────

function authHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── API client ───────────────────────────────────────────────────────────────

/**
 * Fetch the visibility status for a list of outlet codes for a given month.
 * Returns an empty map on error or when the API is unavailable.
 *
 * @param outletCodes  Array of outletCode strings (matching Outlet.outletCode in DB)
 * @param month        YYYY-MM string
 */
export async function fetchOutletVisibilityStatuses(
  outletCodes: string[],
  month: string,
): Promise<VisibilityStatusMap> {
  if (outletCodes.length === 0) return {};
  try {
    const params = new URLSearchParams({
      outletCodes: outletCodes.join(','),
      month,
    });
    const res = await fetch(`/api/visibility/outlet-statuses?${params}`, {
      headers: { ...authHeader() },
    });
    if (!res.ok) return {};
    const json = await res.json();
    return (json.data as VisibilityStatusMap) ?? {};
  } catch {
    return {};
  }
}

// ─── Template generator ───────────────────────────────────────────────────────

/**
 * Generate a downloadable .xlsx upload template with the required column
 * headers and one example row.  Called client-side (button click).
 */
export function generateVisibilityTemplate(): Uint8Array {
  const headers: string[] = [...VISIBILITY_UPLOAD_HEADERS];

  // Example row so users understand the expected format
  const example: string[] = [
    'OUT-MH-2841',   // outlet_id              — must match Outlet.outletCode exactly
    '2026-06',       // month                  — YYYY-MM
    'PENDING',       // status                 — PENDING | UNDER_REVIEW | APPROVED
    '15-06-2026',    // date_of_capture        — DD-MM-YYYY (leave blank if PENDING)
    'Amit Singh',    // approved_by
    'EMP-001',       // captured_by_employee_id
    'Ravi Kumar',    // captured_by_employee_name
    '9876543210',    // captured_by_employee_phone
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, example]);

  // Generous column widths for readability
  ws['!cols'] = headers.map((h) => ({
    wch: h === 'captured_by_employee_name' ? 30 : h.length + 6,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Visibility Upload');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
}

// ─── Demo data ────────────────────────────────────────────────────────────────

/**
 * Sample visibility map for demo/dev mode so the badge renders on sales pages
 * even before real DB records exist.
 * Keys match the demo outletCodes assigned in sales/outlets/page.tsx.
 */
export const DEMO_VISIBILITY_MAP: VisibilityStatusMap = {
  'OUT-MH-2841': { status: 'APPROVED',     dateOfCapture: '2026-06-01', approvedBy: 'Amit Singh', capturedByEmployeeName: 'Ravi Kumar'  },
  'OUT-MH-2843': { status: 'UNDER_REVIEW', dateOfCapture: '2026-06-08', approvedBy: null,         capturedByEmployeeName: 'Vijay Sharma' },
  'OUT-MH-2847': { status: 'PENDING',      dateOfCapture: null,         approvedBy: null,         capturedByEmployeeName: null          },
  'OUT-MH-2850': { status: 'APPROVED',     dateOfCapture: '2026-06-03', approvedBy: 'Riya Patel', capturedByEmployeeName: 'Suresh Nair' },
  'OUT-MH-2852': { status: 'PENDING',      dateOfCapture: null,         approvedBy: null,         capturedByEmployeeName: null          },
};

/**
 * Sample visibility map keyed by the task-page demo outletCodes.
 */
export const DEMO_TASK_VISIBILITY_MAP: VisibilityStatusMap = {
  'OUT-TASK-001': { status: 'APPROVED',     dateOfCapture: '2026-06-01', approvedBy: 'Admin', capturedByEmployeeName: 'Ravi'  },
  'OUT-TASK-003': { status: 'UNDER_REVIEW', dateOfCapture: '2026-06-07', approvedBy: null,    capturedByEmployeeName: 'Deepa' },
  // Outlets OUT-TASK-002, OUT-TASK-006, OUT-TASK-008, OUT-TASK-009 have no record
  // → they appear as "Visibility Pending" tasks in the sales tasks page
};
