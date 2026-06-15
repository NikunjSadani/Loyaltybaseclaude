'use client'

/**
 * /admin/kyc/approvals
 *
 * KYC Approvals — Bulk Verification (Lane A primary surface).
 *
 * 3-step flow:
 *   1. Export review dump (Excel with context cols pre-filled + blank verification cols).
 *   2. Upload validated results (Gifsy fills offline, re-uploads here).
 *   3. Preview → Commit (dry-run first; commit only when zero errors).
 *
 * Auth: GIFSY_ADMIN only.
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § 3.4d
 */

import { Fragment, useState, useCallback, useEffect } from 'react'
import { Download, Upload, CheckCircle, XCircle, RefreshCw, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

// ─── Local types ──────────────────────────────────────────────────────────────

interface KycQueueRow {
  submissionId:  string
  outletCode:    string
  outletName:    string
  ownerName:     string
  gstNumber:     string
  bankName:      string
  submittedAt:   string
  salesUser:     string
}

type FieldStatus = 'VERIFIED' | 'REJECTED' | 'PENDING'

interface KycVerifyPreviewRow {
  submissionId:         string
  outletName:           string
  bankStatus:           FieldStatus
  gstStatus:            FieldStatus
  addressStatus:        FieldStatus
  ownerStatus:          FieldStatus
  gstRegistrationType?: string
  decision:             'APPROVE' | 'RE_UPLOAD' | 'REJECT'
  resultingStatus:      string
  reason?:              string
}

interface KycVerifyError {
  rowNumber:    number
  submissionId: string
  message:      string
}

interface KycVerifyResult {
  previewRows: KycVerifyPreviewRow[]
  errors:      KycVerifyError[]
  summary: {
    toApprove:  number
    toReupload: number
    toReject:   number
    errors:     number
    total:      number
  }
}

interface CommitResult {
  committed: {
    toApprove:  number
    toReupload: number
    toReject:   number
    errors:     number
    total:      number
  }
  message: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authToken(): string {
  return typeof localStorage !== 'undefined' ? (localStorage.getItem('token') ?? '') : ''
}

function isoToDate(iso: string): string {
  return iso.slice(0, 10)
}

function fieldChip(status: FieldStatus, label: string) {
  const styles: Record<FieldStatus, string> = {
    VERIFIED: 'bg-green-100 text-green-800 border border-green-200',
    REJECTED: 'bg-red-100  text-red-700   border border-red-200',
    PENDING:  'bg-gray-100 text-gray-500  border border-gray-200',
  }
  return (
    <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded ${styles[status]}`}>
      {label}: {status === 'VERIFIED' ? '✓' : status === 'REJECTED' ? '✗' : '—'}
    </span>
  )
}

function decisionBadge(decision: string) {
  if (decision === 'APPROVE') {
    return (
      <span className="inline-flex items-center gap-1 bg-green-100 text-green-800 text-xs font-semibold px-2 py-0.5 rounded-full">
        <CheckCircle className="h-3 w-3" />APPROVE
      </span>
    )
  }
  if (decision === 'REJECT') {
    return (
      <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">
        <XCircle className="h-3 w-3" />REJECT
      </span>
    )
  }
  // RE_UPLOAD
  return (
    <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 text-xs font-semibold px-2 py-0.5 rounded-full">
      <RefreshCw className="h-3 w-3" />RE-UPLOAD
    </span>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function KycApprovalsPage() {
  // ── Queue state ────────────────────────────────────────────────────────────
  const [queue,        setQueue       ] = useState<KycQueueRow[]>([])
  const [queueLoading, setQueueLoading] = useState(true)
  const [queueError,   setQueueError  ] = useState<string | null>(null)

  // ── Upload + preview state ─────────────────────────────────────────────────
  const [uploadFile,   setUploadFile  ] = useState<File | null>(null)
  const [preview,      setPreview     ] = useState<KycVerifyResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // ── Commit state ───────────────────────────────────────────────────────────
  const [committed,    setCommitted   ] = useState<CommitResult | null>(null)
  const [commitLoading, setCommitLoading] = useState(false)
  const [commitError,  setCommitError ] = useState<string | null>(null)

  // ── General action loading ─────────────────────────────────────────────────
  const [exportLoading, setExportLoading] = useState(false)
  const [exportError,   setExportError  ] = useState<string | null>(null)

  // ── On mount: fetch pending queue ──────────────────────────────────────────
  useEffect(() => {
    async function loadQueue() {
      setQueueLoading(true)
      setQueueError(null)
      try {
        const res = await fetch('/api/admin/kyc/review-dump?format=json', {
          headers: { Authorization: `Bearer ${authToken()}` },
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
        }
        const body = await res.json() as { success: boolean; data: { rows: KycQueueRow[] } }
        setQueue(body.data.rows)
      } catch (e) {
        setQueueError(e instanceof Error ? e.message : 'Failed to load pending queue.')
      } finally {
        setQueueLoading(false)
      }
    }
    loadQueue()
  }, [])

  // ── Step 1: Export review dump ─────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setExportLoading(true)
    setExportError(null)
    try {
      const res = await fetch('/api/admin/kyc/review-dump?format=xlsx', {
        headers: { Authorization: `Bearer ${authToken()}` },
      })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = href
      a.download = `kyc-review-dump-${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(href)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.')
    } finally {
      setExportLoading(false)
    }
  }, [])

  // ── Step 2: Validate (preview) ─────────────────────────────────────────────
  const handleValidate = useCallback(async () => {
    if (!uploadFile) return
    setPreviewLoading(true)
    setPreviewError(null)
    setPreview(null)
    setCommitted(null)
    setCommitError(null)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      const res = await fetch('/api/admin/kyc/bulk-verify?mode=preview', {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken()}` },
        body:    fd,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `Validation failed (${res.status})`)
      }
      const body = await res.json() as { success: boolean; data: KycVerifyResult }
      setPreview(body.data)
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Validation failed.')
    } finally {
      setPreviewLoading(false)
    }
  }, [uploadFile])

  // ── Step 3: Commit ─────────────────────────────────────────────────────────
  const handleCommit = useCallback(async () => {
    if (!uploadFile) return
    setCommitLoading(true)
    setCommitError(null)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      const res = await fetch('/api/admin/kyc/bulk-verify?mode=commit', {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken()}` },
        body:    fd,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `Commit failed (${res.status})`)
      }
      const body = await res.json() as { success: boolean; data: CommitResult }
      setCommitted(body.data)
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : 'Commit failed.')
    } finally {
      setCommitLoading(false)
    }
  }, [uploadFile])

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-[#1A1A2E]">KYC Approvals — Bulk Verification</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-2xl">
          Three-step bulk KYC flow for Gifsy: <strong>Export</strong> the pending-submissions dump,
          fill verification columns offline (bank penny-drop, GST portal, address + owner review),
          then <strong>upload</strong> and <strong>commit</strong> the validated results.
          Each row is previewed before any changes are persisted.
        </p>
      </div>

      {/* ── Pending queue ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">
            Pending Queue
            {!queueLoading && (
              <span className="ml-2 text-xs font-normal text-gray-500">
                ({queue.length} submission{queue.length !== 1 ? 's' : ''} awaiting Gifsy review)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {queueLoading && (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-gray-500">
              <RefreshCw className="h-4 w-4 animate-spin" />Loading pending submissions…
            </div>
          )}
          {queueError && (
            <div className="px-4 py-3 text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />{queueError}
            </div>
          )}
          {!queueLoading && !queueError && queue.length === 0 && (
            <p className="px-4 py-4 text-sm text-gray-400">No submissions pending Gifsy review.</p>
          )}
          {!queueLoading && queue.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-300 text-gray-700">
                    {[
                      'Submission ID', 'Outlet', 'Owner', 'GST Number',
                      'Bank', 'Submitted', 'Sales User',
                      'Bank', 'GST', 'Address', 'Owner',
                    ].map((h, i) => (
                      <th key={`qh-${i}`} className="px-3 py-2 font-medium whitespace-nowrap text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-gray-50 border-b border-gray-200 text-gray-400 text-xs">
                    {['', '', '', '', '', '', '', 'Status', 'Status', 'Status', 'Status'].map((sub, i) => (
                      <th key={`qs-${i}`} className="px-3 pb-1 font-normal italic">{sub}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queue.map((row, ri) => (
                    <tr
                      key={row.submissionId}
                      className={`border-b border-gray-100 hover:bg-gray-50 ${ri % 2 === 1 ? 'bg-gray-50/40' : ''}`}
                    >
                      <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.submissionId}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-700">{row.outletName}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{row.ownerName}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap">{row.gstNumber || '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{row.bankName}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-400">{isoToDate(row.submittedAt)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.salesUser}</td>
                      {/* Pending status chips for all 4 fields */}
                      {(['Bank', 'GST', 'Address', 'Owner'] as const).map(f => (
                        <td key={f} className="px-3 py-1.5">
                          <span className="inline-block text-xs font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 border border-gray-200">
                            {f}: —
                          </span>
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

      {/* ── Step 1: Export ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">
            Step 1 — Export Review Dump
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-gray-500">
            Download the Excel dump of all pending submissions. The sheet contains all context
            columns pre-filled and 10 blank verification columns for Gifsy to complete offline
            (bank penny-drop, GST portal check, address + owner approval, decision + reason).
          </p>
          <Button
            onClick={handleExport}
            disabled={exportLoading || queueLoading || queue.length === 0}
            size="sm"
            className="flex items-center gap-1.5 bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white"
          >
            {exportLoading
              ? <><RefreshCw className="h-3 w-3 animate-spin" />Exporting…</>
              : <><Download className="h-3 w-3" />Download KYC Review Dump (.xlsx)</>}
          </Button>
          {exportError && (
            <p className="text-xs text-red-600 font-medium">{exportError}</p>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: Upload + Validate ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">
            Step 2 — Upload Validated Results
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-gray-500">
            After filling the verification columns offline, upload the completed sheet here.
            Click <strong>Validate</strong> to run a dry-run — all rows must pass before
            you can commit.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-gray-600">Select file (.xlsx):</span>
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={e => {
                  setUploadFile(e.target.files?.[0] ?? null)
                  setPreview(null)
                  setCommitted(null)
                  setCommitError(null)
                }}
                className="text-xs text-gray-600 file:mr-2 file:py-1 file:px-2 file:rounded file:border file:border-gray-300 file:text-xs file:bg-gray-50 hover:file:bg-gray-100"
              />
            </label>

            <Button
              onClick={handleValidate}
              disabled={!uploadFile || previewLoading}
              size="sm"
              variant="outline"
              className="flex items-center gap-1.5 border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-red-50"
            >
              {previewLoading
                ? <><RefreshCw className="h-3 w-3 animate-spin" />Validating…</>
                : <><Upload className="h-3 w-3" />Validate (Preview)</>}
            </Button>
          </div>

          {previewError && (
            <p className="text-xs text-red-600 font-medium flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />{previewError}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Preview results ────────────────────────────────────────────────── */}
      {preview && (
        <>
          {/* Summary chips */}
          <div className="flex flex-wrap gap-3">
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
              <p className="text-2xl font-bold text-green-700">{preview.summary.toApprove}</p>
              <p className="text-xs text-green-600 mt-0.5">To approve</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
              <p className="text-2xl font-bold text-amber-700">{preview.summary.toReupload}</p>
              <p className="text-xs text-amber-600 mt-0.5">Re-upload</p>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
              <p className="text-2xl font-bold text-red-700">{preview.summary.toReject}</p>
              <p className="text-xs text-red-600 mt-0.5">Reject</p>
            </div>
            <div className={`border rounded-lg px-4 py-2 text-center min-w-[80px] ${preview.summary.errors > 0 ? 'bg-red-50 border-red-300' : 'bg-gray-100 border-gray-200'}`}>
              <p className={`text-2xl font-bold ${preview.summary.errors > 0 ? 'text-red-700' : 'text-gray-500'}`}>
                {preview.summary.errors}
              </p>
              <p className={`text-xs mt-0.5 ${preview.summary.errors > 0 ? 'text-red-600' : 'text-gray-500'}`}>Errors</p>
            </div>
            <div className="bg-gray-100 border border-gray-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
              <p className="text-2xl font-bold text-[#1A1A2E]">{preview.summary.total}</p>
              <p className="text-xs text-gray-500 mt-0.5">Total rows</p>
            </div>
          </div>

          {/* Preview table */}
          {preview.previewRows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">
                  Preview — {preview.previewRows.length} valid row{preview.previewRows.length !== 1 ? 's' : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="text-xs border-collapse w-full">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-300 text-gray-700">
                        {['Submission ID', 'Outlet', 'Decision', 'Bank', 'GST', 'Address', 'Owner', 'GST Reg. Type', 'Resulting Status', 'Reason'].map(h => (
                          <th key={h} className="px-3 py-2 font-medium whitespace-nowrap text-left">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.previewRows.map((row, ri) => (
                        <tr
                          key={row.submissionId}
                          className={`border-b border-gray-100 hover:bg-gray-50 ${ri % 2 === 1 ? 'bg-gray-50/40' : ''}`}
                        >
                          <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.submissionId}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap text-gray-700">{row.outletName}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">{decisionBadge(row.decision)}</td>
                          <td className="px-3 py-1.5">{fieldChip(row.bankStatus, 'Bank')}</td>
                          <td className="px-3 py-1.5">{fieldChip(row.gstStatus, 'GST')}</td>
                          <td className="px-3 py-1.5">{fieldChip(row.addressStatus, 'Addr')}</td>
                          <td className="px-3 py-1.5">{fieldChip(row.ownerStatus, 'Owner')}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap text-gray-500">{row.gstRegistrationType ?? '—'}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <span className={`text-xs font-semibold ${
                              row.resultingStatus === 'APPROVED'            ? 'text-green-700'
                              : row.resultingStatus === 'RE_UPLOAD_REQUIRED' ? 'text-amber-700'
                              : 'text-red-700'
                            }`}>
                              {row.resultingStatus}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-gray-500 max-w-[180px] truncate" title={row.reason}>
                            {row.reason ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Errors list */}
          {preview.errors.length > 0 && (
            <Card className="border-red-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-red-700 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  {preview.errors.length} Error{preview.errors.length !== 1 ? 's' : ''} — resolve before committing
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="text-xs border-collapse w-full">
                  <thead>
                    <tr className="bg-red-50 border-b border-red-200 text-red-700">
                      {['Row #', 'Submission ID', 'Error'].map(h => (
                        <th key={h} className="px-3 py-2 font-medium text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.errors.map((err, ei) => (
                      <Fragment key={`err-${err.rowNumber}-${ei}`}>
                        <tr className={`border-b border-red-100 ${ei % 2 === 1 ? 'bg-red-50/30' : ''}`}>
                          <td className="px-3 py-1.5 font-mono text-red-600 whitespace-nowrap">{err.rowNumber}</td>
                          <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{err.submissionId}</td>
                          <td className="px-3 py-1.5 text-gray-700">{err.message}</td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* ── Step 3: Commit ──────────────────────────────────────────────── */}
          {!committed && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Step 3 — Commit Approvals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {preview.errors.length > 0 ? (
                  <p className="text-xs text-amber-700 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Resolve all {preview.errors.length} error{preview.errors.length !== 1 ? 's' : ''} above before committing.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">
                    All rows validated. Click <strong>Commit</strong> to apply — decisions will be
                    recorded and outlet statuses updated.
                  </p>
                )}
                <Button
                  onClick={handleCommit}
                  disabled={preview.errors.length > 0 || commitLoading || !uploadFile}
                  size="sm"
                  className="flex items-center gap-1.5 bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white"
                >
                  {commitLoading
                    ? <><RefreshCw className="h-3 w-3 animate-spin" />Committing…</>
                    : <><CheckCircle className="h-3 w-3" />Commit Approvals</>}
                </Button>
                {commitError && (
                  <p className="text-xs text-red-600 font-medium flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />{commitError}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ── Commit success ──────────────────────────────────────────────────── */}
      {committed && (
        <Card className="border-green-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-green-700 flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />Bulk verification committed
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
                <p className="text-2xl font-bold text-green-700">{committed.committed.toApprove}</p>
                <p className="text-xs text-green-600 mt-0.5">Approved</p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
                <p className="text-2xl font-bold text-amber-700">{committed.committed.toReupload}</p>
                <p className="text-xs text-amber-600 mt-0.5">Re-upload</p>
              </div>
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-center min-w-[80px]">
                <p className="text-2xl font-bold text-red-700">{committed.committed.toReject}</p>
                <p className="text-xs text-red-600 mt-0.5">Rejected</p>
              </div>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {committed.message}
            </p>
          </CardContent>
        </Card>
      )}

    </div>
  )
}
