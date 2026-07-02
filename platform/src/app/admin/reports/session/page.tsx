'use client'

/**
 * /admin/reports/session
 *
 * Session Report — per-user portal usage matrix.
 *
 * Features:
 *   • On mount: GET /api/reports/session-report → JSON (users × months active-day matrix).
 *   • Wide, horizontally-scrollable table: sticky leading columns (User / Role / Mobile /
 *     Last Login) followed by one column per month (oldest → newest) showing active-day counts.
 *   • Zero counts rendered muted; non-zero emphasised so real usage pops.
 *   • Export Excel → downloads /api/reports/session-report?format=xlsx blob.
 *   • Loading skeleton, error state, and empty state.
 *
 * Note: "Active" = a day the user actually used the app (NOT a login). Active-day tracking is
 * greenfield — it begins when the feature ships, so months before launch read 0 (no backfill).
 */

import { useState, useEffect, useCallback } from 'react'
import { Download, RefreshCw, TableIcon, Info } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { downloadBlob } from '@/lib/download'

// ─── Types (mirrors GET /v1/reports/session-report) ───────────────────────────

interface SessionMonth { ym: string; label: string }
interface SessionRow {
  userId: string
  name: string
  phone: string
  role: string
  lastLoginAt: string | null
  activeDays: Record<string, number>
}
interface SessionReport {
  generatedAt: string
  timezone: string
  months: SessionMonth[]
  rows: SessionRow[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format an ISO timestamp as a readable locale date + time, or em-dash when null. */
function formatLastLogin(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function roleLabel(role: string): string {
  return role.replace(/_/g, ' ')
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SessionReportPage() {
  const [data, setData] = useState<SessionReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // ── Load report ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/session-report')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
      }
      // Backend wraps JSON returns in a { success, data } envelope (TransformInterceptor);
      // the proxy forwards it untouched — unwrap .data, matching the sibling report pages.
      const body = (await res.json()) as { success: boolean; data: SessionReport }
      setData(body.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // ── Export Excel ───────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/reports/session-report?format=xlsx')
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      downloadBlob(blob, `session-report-${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch {
      alert('Export failed. Please try again.')
    } finally {
      setExporting(false)
    }
  }, [])

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A2E]">Session Report</h1>
          <p className="text-sm text-gray-500 mt-1">
            Per-user portal usage — last login plus active-day counts for the last 12 months and
            the current month.
          </p>
        </div>
        <Button
          onClick={handleExport}
          disabled={exporting || loading || !data}
          size="sm"
          className="flex items-center gap-1.5 bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white"
        >
          {exporting
            ? <><RefreshCw className="h-3 w-3 animate-spin" />Generating…</>
            : <><Download className="h-3 w-3" />Export Excel</>}
        </Button>
      </div>

      {/* Info note */}
      <div className="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-700">
        <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <p>
          &quot;Active&quot; counts days the user actually used the app — not logins (one login can
          span many active days). Active-day tracking is greenfield: it begins when this feature
          ships, so months before launch read 0 (there is no historical backfill).
        </p>
      </div>

      {/* Error */}
      {error && !loading && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-red-600 font-medium">{error}</p>
            <Button
              onClick={() => void load()}
              size="sm"
              variant="outline"
              className="mt-3 border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-red-50"
            >
              <RefreshCw className="h-3 w-3 mr-1" />Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading skeleton */}
      {loading && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <div className="h-5 w-48 bg-gray-100 rounded animate-pulse" />
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-8 w-full bg-gray-100 rounded animate-pulse" />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Data table */}
      {!loading && !error && data && (
        data.rows.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-gray-500">
              No users yet.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TableIcon className="h-4 w-4 text-[var(--brand-primary)]" />
                {data.rows.length} user{data.rows.length !== 1 ? 's' : ''} ·{' '}
                {data.months.length} month{data.months.length !== 1 ? 's' : ''}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-300 text-gray-700">
                      {/* Sticky leading columns */}
                      <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 font-medium whitespace-nowrap text-left">User</th>
                      <th className="px-3 py-2 font-medium whitespace-nowrap text-left">Role</th>
                      <th className="px-3 py-2 font-medium whitespace-nowrap text-left">Mobile</th>
                      <th className="px-3 py-2 font-medium whitespace-nowrap text-left border-r border-gray-300">Last Login</th>
                      {/* Month columns (oldest → newest) */}
                      {data.months.map(m => (
                        <th
                          key={m.ym}
                          className="px-2 py-2 font-medium text-right whitespace-nowrap text-[var(--brand-primary)]"
                        >
                          {m.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, ri) => (
                      <tr
                        key={row.userId}
                        className={`border-b border-gray-100 hover:bg-gray-50 ${ri % 2 === 0 ? '' : 'bg-gray-50/40'}`}
                      >
                        <td className={`sticky left-0 z-10 px-3 py-1.5 font-medium whitespace-nowrap max-w-[180px] truncate ${ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`} title={row.name}>{row.name}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{roleLabel(row.role)}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500 font-mono">{row.phone || '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500 border-r border-gray-300">{formatLastLogin(row.lastLoginAt)}</td>
                        {data.months.map(m => {
                          const count = row.activeDays[m.ym] ?? 0
                          return (
                            <td
                              key={m.ym}
                              className={`px-2 py-1.5 text-right whitespace-nowrap ${count === 0 ? 'text-gray-300' : 'text-[#1A1A2E] font-semibold'}`}
                            >
                              {count}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )
      )}
    </div>
  )
}
