'use client'

/**
 * /admin/reports/target-vs-sales
 *
 * Target vs Sales Performance report.
 *
 * Features:
 *   • Period picker: From / To (month inputs). Historical months are selectable
 *     (targets/sales are uploaded per past month), so plain `type="month"` inputs
 *     are used — the same control the sibling points-ledger report uses. (The
 *     targets lib's buildMonthRange is forward-only and would hide past months, so
 *     it is intentionally not used here; formatMonth is reused for friendly labels.)
 *   • Inline validation: From > To or span > 15 months → error + disabled actions.
 *   • Generate Preview → on-screen table (one row per outlet × month; blank cells
 *     where a month/outlet/KPI has no uploaded data).
 *   • Download Excel → downloads the xlsx blob.
 */

import { useState, useCallback } from 'react'
import { Download, RefreshCw, TableIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { downloadBlob } from '@/lib/download'
import { formatMonth } from '@/lib/targets'

const MAX_MONTHS = 15

// ─── Types (mirror the backend targetVsSales JSON payload) ────────────────────

interface KpiCol { code: string; label: string; unit?: string | null }
interface PreviewData {
  fromMonth: string
  toMonth: string
  months: string[]
  kpis: KpiCol[]
  rows: Record<string, string | number>[]
}

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

/** The full ordered column list: 4 lead columns + Target/Achieved/Pace % per KPI. */
function columnsFor(kpis: KpiCol[]): string[] {
  const cols = ['Outlet Code', 'Outlet Name', 'Outlet Type', 'Month']
  for (const k of kpis) cols.push(`${k.label} Target`, `${k.label} Achieved`, `${k.label} Pace %`)
  return cols
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TargetVsSalesPage() {
  const todayMM     = currentYYYYMM()
  const defaultFrom = subtractMonths(todayMM, 5) // last 6 months inclusive

  const [from,    setFrom   ] = useState(defaultFrom)
  const [to,      setTo     ] = useState(todayMM)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError  ] = useState<string | null>(null)

  // ── Inline validation ──────────────────────────────────────────────────────
  const validationError: string | null = (() => {
    if (!from || !to)          return null
    if (from > to)             return 'From must not be after To.'
    const span = monthSpan(from, to)
    if (span > MAX_MONTHS)     return `Period is ${span} months — maximum is ${MAX_MONTHS}.`
    return null
  })()
  const actionsDisabled = !!validationError || !from || !to

  // ── Generate preview ──────────────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/admin/reports/target-vs-sales?fromMonth=${from}&toMonth=${to}&format=json`
      const res = await fetch(url)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string; message?: string }).error
          ?? (body as { message?: string }).message
          ?? `Request failed (${res.status})`)
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

  // ── Download Excel ──────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/admin/reports/target-vs-sales?fromMonth=${from}&toMonth=${to}&format=xlsx`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      downloadBlob(blob, `target-vs-sales-${from}-to-${to}.xlsx`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  const columns = preview ? columnsFor(preview.kpis) : []

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-[#1A1A2E]">Target vs Sales Performance</h1>
        <p className="text-sm text-gray-500 mt-1">
          Target vs actual per outlet, month, and KPI over a selected period — up to {MAX_MONTHS} months.
          Months with no uploaded data appear as blank cells.
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
                : <><Download className="h-3 w-3" />Download Excel</>}
            </Button>
          </div>

          {/* Helper / validation copy */}
          <p className="text-xs text-gray-500">
            Selected: {from ? formatMonth(from) : '—'} to {to ? formatMonth(to) : '—'}. Months with no
            uploaded target or sales data appear as blank cells (not zero).
          </p>
          {validationError && (
            <p className="text-xs text-red-600 font-medium">{validationError}</p>
          )}
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
              Preview — {preview.rows.length} row{preview.rows.length !== 1 ? 's' : ''} ·{' '}
              {preview.months.length} month{preview.months.length !== 1 ? 's' : ''} ·{' '}
              {preview.kpis.length} KPI{preview.kpis.length !== 1 ? 's' : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {preview.rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-500">
                No target or sales data was uploaded for any outlet in this period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-300 text-gray-700">
                      {columns.map((h, i) => (
                        <th
                          key={h}
                          className={`bg-gray-50 px-3 py-1.5 font-medium whitespace-nowrap
                            ${i < 4 ? 'text-left' : 'text-right'}
                            ${i === 3 ? 'border-r border-gray-300' : ''}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, ri) => (
                      <tr
                        key={`${row['Outlet Code']}-${row['Month']}-${ri}`}
                        className={`border-b border-gray-100 hover:bg-gray-50 ${ri % 2 === 0 ? '' : 'bg-gray-50/40'}`}
                      >
                        {columns.map((col, ci) => (
                          <td
                            key={col}
                            className={`px-3 py-1.5 whitespace-nowrap
                              ${ci < 4 ? 'text-left' : 'text-right'}
                              ${ci === 3 ? 'border-r border-gray-300' : ''}
                              ${ci < 4 ? 'text-gray-800' : 'text-gray-700'}`}
                          >
                            {row[col] === '' || row[col] === undefined ? '' : String(row[col])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
