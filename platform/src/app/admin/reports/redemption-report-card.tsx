'use client'

/**
 * "Redemption report" card on the admin Reports hub (owner-approved 2026-11-20, all clients).
 *
 * Filters: Redeemed on From / To (IST days, default = this IST month to date), status, reward type, zone, state.
 * The live line under the filters comes from GET /api/reports/redemptions (orders · points · ₹ for the same filters,
 * the client's zone/state values, and whether the file will be prepared in the background). The button downloads
 * GET /api/reports/redemptions/export through the shared download action (200 → file, 202 → Downloads page,
 * 404 → "0 redemptions matched these filters.").
 */
import { useEffect, useMemo, useState } from 'react'
import { Download, FileSpreadsheet, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action'
import { DownloadActionStatus } from '@/components/exports/download-action-status'

export const REDEMPTION_SUMMARY_URL = '/api/reports/redemptions'
export const REDEMPTION_EXPORT_URL = '/api/reports/redemptions/export'

const STATUS_OPTIONS: Array<[string, string]> = [
  ['', 'All statuses'],
  ['PENDING', 'Placed'],
  ['CONFIRMED', 'Confirmed'],
  ['PROCESSING', 'Processing'],
  ['DISPATCHED', 'Dispatched'],
  ['DELIVERED', 'Delivered'],
  ['CANCELLED', 'Cancelled'],
  ['RETURNED', 'Returned'],
  ['FAILED', 'Failed'],
]

const TYPE_OPTIONS: Array<[string, string]> = [
  ['', 'All reward types'],
  ['E_VOUCHER', 'E-voucher'],
  ['PHYSICAL_GIFT', 'Physical gift'],
  ['CASH', 'Cash / UPI'],
]

interface Summary {
  orders: number
  points: number
  valueInr: number
  preparedInBackground: boolean
  zones: string[]
  states: string[]
}

/** Today and the 1st of this month, as IST calendar days (YYYY-MM-DD). */
export function istMonthToDate(now = new Date()): { from: string; to: string } {
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)
  return { from: `${today.slice(0, 7)}-01`, to: today }
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

const fieldClass = 'w-full text-xs border border-gray-200 rounded px-2 py-1.5 bg-white'

export function RedemptionReportCard() {
  const dl = useDownloadAction()
  const initial = useMemo(() => istMonthToDate(), [])
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [status, setStatus] = useState('')
  const [rewardType, setRewardType] = useState('')
  const [zone, setZone] = useState('')
  const [state, setState] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)

  const rangeError = from && to && from > to ? 'The From date must be on or before the To date.' : null

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (status) p.set('status', status)
    if (rewardType) p.set('rewardType', rewardType)
    if (zone) p.set('zone', zone)
    if (state) p.set('state', state)
    return p.toString()
  }, [from, to, status, rewardType, zone, state])

  // Live summary for the current filters (debounced; the latest request wins).
  useEffect(() => {
    if (rangeError) return
    let cancelled = false
    const timer = setTimeout(() => {
      setSummaryLoading(true)
      Promise.resolve()
        .then(() => fetch(`${REDEMPTION_SUMMARY_URL}?${query}`))
        .then(async (res) => {
          let body: { data?: Summary; error?: string; message?: string | string[] } | null = null
          try { body = res && typeof res.json === 'function' ? await res.json() : null } catch { body = null }
          if (cancelled) return
          if (res?.ok && body?.data && typeof body.data.orders === 'number') {
            setSummary(body.data)
            setSummaryError(null)
          } else {
            const msg = body?.error ?? (Array.isArray(body?.message) ? body?.message.join(' ') : body?.message)
            setSummary(null)
            setSummaryError(msg || "Couldn't load the summary for these filters.")
          }
        })
        .catch(() => {
          if (!cancelled) { setSummary(null); setSummaryError("Couldn't reach the server for the summary.") }
        })
        .finally(() => { if (!cancelled) setSummaryLoading(false) })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, rangeError])

  const handleExport = () => {
    if (rangeError) return
    void dl.run(`${REDEMPTION_EXPORT_URL}?${query}`, { fallbackFileName: `redemption-report-${from}-to-${to}.xlsx` })
  }

  const zones = summary?.zones ?? []
  const states = summary?.states ?? []

  return (
    <Card className="flex flex-col sm:col-span-2" data-testid="redemption-report-card">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-red-50">
            <FileSpreadsheet className="h-4 w-4 text-[var(--brand-primary)]" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold">Redemption report</CardTitle>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-purple-100 text-purple-800">Business</span>
          </div>
        </div>
        <CardDescription className="text-xs mt-2">
          Every redemption order in the range: reward, points and ₹ value, current status with the time of each stage,
          outlet, sales hierarchy, delivery tracking and cash payout reference — plus a status-history sheet and a summary
          by zone, state, ASM, reward and status.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 flex-1 flex flex-col justify-end gap-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-500">
            <span className="mb-1 block">Redeemed from</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={fieldClass} aria-label="Redeemed from" />
          </label>
          <label className="text-xs text-gray-500">
            <span className="mb-1 block">Redeemed to</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={fieldClass} aria-label="Redeemed to" />
          </label>
          <label className="text-xs text-gray-500">
            <span className="mb-1 block">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={fieldClass} aria-label="Status">
              {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            <span className="mb-1 block">Reward type</span>
            <select value={rewardType} onChange={(e) => setRewardType(e.target.value)} className={fieldClass} aria-label="Reward type">
              {TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            <span className="mb-1 block">Zone</span>
            <select value={zone} onChange={(e) => setZone(e.target.value)} className={fieldClass} aria-label="Zone">
              <option value="">All zones</option>
              {zone && !zones.includes(zone) && <option value={zone}>{zone}</option>}
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            <span className="mb-1 block">State</span>
            <select value={state} onChange={(e) => setState(e.target.value)} className={fieldClass} aria-label="State">
              <option value="">All states</option>
              {state && !states.includes(state) && <option value={state}>{state}</option>}
              {states.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <div className="text-xs min-h-[2rem]" data-testid="redemption-summary" aria-live="polite">
          {rangeError ? (
            <p className="text-red-700" role="alert">{rangeError}</p>
          ) : summaryError ? (
            <p className="text-amber-800">{summaryError}</p>
          ) : summary ? (
            <>
              <p className="text-gray-700">
                <span className="font-semibold">{summary.orders.toLocaleString('en-IN')}</span> orders ·{' '}
                {summary.points.toLocaleString('en-IN')} points · {inr(summary.valueInr)}
              </p>
              {summary.orders === 0 && <p className="text-gray-500">No redemptions match these filters.</p>}
              {summary.orders > 0 && summary.preparedInBackground && (
                <p className="text-gray-500">More than 31 days — the file will be prepared under Downloads.</p>
              )}
            </>
          ) : summaryLoading ? (
            <p className="text-gray-400">Counting orders…</p>
          ) : null}
        </div>

        <Button
          onClick={handleExport}
          disabled={dl.blocked || !!rangeError}
          size="sm"
          className="w-full bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white text-xs"
        >
          {dl.busy ? <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
          {downloadButtonLabel(dl, 'Download redemption report')}
        </Button>
        <DownloadActionStatus action={dl} />
      </CardContent>
    </Card>
  )
}
