'use client'

/**
 * /admin/reports/ticket-aging
 *
 * Ticket Aging report — client-facing operational view of open/unresolved tickets.
 *
 * Features:
 *   • Filter row: Status (checkboxes, default = open set), Category dropdown, Priority dropdown.
 *   • Generate Preview → summary chips (total, SLA breached, per-bucket counts) + data table.
 *   • Export Excel → downloads the xlsx blob.
 *   • Priority CRITICAL/HIGH color-coded; SLA breached shown as red badge.
 *   • Null first-response displayed as "Pending".
 *
 * Spec: docs/plans/REPORTING-REVAMP.md § R2
 */

import { useState, useCallback } from 'react'
import { Download, RefreshCw, TableIcon, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const
const DEFAULT_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'ESCALATED'])

const CATEGORIES = ['KYC', 'POINTS', 'REDEMPTION', 'PAYOUT', 'SCHEME', 'TECHNICAL', 'ACCOUNT', 'OTHER'] as const
const PRIORITIES  = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

const AGING_BUCKETS = ['0-1 days', '2-3 days', '4-7 days', '8-14 days', '15-30 days', '30+ days'] as const

// ─── Local types ──────────────────────────────────────────────────────────────

interface TicketAgingRow {
  ticketNumber:       string
  subject:            string
  category:           string
  priority:           string
  status:             string
  createdByName:      string
  assignedToName?:    string
  createdAt:          string
  ageDays:            number
  agingBucket:        string
  firstResponseHours: number | null
  slaBreached:        boolean
  lastUpdatedAt:      string
}

interface TicketAgingSummary {
  total:      number
  slaBreached: number
  byBucket:   Record<string, number>
}

interface PreviewData {
  rows:    TicketAgingRow[]
  summary: TicketAgingSummary
  asOf:    string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function priorityClass(priority: string): string {
  if (priority === 'CRITICAL') return 'text-red-700 font-bold'
  if (priority === 'HIGH')     return 'text-orange-700 font-semibold'
  return 'text-gray-700'
}

function isoToDate(iso: string): string {
  return iso.slice(0, 10)
}

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ')
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TicketAgingPage() {
  // Filter state
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set(DEFAULT_STATUSES))
  const [category, setCategory] = useState('')
  const [priority, setPriority] = useState('')

  // Async state
  const [preview,  setPreview ] = useState<PreviewData | null>(null)
  const [loading,  setLoading ] = useState(false)
  const [error,    setError   ] = useState<string | null>(null)

