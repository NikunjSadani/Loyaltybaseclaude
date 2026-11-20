'use client'

/**
 * /admin/reports/usage — Usage Report (owner-approved 2026-11-18; docs/plans/USAGE-REPORT.md).
 *
 * Who used the app in an IST date range, HOW (installed app vs browser; phone vs computer) and for HOW LONG
 * (a minimum: first → last action per visit, a new visit after 30 minutes idle).
 *
 *   • GET /api/reports/usage?from&to&role&program&region&sort&includeInactive&page&pageSize → JSON (one page of
 *     rows + totals over the whole filtered population + dropdown catalogues + the tenant's tracking start date).
 *   • Export Excel → the same URL with format=xlsx (every filtered row; 200 saves, 202 → Downloads, 404 "0 users
 *     matched" shown as a neutral note).
 * Same access as the Session Report (route-permissions '/admin/reports' → reports:read; API roles + reports:read).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Info, RefreshCw, Users } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DownloadActionStatus } from '@/components/exports/download-action-status'
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action'
import {
  USAGE_ENDPOINT as ENDPOINT,
  USAGE_NO_MATCH_RE as NO_MATCH_RE,
  USAGE_DEBOUNCE_MS,
  USAGE_PAGE_SIZE as PAGE_SIZE,
  defaultIstRange,
  rangeProblem,
  usageQuery,
  type UsageFilters,
  type UsageReportPage as UsageData,
  type UsageSort as Sort,
} from '@/lib/usage-report'

// ─── Helpers ──────────────────────────────────────────────────────────────────


const fmtInt = (n: number) => n.toLocaleString('en-IN')
const fmtNum = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 1 }))
const roleLabel = (r: string) => r.replace(/_/g, ' ')

function fmtIstDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function fmtIstDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' })
}

function errorText(body: unknown, status: number): string {
  const e = (body as { error?: unknown; message?: unknown } | null)?.error ?? (body as { message?: unknown } | null)?.message
  if (Array.isArray(e)) return e.join(' ')
  if (typeof e === 'string' && e) return e
  return `Request failed (${status})`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function UsageReportPage() {
  const [filters, setFilters] = useState<UsageFilters>(() => ({
    ...defaultIstRange(),
    role: '',
    program: '',
    region: '',
    sort: 'minutes',
    includeInactive: false,
  }))
  const [page, setPage] = useState(1)
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [noMatch, setNoMatch] = useState(false)
  const reqSeq = useRef(0)
  const dl = useDownloadAction()

  const problem = useMemo(() => rangeProblem(filters.from, filters.to), [filters.from, filters.to])

  // ── Load (latest request wins — a superseded request is ABORTED, and a slow older response never overwrites
  //    a newer one) ──
  const abortRef = useRef<AbortController | null>(null)
  const load = useCallback(async (f: UsageFilters, p: number) => {
    const seq = ++reqSeq.current
    abortRef.current?.abort()
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${ENDPOINT}?${usageQuery(f, { page: String(p), pageSize: String(PAGE_SIZE) })}`,
        ctrl ? { signal: ctrl.signal } : undefined,
      )
      const body = await res.json().catch(() => null)
      if (seq !== reqSeq.current) return
      if (!res.ok) throw new Error(errorText(body, res.status))
      // JSON returns are wrapped in { success, data } (TransformInterceptor) — unwrap .data.
      setData((body as { data: UsageData }).data)
    } catch (e) {
      if (seq !== reqSeq.current) return // superseded (incl. our own abort) — the newer request owns the state
      setError(e instanceof Error ? e.message : 'Failed to load the report.')
      setData(null)
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  // Filter / date / page changes are DEBOUNCED (typing a date or flicking through dropdowns sends one request, not
  // one per keystroke); the very first load is immediate. Totals dim (loading) as soon as something changes.
  const firstLoad = useRef(true)
  useEffect(() => {
    if (problem) {
      reqSeq.current++ // drop any in-flight answer for the old dates
      abortRef.current?.abort()
      setLoading(false)
      return
    }
    if (firstLoad.current) {
      firstLoad.current = false
      void load(filters, page) // the page opening: load straight away
      return
    }
    setLoading(true)
    const t = setTimeout(() => { void load(filters, page) }, USAGE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [filters, page, problem, load])

  useEffect(() => () => abortRef.current?.abort(), [])

  const update = (patch: Partial<UsageFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(1)
    setNoMatch(false)
  }

  const handleExport = async () => {
    setNoMatch(false)
    const outcome = await dl.run(`${ENDPOINT}?${usageQuery(filters, { format: 'xlsx' })}`, {
      fallbackFileName: `usage-report-${filters.from}-to-${filters.to}.xlsx`,
    })
    if (outcome?.kind === 'error' && outcome.status === 404 && NO_MATCH_RE.test(outcome.message)) {
      dl.reset()
      setNoMatch(true)
    }
  }

  const t = data?.totals
  const showTable = !loading && !error && !problem && data

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Usage Report</h1>
          <p className="text-sm text-gray-500 mt-1">
            Who used the app, how (installed app or browser, phone or computer) and for how long.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            onClick={() => void handleExport()}
            disabled={dl.blocked || loading || !!problem || !data || data.totalRows === 0}
            size="sm"
            className="flex items-center gap-1.5 bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white"
          >
            {dl.busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            {downloadButtonLabel(dl, 'Export Excel')}
          </Button>
          <DownloadActionStatus action={dl} />
          {noMatch && <p className="text-xs text-gray-500">0 users matched these filters — nothing to download.</p>}
        </div>
      </div>

      {/* How to read it */}
      <div className="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-700" data-testid="usage-note">
        <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p>
            Duration counts the time between a user&apos;s first and last action in each visit (a new visit starts
            after 30 minutes idle), so it is a minimum — read it as &quot;at least&quot;. Automatic refreshes
            (notification bell, download badge, status polling) are not counted — only real actions.{' '}
            {data?.trackingStartedOn
              ? <>Tracking started on <strong>{fmtIstDay(data.trackingStartedOn)}</strong>; earlier days count as active days but show no duration or medium.</>
              : <>Duration and medium tracking has not recorded any activity for this programme yet; earlier days count as active days only.</>}
          </p>
          <p>{data?.notes.region ?? 'Programme and region come from outlets.'}</p>
          {(data?.notes.area ?? []).map((line) => <p key={line} data-testid="usage-area-note">{line}</p>)}
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 items-end text-xs">
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-gray-500">From</span>
            <input type="date" aria-label="From" value={filters.from} max={filters.to}
              onChange={(e) => update({ from: e.target.value })}
              className="border border-gray-200 rounded px-2 py-1.5" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-gray-500">To</span>
            <input type="date" aria-label="To" value={filters.to} min={filters.from}
              onChange={(e) => update({ to: e.target.value })}
              className="border border-gray-200 rounded px-2 py-1.5" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-gray-500">Role</span>
            <select aria-label="Role" value={filters.role} onChange={(e) => update({ role: e.target.value })}
              className="border border-gray-200 rounded px-2 py-1.5 bg-white">
              <option value="">All roles</option>
              {(data?.filters.roles ?? []).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
              {filters.role && !data?.filters.roles.includes(filters.role) && <option value={filters.role}>{roleLabel(filters.role)}</option>}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-gray-500">Programme</span>
            <select aria-label="Programme" value={filters.program} onChange={(e) => update({ program: e.target.value })}
              className="border border-gray-200 rounded px-2 py-1.5 bg-white">
              <option value="">All programmes</option>
              {(data?.filters.programs ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              {filters.program && !data?.filters.programs.includes(filters.program) && <option value={filters.program}>{filters.program}</option>}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-gray-500">Region</span>
            <select aria-label="Region" value={filters.region} onChange={(e) => update({ region: e.target.value })}
              className="border border-gray-200 rounded px-2 py-1.5 bg-white">
              <option value="">All regions</option>
              {(data?.filters.regions ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
              {filters.region && !data?.filters.regions.includes(filters.region) && <option value={filters.region}>{filters.region}</option>}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-gray-500">Sort by</span>
            <select aria-label="Sort by" value={filters.sort} onChange={(e) => update({ sort: e.target.value as Sort })}
              className="border border-gray-200 rounded px-2 py-1.5 bg-white">
              <option value="minutes">Most minutes</option>
              <option value="days">Most days active</option>
              <option value="lastSeen">Most recently seen</option>
              <option value="name">Name (A–Z)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 col-span-2 pb-1.5">
            <input type="checkbox" checked={filters.includeInactive}
              onChange={(e) => update({ includeInactive: e.target.checked })} />
            <span className="text-gray-700">Show users with no activity in this range</span>
          </label>
        </CardContent>
      </Card>

      {problem && (
        <p role="alert" className="text-sm text-red-600">{problem}</p>
      )}

      {/* Totals */}
      {t && !problem && (
        <div
          className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 transition-opacity ${loading ? 'opacity-40' : ''}`}
          data-testid="usage-totals"
          aria-busy={loading}
          title={loading ? 'Updating for the new filters…' : undefined}
        >
          {[
            { label: 'Users active', value: `${fmtInt(t.usersActive)} of ${fmtInt(t.usersInScope)}`, sub: `${fmtInt(t.usersInactive)} did not use it` + (t.disabledAccountsExcluded ? ` · ${fmtInt(t.disabledAccountsExcluded)} deactivated/suspended not counted` : '') },
            { label: 'Avg days active', value: fmtNum(t.avgDaysActive), sub: `per active user · ${data!.range.days}-day range` },
            { label: 'Total minutes (at least)', value: fmtInt(t.totalMinutes), sub: `avg ${fmtNum(t.avgMinutesPerTrackedUser)} per user with tracked days (${fmtInt(t.usersTracked)})` },
            { label: 'Installed app users', value: fmtInt(t.appUsers), sub: `${fmtInt(t.browserUsers)} used a browser` },
            { label: 'Phone users', value: fmtInt(t.phoneUsers), sub: `${fmtInt(t.computerUsers)} used a computer` },
            { label: 'Rows listed', value: fmtInt(data!.totalRows), sub: filters.includeInactive ? 'incl. users with no activity' : 'users with activity only' },
          ].map((c) => (
            <Card key={c.label}>
              <CardContent className="p-3">
                <p className="text-[11px] font-semibold text-gray-500">{c.label}</p>
                <p className="text-lg font-bold text-[#1A1A2E]">{c.value}</p>
                <p className="text-[11px] text-gray-500">{c.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {t && !problem && (
        <p className="text-[11px] text-gray-500 -mt-3">A user can count in both app and browser, and in both phone and computer.</p>
      )}

      {/* Error */}
      {error && !loading && !problem && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-red-600 font-medium">{error}</p>
            <Button onClick={() => void load(filters, page)} size="sm" variant="outline"
              className="mt-3 border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-red-50">
              <RefreshCw className="h-3 w-3 mr-1" />Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && (
        <Card>
          <CardContent className="p-6 space-y-3" data-testid="usage-loading">
            <div className="h-5 w-48 bg-gray-100 rounded animate-pulse" />
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-8 w-full bg-gray-100 rounded animate-pulse" />)}
          </CardContent>
        </Card>
      )}

      {/* Table */}
      {showTable && (
        data.rows.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-gray-500">
              {filters.includeInactive
                ? 'No users match these filters.'
                : 'No one used the app in this range with these filters. Tick "Show users with no activity in this range" to see who did not.'}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-[var(--brand-primary)]" />
                {fmtInt(data.totalRows)} user{data.totalRows !== 1 ? 's' : ''} · {fmtIstDay(data.range.from)} – {fmtIstDay(data.range.to)}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse w-full">
                  <caption className="sr-only">
                    Usage per user, {data.range.from} to {data.range.to}. Minutes are a minimum.
                  </caption>
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-300 text-gray-700 text-left">
                      {['User', 'Role', data.asmHeader || 'ASM', 'Zone', 'State', 'City', 'Mobile', 'Programme', 'Region'].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                      ))}
                      {['Days active', 'Visits', 'Minutes (at least)', 'Avg min / tracked day', 'App days', 'Browser days'].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-right">{h}</th>
                      ))}
                      {['Phone / computer', 'First seen', 'Last seen'].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.userId} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-1.5 font-medium whitespace-nowrap max-w-[200px] truncate" title={r.name}>{r.name}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{roleLabel(r.role)}</td>
                        {[r.asm, r.zone, r.state, r.city].map((v, i) => (
                          <td key={i} className="px-3 py-1.5 whitespace-nowrap text-gray-600 max-w-[180px] truncate" title={v || undefined}>{v || '—'}</td>
                        ))}
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500 font-mono">{r.phone || '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600 max-w-[180px] truncate" title={r.programmes.join(', ')}>{r.programmes.join(', ') || '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600 max-w-[180px] truncate" title={r.regions.join(', ')}>{r.regions.join(', ') || '—'}</td>
                        <td className={`px-3 py-1.5 text-right ${r.daysActive ? 'font-semibold text-[#1A1A2E]' : 'text-gray-300'}`}>{r.daysActive}</td>
                        <td className="px-3 py-1.5 text-right">{r.visits}</td>
                        <td className="px-3 py-1.5 text-right font-semibold">{fmtInt(r.minutes)}</td>
                        <td className="px-3 py-1.5 text-right">{fmtNum(r.avgMinutesPerDay)}</td>
                        <td className="px-3 py-1.5 text-right">{r.appDays}</td>
                        <td className="px-3 py-1.5 text-right">{r.browserDays}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{r.device || '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{fmtIstDateTime(r.firstSeenAt)}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{fmtIstDateTime(r.lastSeenAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.pageCount > 1 && (
                <div className="flex items-center justify-end gap-2 px-3 py-2 text-xs text-gray-600" data-testid="usage-pager">
                  <Button size="sm" variant="outline" aria-label="Previous page" disabled={data.page <= 1}
                    onClick={() => setPage(data.page - 1)}><ChevronLeft className="h-3 w-3" /></Button>
                  <span>Page {data.page} of {data.pageCount}</span>
                  <Button size="sm" variant="outline" aria-label="Next page" disabled={data.page >= data.pageCount}
                    onClick={() => setPage(data.page + 1)}><ChevronRight className="h-3 w-3" /></Button>
                </div>
              )}
            </CardContent>
          </Card>
        )
      )}
    </div>
  )
}
