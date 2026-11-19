'use client'

/**
 * /admin/reports/location — Location-compliance report (owner-approved 2026-11-18; docs/plans/LOCATION-GATE.md).
 *
 * Per sales rep for an IST date range: KYCs and visibility captures, how many had no GPS, accuracy worse than
 * 50 m, flagged unverifiable, blocked outside the 200 m fence; median accuracy and median KYC lock time.
 *
 *   • GET /api/reports/location-compliance?from&to&role&region&sort&page&pageSize → JSON (one page + totals).
 *   • Export Excel → the same URL with format=xlsx (every filtered row + TOTAL row + About sheet; 404 "0 reps
 *     matched" shown as a neutral note).
 * Same access as the Usage report (route-permissions '/admin/reports' → reports:read; API roles + reports:read).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Info, MapPin, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DownloadActionStatus } from '@/components/exports/download-action-status'
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action'
import {
  LOCATION_DEBOUNCE_MS,
  LOCATION_ENDPOINT as ENDPOINT,
  LOCATION_NO_MATCH_RE as NO_MATCH_RE,
  LOCATION_PAGE_SIZE as PAGE_SIZE,
  defaultIstRange,
  fmtLockSeconds,
  locationQuery,
  rangeProblem,
  type LocationFilters,
  type LocationReportPage as Data,
  type LocationSort as Sort,
} from '@/lib/location-report'

const fmtInt = (n: number) => n.toLocaleString('en-IN')
const fmtM = (n: number | null) => (n == null ? '—' : `±${fmtInt(n)} m`)
const roleLabel = (r: string) => r.replace(/_/g, ' ')

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

export default function LocationReportPage() {
  const [filters, setFilters] = useState<LocationFilters>(() => ({ ...defaultIstRange(), role: '', region: '', sort: 'issues' }))
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [noMatch, setNoMatch] = useState(false)
  const reqSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const dl = useDownloadAction()

  const problem = useMemo(() => rangeProblem(filters.from, filters.to), [filters.from, filters.to])

  // Latest request wins: a superseded request is aborted, and an older answer never overwrites a newer one.
  const load = useCallback(async (f: LocationFilters, p: number) => {
    const seq = ++reqSeq.current
    abortRef.current?.abort()
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${ENDPOINT}?${locationQuery(f, { page: String(p), pageSize: String(PAGE_SIZE) })}`,
        ctrl ? { signal: ctrl.signal } : undefined,
      )
      const body = await res.json().catch(() => null)
      if (seq !== reqSeq.current) return
      if (!res.ok) throw new Error(errorText(body, res.status))
      setData((body as { data: Data }).data)
    } catch (e) {
      if (seq !== reqSeq.current) return
      setError(e instanceof Error ? e.message : 'Failed to load the report.')
      setData(null)
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  // Filter / date / page changes are debounced (one request per burst); the first load is immediate.
  const firstLoad = useRef(true)
  useEffect(() => {
    if (problem) {
      reqSeq.current++
      abortRef.current?.abort()
      setLoading(false)
      return
    }
    if (firstLoad.current) {
      firstLoad.current = false
      void load(filters, page)
      return
    }
    setLoading(true)
    const t = setTimeout(() => { void load(filters, page) }, LOCATION_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [filters, page, problem, load])

  useEffect(() => () => abortRef.current?.abort(), [])

  const update = (patch: Partial<LocationFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(1)
    setNoMatch(false)
  }

  const handleExport = async () => {
    setNoMatch(false)
    const outcome = await dl.run(`${ENDPOINT}?${locationQuery(filters, { format: 'xlsx' })}`, {
      fallbackFileName: `location-compliance-${filters.from}-to-${filters.to}.xlsx`,
    })
    if (outcome?.kind === 'error' && outcome.status === 404 && NO_MATCH_RE.test(outcome.message)) {
      dl.reset()
      setNoMatch(true)
    }
  }

  const t = data?.totals
  const showTable = !loading && !error && !problem && data
  const captures = t ? t.kycs + t.visibilityCaptures : 0

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Location Report</h1>
          <p className="text-sm text-gray-500 mt-1">
            How well each sales rep&apos;s KYCs and visibility captures were located.
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
          {noMatch && <p className="text-xs text-gray-500">0 reps matched these filters — nothing to download.</p>}
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-700" data-testid="location-note">
        <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p data-testid="location-setting">
            {data
              ? data.setting.requireLocation
                ? <><strong>Require location is ON</strong> for this programme: reps cannot start or submit a KYC or visibility capture without a location fix.</>
                : <><strong>Require location is OFF</strong> for this programme: captures without a location are still accepted (and counted here).</>
              : 'Loading the programme setting…'}
          </p>
          {data && (
            <>
              <p>{data.notes.sources} {data.notes.accuracy}</p>
              <p>{data.notes.unverifiable} {data.notes.blocked}</p>
              <p>{data.notes.lock} {data.notes.region}</p>
            </>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-4 grid grid-cols-2 md:grid-cols-5 gap-3 items-end text-xs">
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
              <option value="">All sales roles</option>
              {(data?.filters.roles ?? []).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
              {filters.role && !data?.filters.roles.includes(filters.role) && <option value={filters.role}>{roleLabel(filters.role)}</option>}
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
              <option value="issues">Most location issues</option>
              <option value="captures">Most captures</option>
              <option value="name">Name (A–Z)</option>
            </select>
          </label>
        </CardContent>
      </Card>

      {problem && <p role="alert" className="text-sm text-red-600">{problem}</p>}

      {t && !problem && (
        <div
          className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 transition-opacity ${loading ? 'opacity-40' : ''}`}
          data-testid="location-totals"
          aria-busy={loading}
        >
          {[
            { label: 'Captures', value: fmtInt(captures), sub: `${fmtInt(t.kycs)} KYCs · ${fmtInt(t.visibilityCaptures)} visibility · ${fmtInt(t.reps)} reps` },
            { label: 'No GPS', value: fmtInt(t.noGps), sub: captures ? `${Math.round((t.noGps / captures) * 100)}% of captures` : '—' },
            { label: 'Accuracy worse than 50 m', value: fmtInt(t.poorAccuracy), sub: captures ? `${Math.round((t.poorAccuracy / captures) * 100)}% of captures` : '—' },
            { label: 'Flagged unverifiable', value: fmtInt(t.unverifiable), sub: data!.setting.fenceOn ? 'checked against the outlet' : 'fence off — not checked' },
            { label: 'Blocked outside fence', value: fmtInt(t.blockedOutside), sub: data!.setting.requireLocation ? 'recorded refusals' : 'recorded only with Require location ON' },
            { label: 'Median accuracy · lock', value: fmtM(t.medianAccuracyM), sub: `KYC lock ${fmtLockSeconds(t.medianLockMs)}` },
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

      {loading && (
        <Card>
          <CardContent className="p-6 space-y-3" data-testid="location-loading">
            <div className="h-5 w-48 bg-gray-100 rounded animate-pulse" />
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-8 w-full bg-gray-100 rounded animate-pulse" />)}
          </CardContent>
        </Card>
      )}

      {showTable && (
        data.rows.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-gray-500">
              No KYCs, visibility captures or blocked attempts by sales reps in this range with these filters.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <MapPin className="h-4 w-4 text-[var(--brand-primary)]" />
                {fmtInt(data.totalRows)} rep{data.totalRows !== 1 ? 's' : ''} · {fmtIstDay(data.range.from)} – {fmtIstDay(data.range.to)}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse w-full">
                  <caption className="sr-only">
                    Location compliance per sales rep, {data.range.from} to {data.range.to}.
                  </caption>
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-300 text-gray-700 text-left">
                      {['Rep', 'Role', 'Mobile', 'Region'].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>
                      ))}
                      {['KYCs', 'Visibility', 'No GPS', 'Worse than 50 m', 'Unverifiable', 'Blocked outside', 'Median accuracy', 'Median KYC lock'].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-right">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.userId} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-1.5 font-medium whitespace-nowrap max-w-[200px] truncate" title={r.name}>{r.name}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{roleLabel(r.role)}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500 font-mono">{r.phone || '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600 max-w-[180px] truncate" title={r.regions.join(', ')}>{r.regions.join(', ') || '—'}</td>
                        <td className="px-3 py-1.5 text-right">{r.kycs}</td>
                        <td className="px-3 py-1.5 text-right">{r.visibilityCaptures}</td>
                        <td className={`px-3 py-1.5 text-right ${r.noGps ? 'font-semibold text-amber-700' : ''}`}>{r.noGps}</td>
                        <td className={`px-3 py-1.5 text-right ${r.poorAccuracy ? 'font-semibold text-amber-700' : ''}`}>{r.poorAccuracy}</td>
                        <td className="px-3 py-1.5 text-right">{r.unverifiable}</td>
                        <td className={`px-3 py-1.5 text-right ${r.blockedOutside ? 'font-semibold text-red-700' : ''}`}>{r.blockedOutside}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtM(r.medianAccuracyM)}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">{fmtLockSeconds(r.medianLockMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.pageCount > 1 && (
                <div className="flex items-center justify-end gap-2 px-3 py-2 text-xs text-gray-600" data-testid="location-pager">
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
