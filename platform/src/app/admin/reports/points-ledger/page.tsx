'use client'

/**
 * /admin/reports/points-ledger
 *
 * Outlet Points Ledger report — client look-and-feel sign-off page.
 *
 * Features:
 *   • Period picker: From / To (month inputs), default last 6 months.
 *   • Inline validation: From > To or span > 24 months → error + disabled actions.
 *   • Generate Preview → on-screen table (sticky leading columns, scrollable month columns).
 *   • Export Excel → downloads the xlsx blob.
 *
 * Spec: docs/plans/REPORTING-REVAMP.md § R1
 */

import { useState, useCallback, Fragment } from 'react'
import { Download, RefreshCw, TableIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

// ─── Types (mirrors PointsLedgerReportRow from @/types) ───────────────────────

interface MonthCell  { monthKey: string; label: string; earn: number; burn: number }
interface LedgerRow  {
  outletId: string; outletName: string
  zone?: string; znmId?: string; rsmId?: string; asmId?: string; soId?: string; xsrId?: string
  distributorCode?: string; distributorName?: string
  programName?: string; programCategory?: string; outletType?: string
  openingBalance: number
  months: MonthCell[]
  totalEarn: number; totalBurn: number; totalExpired: number; closingBalance: number
}
interface PreviewData { months: { monthKey: string; label: string }[]; rows: LedgerRow[] }

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a YYYY-MM string for N months before a given YYYY-MM. */
function subtractMonths(yyyyMM: string, n: number): string {
  const [y, m] = yyyyMM.split('-').map(Number)
  const total  = y * 12 + (m - 1) - n
  const year   = Math.floor(total / 12)
  const month  = (total % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

/** Returns YYYY-MM for today's month. */
function currentYYYYMM(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** Counts months between two YYYY-MM strings (inclusive). */
function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to  .split('-').map(Number)
  return (ty * 12 + tm) - (fy * 12 + fm) + 1
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PointsLedgerPage() {
  const todayMM  = currentYYYYMM()
  const defaultFrom = subtractMonths(todayMM, 5) // last 6 months inclusive

  const [from,    setFrom   ] = useState(defaultFrom)
  const [to,      setTo     ] = useState(todayMM)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError  ] = useState<string | null>(null)

  // ── Inline validation ──────────────────────────────────────────────────────
  const validationError: string | null = (() => {
    if (!from || !to)         return null
    if (from > to)            return 'From must not be after To.'
    const span = monthSpan(from, to)
    if (span > 24)            return `Period is ${span} months — maximum is 24.`
    return null
  })()
  const actionsDisabled = !!validationError || !from || !to

  // ── Auth token ────────────────────────────────────────────────────────────
  const token = () =>
    typeof localStorage !== 'undefined' ? (localStorage.getItem('token') ?? '') : ''

  // ── Generate preview ──────────────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/admin/reports/points-ledger?from=${from}&to=${to}&format=json`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
      }
      const body = await res.json() as { success: boolean; data: PreviewData }
      setPreview(body.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed.')
      setPreview(null)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  // ── Export Excel ──────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/admin/reports/points-ledger?from=${from}&to=${to}&format=xlsx`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = href
      a.download = `points-ledger-${from}-to-${to}.xlsx`
      a.click()
      URL.revokeObjectURL(href)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-[#1A1A2E]">Outlet Points Ledger</h1>
        <p className="text-sm text-gray-500 mt-1">
          Per-outlet points movement (opening, monthly earn/burn, expiry, closing) — up to 24 months.
        </p>
      </div>

      {/* Controls card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            {/* From */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">From</label>
              <input
                type="month"
                value={from}
                onChange={e => setFrom(e.target.value)}
                className="border border-gray-200 rounded px-2 py-1.5 text-sm"
              />
            </div>
            {/* To */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">To</label>
              <input
                type="month"
                value={to}
                onChange={e => setTo(e.target.value)}
                className="border border-gray-200 rounded px-2 py-1.5 text-sm"
              />
            </div>

            {/* Actions */}
            <Button
              onClick={handlePreview}
              disabled={actionsDisabled || loading}
              size="sm"
              variant="outline"
              className="flex items-center gap-1.5 border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-red-50"
            >
              {loading
                ? <><RefreshCw className="h-3 w-3 animate-spin" />Loading…</>
                : <><TableIcon className="h-3 w-3" />Generate Preview</>}
            </Button>

            <Button
              onClick={handleExport}
              disabled={actionsDisabled || loading}
              size="sm"
              className="flex items-center gap-1.5 bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white"
            >
              {loading
                ? <><RefreshCw className="h-3 w-3 animate-spin" />Loading…</>
                : <><Download className="h-3 w-3" />Export Excel</>}
            </Button>
          </div>

          {/* Validation error */}
          {validationError && (
            <p className="text-xs text-red-600 font-medium">{validationError}</p>
          )}
          {/* Request error */}
          {error && !validationError && (
            <p className="text-xs text-red-600 font-medium">{error}</p>
          )}
        </CardContent>
      </Card>

      {/* Preview table */}
      {preview && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TableIcon className="h-4 w-4 text-[var(--brand-primary)]" />
              Preview — {preview.rows.length} outlet{preview.rows.length !== 1 ? 's' : ''} ·{' '}
              {preview.months.length} month{preview.months.length !== 1 ? 's' : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse w-full">
                <thead>
                  {/* ── Grouped header row ── */}
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {/* Leading group */}
                    <th
                      colSpan={14}
                      className="bg-gray-100 text-left px-3 py-1.5 font-semibold text-gray-600 border-r border-gray-300 whitespace-nowrap"
                    >
                      Outlet / Programme details
                    </th>
                    {/* Month groups */}
                    {preview.months.map(m => (
                      <th
                        key={m.monthKey}
                        colSpan={2}
                        className="text-center px-2 py-1.5 font-semibold text-[var(--brand-primary)] border-r border-gray-200 whitespace-nowrap"
                      >
                        {m.label}
                      </th>
                    ))}
                    {/* Totals group */}
                    <th
                      colSpan={4}
                      className="text-center px-2 py-1.5 font-semibold text-gray-700 border-l border-gray-300 whitespace-nowrap"
                    >
                      Totals
                    </th>
                  </tr>

                  {/* ── Column header row ── */}
                  <tr className="bg-gray-50 border-b border-gray-300 text-gray-700">
                    {/* Sticky leading columns */}
                    {[
                      'Outlet ID', 'Outlet Name', 'Zone', 'ZNM id', 'RSM id',
                      'ASM id', 'SO id', 'XSR id', 'Dist. code', 'Dist. name',
                      'Programme', 'Category', 'Type', 'Opening',
                    ].map((h, i) => (
                      <th
                        key={h}
                        className={`bg-gray-50 px-3 py-1.5 font-medium whitespace-nowrap text-left
                          ${i === 13 ? 'border-r border-gray-300 text-right' : ''}`}
                      >
                        {h}
                      </th>
                    ))}
                    {/* Month earn/burn columns */}
                    {preview.months.map(m => (
                      <Fragment key={m.monthKey}>
                        <th className="px-2 py-1.5 font-medium text-right whitespace-nowrap text-green-700">
                          Earn
                        </th>
                        <th className="px-2 py-1.5 font-medium text-right whitespace-nowrap text-orange-700 border-r border-gray-200">
                          Burn
                        </th>
                      </Fragment>
                    ))}
                    {/* Trailing total columns */}
                    {['Total earn', 'Total burn', 'Expired', 'Closing'].map(h => (
                      <th key={h} className="px-2 py-1.5 font-medium text-right whitespace-nowrap border-l border-gray-200">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {preview.rows.map((row, ri) => (
                    <tr
                      key={row.outletId}
                      className={`border-b border-gray-100 hover:bg-gray-50 ${ri % 2 === 0 ? '' : 'bg-gray-50/40'}`}
                    >
                      {/* Leading cells */}
                      <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.outletId}</td>
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap max-w-[150px] truncate">{row.outletName}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.zone             ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.znmId            ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.rsmId            ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.asmId            ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.soId             ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.xsrId            ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.distributorCode  ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.distributorName  ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.programName      ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.programCategory  ?? '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.outletType       ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right font-medium border-r border-gray-300 whitespace-nowrap">{row.openingBalance.toLocaleString()}</td>

                      {/* Monthly earn/burn cells */}
                      {row.months.map(cell => (
                        <Fragment key={cell.monthKey}>
                          <td className="px-2 py-1.5 text-right text-green-700 whitespace-nowrap">{cell.earn.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right text-orange-700 border-r border-gray-200 whitespace-nowrap">{cell.burn.toLocaleString()}</td>
                        </Fragment>
                      ))}

                      {/* Trailing total cells */}
                      <td className="px-2 py-1.5 text-right text-green-800 font-medium border-l border-gray-200 whitespace-nowrap">{row.totalEarn.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right text-orange-800 font-medium whitespace-nowrap">{row.totalBurn.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right text-gray-500 whitespace-nowrap">{row.totalExpired.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right font-semibold text-[#1A1A2E] whitespace-nowrap">{row.closingBalance.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