  // ── Status checkbox toggle ─────────────────────────────────────────────────
  const toggleStatus = (s: string) => {
    setSelectedStatuses(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else             next.add(s)
      return next
    })
  }

  // ── Build query string ─────────────────────────────────────────────────────
  const buildParams = (fmt: string) => {
    const params = new URLSearchParams()
    if (selectedStatuses.size > 0) {
      params.set('status', [...selectedStatuses].join(','))
    }
    if (category) params.set('category', category)
    if (priority) params.set('priority', priority)
    params.set('format', fmt)
    return params.toString()
  }

  // ── Auth token ────────────────────────────────────────────────────────────
  const token = () =>
    typeof localStorage !== 'undefined' ? (localStorage.getItem('token') ?? '') : ''

  // ── Generate preview ──────────────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/admin/reports/ticket-aging?${buildParams('json')}`
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStatuses, category, priority])

  // ── Export Excel ──────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/admin/reports/ticket-aging?${buildParams('xlsx')}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = href
      a.download = `ticket-aging-${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(href)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.')
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStatuses, category, priority])

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-[#1A1A2E]">Ticket Aging</h1>
        <p className="text-sm text-gray-500 mt-1">
          Open and unresolved tickets aged into buckets — with SLA breach flags.
        </p>
      </div>

      {/* Filters card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status checkboxes */}
          <div>
            <p className="text-xs text-gray-500 mb-2">Status</p>
            <div className="flex flex-wrap gap-3">
              {ALL_STATUSES.map(s => (
                <label key={s} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selectedStatuses.has(s)}
                    onChange={() => toggleStatus(s)}
                    className="rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
                  />
                  <span className="text-xs text-gray-700">{statusLabel(s)}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Category + Priority dropdowns */}
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Category</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value)}
                className="border border-gray-200 rounded px-2 py-1.5 text-sm"
              >
                <option value="">All categories</option>
                {CATEGORIES.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Priority</label>
              <select
                value={priority}
                onChange={e => setPriority(e.target.value)}
                className="border border-gray-200 rounded px-2 py-1.5 text-sm"
              >
                <option value="">All priorities</option>
                {PRIORITIES.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            {/* Actions */}
            <Button
              onClick={handlePreview}
              disabled={loading || selectedStatuses.size === 0}
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
              disabled={loading || selectedStatuses.size === 0}
              size="sm"
              className="flex items-center gap-1.5 bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white"
            >
              {loading
                ? <><RefreshCw className="h-3 w-3 animate-spin" />Loading…</>
                : <><Download className="h-3 w-3" />Export Excel</>}
            </Button>
          </div>

          {/* No-status hint */}
          {selectedStatuses.size === 0 && (
            <p className="text-xs text-amber-600 font-medium">Select at least one status to run the report.</p>
          )}
          {/* Request error */}
          {error && (
            <p className="text-xs text-red-600 font-medium">{error}</p>
          )}
        </CardContent>
      </Card>

      {/* Preview */}
      {preview && (
        <>
          {/* Summary chips */}
          <div className="flex flex-wrap gap-3">
            {/* Total */}
            <div className="bg-gray-100 rounded-lg px-4 py-2 text-center min-w-[80px]">
              <p className="text-2xl font-bold text-[#1A1A2E]">{preview.summary.total}</p>
              <p className="text-xs text-gray-500 mt-0.5">Total</p>
            </div>

            {/* SLA breached */}
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
              <p className="text-2xl font-bold text-red-700">{preview.summary.slaBreached}</p>
              <p className="text-xs text-red-600 mt-0.5">SLA breached</p>
            </div>

            {/* Per-bucket chips */}
            {AGING_BUCKETS.map(b => (
              <div key={b} className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-2 text-center min-w-[80px]">
                <p className="text-2xl font-bold text-blue-700">{preview.summary.byBucket[b] ?? 0}</p>
                <p className="text-xs text-blue-600 mt-0.5">{b}</p>
              </div>
            ))}
          </div>

          {/* Table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TableIcon className="h-4 w-4 text-[var(--brand-primary)]" />
                Preview — {preview.rows.length} ticket{preview.rows.length !== 1 ? 's' : ''}
                {' '}&middot; as of {isoToDate(preview.asOf)}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-300 text-gray-700">
                      {[
                        'Ticket #', 'Subject', 'Category', 'Priority', 'Status',
                        'Created By', 'Assigned To', 'Created', 'Age (days)',
                        'Aging bucket', 'First response (hrs)', 'SLA breached', 'Last updated',
                      ].map(h => (
                        <th
                          key={h}
                          className="px-3 py-2 font-medium whitespace-nowrap text-left"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, ri) => (
                      <tr
                        key={row.ticketNumber}
                        className={`border-b border-gray-100 hover:bg-gray-50 ${ri % 2 === 0 ? '' : 'bg-gray-50/40'}`}
                      >
                        <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.ticketNumber}</td>
                        <td className="px-3 py-1.5 max-w-[220px] truncate" title={row.subject}>{row.subject}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{row.category}</td>
                        <td className={`px-3 py-1.5 whitespace-nowrap ${priorityClass(row.priority)}`}>{row.priority}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{statusLabel(row.status)}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-700">{row.createdByName}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.assignedToName ?? '—'}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{isoToDate(row.createdAt)}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap text-gray-700">{row.ageDays}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-blue-700 font-medium">{row.agingBucket}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap text-gray-600">
                          {row.firstResponseHours === null ? (
                            <span className="text-amber-600 font-medium">Pending</span>
                          ) : (
                            row.firstResponseHours
                          )}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {row.slaBreached ? (
                            <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                              <AlertTriangle className="h-3 w-3" />Yes
                            </span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{isoToDate(row.lastUpdatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
