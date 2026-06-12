/**
 * Sales upload utility functions — shared between admin (write) and partner dashboard (read).
 *
 * localStorage key is tenant-agnostic for the demo (single tenant per browser session).
 * In production this would be scoped by tenant via the API.
 */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const LAST_UPLOAD_KEY = 'loyaltybase_last_sales_upload';

/**
 * Formats a sales-data upload timestamp into "Last updated on D Mon".
 *
 * Returns:
 *   "Last updated on 7 Jun"       — same year
 *   "Last updated on 7 Jun 2025"  — prior year
 *   ""                            — null / undefined / invalid
 */
export function formatLastUpdated(date: Date | string | null | undefined): string {
  if (date == null) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';

  const day   = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const year  = d.getUTCFullYear();

  const currentYear = new Date().getUTCFullYear();
  return year === currentYear
    ? `Last updated on ${day} ${month}`
    : `Last updated on ${day} ${month} ${year}`;
}

/** Persists the most recent sales-data upload ISO timestamp for the current tenant. */
export function setLastSalesUploadDate(isoDate: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LAST_UPLOAD_KEY, isoDate);
}

/**
 * Returns the ISO timestamp of the last sales-data upload, or null if none recorded.
 * The partner dashboard reads this to show "Last updated on …" in the hero card.
 */
export function getLastSalesUploadDate(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(LAST_UPLOAD_KEY);
}
