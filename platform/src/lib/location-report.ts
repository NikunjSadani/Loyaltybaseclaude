/**
 * Location-compliance report (/admin/reports/location) — response types + pure helpers (kept out of page.tsx: a Next
 * page file may only export its component). API: GET /v1/reports/location-compliance
 * (api/src/reports/location/location-compliance-report.ts). Date helpers are shared with the Usage report.
 */
export { defaultIstRange, rangeProblem } from './usage-report'

export interface LocationRow {
  userId: string
  name: string
  phone: string
  role: string
  regions: string[]
  kycs: number
  visibilityCaptures: number
  noGps: number
  poorAccuracy: number
  unverifiable: number
  blockedOutside: number
  medianAccuracyM: number | null
  medianLockMs: number | null
}

export interface LocationTotals extends Omit<LocationRow, 'userId' | 'name' | 'phone' | 'role' | 'regions'> {
  reps: number
}

export interface LocationReportPage {
  generatedAt: string
  range: { from: string; to: string; days: number }
  setting: { requireLocation: boolean; fenceOn: boolean; outletMasterFence: boolean }
  notes: { sources: string; accuracy: string; unverifiable: string; blocked: string; lock: string; region: string }
  filters: { roles: string[]; regions: string[] }
  totals: LocationTotals
  page: number
  pageSize: number
  pageCount: number
  totalRows: number
  rows: LocationRow[]
}

export type LocationSort = 'issues' | 'captures' | 'name'

export interface LocationFilters {
  from: string
  to: string
  role: string
  region: string
  sort: LocationSort
}

export const LOCATION_PAGE_SIZE = 50
export const LOCATION_DEBOUNCE_MS = 400
export const LOCATION_ENDPOINT = '/api/reports/location-compliance'
/** The server's 404 text when an export matches nobody (export kind 'location-compliance'). */
export const LOCATION_NO_MATCH_RE = /matched these filters/i

/** The query string for the JSON page or the Excel export (only the chosen filters). */
export function locationQuery(f: LocationFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ from: f.from, to: f.to })
  if (f.role) q.set('role', f.role)
  if (f.region) q.set('region', f.region)
  if (f.sort !== 'issues') q.set('sort', f.sort)
  for (const [k, v] of Object.entries(extra)) q.set(k, v)
  return q.toString()
}

/** ms → "2.1 s" (one decimal) or "—". */
export function fmtLockSeconds(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return `${(Math.round(ms / 100) / 10).toLocaleString('en-IN', { maximumFractionDigits: 1 })} s`
}
