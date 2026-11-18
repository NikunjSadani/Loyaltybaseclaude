/**
 * Usage Report (/admin/reports/usage) — response types + pure helpers (kept out of page.tsx: a Next page file may
 * only export its component). API: GET /v1/reports/usage (api/src/reports/usage/usage-report.ts).
 */

// ─── Types (mirror GET /v1/reports/usage) ─────────────────────────────────────

export interface UsageRow {
  userId: string
  name: string
  phone: string
  role: string
  status: string
  programmes: string[]
  regions: string[]
  daysActive: number
  trackedDays: number
  visits: number
  minutes: number
  avgMinutesPerDay: number | null
  appDays: number
  browserDays: number
  phoneDays: number
  computerDays: number
  device: string
  firstSeenAt: string | null
  lastSeenAt: string | null
}

export interface UsageTotals {
  /** Enabled accounts in the filters + deactivated/suspended accounts that were active in the range. */
  usersInScope: number
  usersActive: number
  /** Enabled accounts with no activity in the range. */
  usersInactive: number
  /** Deactivated / suspended accounts with no activity — not counted above. */
  disabledAccountsExcluded: number
  avgDaysActive: number | null
  totalMinutes: number
  /** Users with ≥ 1 tracked (post-ship) day — the base of the minutes average. */
  usersTracked: number
  avgMinutesPerTrackedUser: number | null
  appUsers: number
  browserUsers: number
  phoneUsers: number
  computerUsers: number
}

export interface UsageReportPage {
  generatedAt: string
  range: { from: string; to: string; days: number }
  trackingStartedOn: string | null
  notes: { duration: string; region: string }
  filters: { roles: string[]; programs: string[]; regions: string[] }
  totals: UsageTotals
  page: number
  pageSize: number
  pageCount: number
  totalRows: number
  rows: UsageRow[]
}

export type UsageSort = 'minutes' | 'days' | 'lastSeen' | 'name'

export interface UsageFilters {
  from: string
  to: string
  role: string
  program: string
  region: string
  sort: UsageSort
  includeInactive: boolean
}

export const USAGE_PAGE_SIZE = 50
export const USAGE_MAX_RANGE_DAYS = 366
export const USAGE_ENDPOINT = '/api/reports/usage'
/** The server's 404 text when an export matches nobody (export kind 'usage-report'). */
export const USAGE_NO_MATCH_RE = /matched these filters/i

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Today's IST calendar date, and the date `days − 1` before it (YYYY-MM-DD). */
export function defaultIstRange(now: Date = new Date(), days = 30): { from: string; to: string } {
  const ist = new Date(now.getTime() + 330 * 60_000)
  const to = ist.toISOString().slice(0, 10)
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  return { from, to }
}

/** A plain-English problem with the chosen dates, or null when they are fine (checked before any request). */
export function rangeProblem(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both a start and an end date.'
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 'Choose valid dates.'
  if (a > b) return 'The start date must be on or before the end date.'
  if ((b - a) / 86_400_000 + 1 > USAGE_MAX_RANGE_DAYS) return `Choose at most ${USAGE_MAX_RANGE_DAYS} days.`
  return null
}

/** The query string for the JSON page or the Excel export (only the chosen filters). */
export function usageQuery(f: UsageFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ from: f.from, to: f.to })
  if (f.role) q.set('role', f.role)
  if (f.program) q.set('program', f.program)
  if (f.region) q.set('region', f.region)
  if (f.sort !== 'minutes') q.set('sort', f.sort)
  if (f.includeInactive) q.set('includeInactive', 'true')
  for (const [k, v] of Object.entries(extra)) q.set(k, v)
  return q.toString()
}

