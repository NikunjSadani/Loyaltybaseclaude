'use client'

/**
 * /admin/kyc/approvals
 *
 * KYC Approvals — Verification Workspace (Lane A primary surface).
 *
 * Unified hybrid Excel + portal workspace:
 *   1. Export the KYC review dump (Excel with all context + doc links + blank decision cols).
 *   2. Upload validated results → dry-run preview (merges Excel decisions into in-memory state).
 *   3. Commit the validated file → apply=true.
 *   4. Per-entry portal panel — view details/documents, approve/reject each of the 7 fields
 *      via POST /api/kyc/:id/verify.
 *
 * Auth: GIFSY_ADMIN only.
 *
 * Fetch wiring (all go through the S6 proxy → NestJS /v1/*):
 *   queue:   GET  /api/kyc/review-queue          (new endpoint, Part A)
 *   export:  GET  /api/kyc/review-dump            (StreamableFile xlsx)
 *   preview: POST /api/kyc/bulk-verify?apply=false (dry-run)
 *   commit:  POST /api/kyc/bulk-verify?apply=true  (commit)
 *   field:   POST /api/kyc/:id/verify             (per-field approve/reject)
 *
 * Responses are globally enveloped as { success, data } by the backend
 * TransformInterceptor — unwrapped here at each call site.
 */

import { Fragment, useState, useCallback, useEffect } from 'react'
import {
  Download, Upload, CheckCircle, XCircle, RefreshCw,
  AlertTriangle, MapPin, FileText,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import DownloadErrorReportButton from '@/components/admin/DownloadErrorReportButton'

// ─── Local types ──────────────────────────────────────────────────────────────

type KycFieldKey =
  | 'PAYMENT'
  | 'GST_VALIDATION'
  | 'GST_DOCUMENT'
  | 'ADDRESS'
  | 'ADDRESS_DOCUMENT'
  | 'BOARD_PHOTO'
  | 'OWNER_PHOTO'

type KycFieldDecision = 'PENDING' | 'APPROVED' | 'REJECTED'

interface KycFieldState {
  decision: KycFieldDecision
  remark?: string
  source?: 'EXCEL' | 'PORTAL'
}

interface KycApprovalEntry {
  submissionId: string
  clientId: string
  outletCode: string
  outletName: string
  ownerName: string
  mobile: string
  partnerClass: string
  gstNumber: string
  panNumber: string
  address: string
  city: string
  state: string
  pincode: string
  paymentMode: string | null
  bankName?: string | null
  accountHolderName?: string | null
  accountNumber?: string | null
  ifscCode?: string | null
  upiId?: string | null
  nameMismatch?: boolean
  boardGeo?: { lat: number; lng: number } | null
  documents?: {
    gstCertificateUrl?: string
    addressDocUrl?: string
    selfDeclarationUrl?: string
    boardPhotoUrl?: string
    ownerPhotoUrl?: string
    chequeUrl?: string
  }
  fields: Record<KycFieldKey, KycFieldState>
}

/** Dry-run preview response (apply=false). */
interface KycVerifyUpdate {
  submissionId: string
  fields: Partial<Record<KycFieldKey, { decision: 'APPROVED' | 'REJECTED'; remark?: string }>>
}

interface KycVerifyPreviewResult {
  committed: false
  updates: KycVerifyUpdate[]
  errors: { rowNumber: number; submissionId: string; message: string }[]
  summary: { rowsParsed: number; fieldsSet: number; errors: number }
}

/** Commit response (apply=true). */
interface KycVerifyCommitResult {
  committed: true
  results: { submissionId: string; outcome: string; detail?: string }[]
  errors: { rowNumber: number; submissionId: string; message: string }[]
  summary: {
    rowsParsed: number
    fieldsSet: number
    parseErrors: number
    approved: number
    reupload: number
    recorded: number
    skipped: number
    commitErrors: number
  }
}

/** Per-field verify response from POST /api/kyc/:id/verify */
interface KycVerifyFieldResponse {
  submissionId: string
  fieldKey: KycFieldKey
  fieldDecision: 'APPROVED' | 'REJECTED'
  derivedStatus: string
  approvedCount: number
  rejectedFields: KycFieldKey[]
  outcome: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FIELD_ORDER: KycFieldKey[] = [
  'PAYMENT',
  'GST_VALIDATION',
  'GST_DOCUMENT',
  'ADDRESS',
  'ADDRESS_DOCUMENT',
  'BOARD_PHOTO',
  'OWNER_PHOTO',
]

const FIELD_LABELS: Record<KycFieldKey, string> = {
  PAYMENT: 'Payment (Bank/UPI)',
  GST_VALIDATION: 'GST Validation',
  GST_DOCUMENT: 'GST Document',
  ADDRESS: 'Address',
  ADDRESS_DOCUMENT: 'Address Document',
  BOARD_PHOTO: 'Store Board Photo',
  OWNER_PHOTO: 'Owner Photo',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isTerminal(d: KycFieldDecision): boolean {
  return d === 'APPROVED' || d === 'REJECTED'
}

function isPdf(url: string): boolean {
  return url.toLowerCase().includes('.pdf') || url.toLowerCase().includes('/pdf')
}

function defaultFields(): Record<KycFieldKey, KycFieldState> {
  const out = {} as Record<KycFieldKey, KycFieldState>
  for (const k of FIELD_ORDER) out[k] = { decision: 'PENDING' }
  return out
}

/** Unwrap the backend { success, data } envelope. Throws on success=false. */
async function unwrapJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` })) as
    | { success: true; data: T }
    | { success: false; error?: string }
  if (!res.ok || !body.success) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
  }
  return (body as { success: true; data: T }).data
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DecisionChip({ decision, source }: { decision: KycFieldDecision; source?: 'EXCEL' | 'PORTAL' }) {
  const base = 'inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full'
  const color =
    decision === 'APPROVED'
      ? 'bg-green-100 text-green-800'
      : decision === 'REJECTED'
      ? 'bg-red-100 text-red-700'
      : 'bg-gray-100 text-gray-500'
  return (
    <span className={`${base} ${color}`}>
      {decision === 'APPROVED' && <CheckCircle className="h-3 w-3" />}
      {decision === 'REJECTED' && <XCircle className="h-3 w-3" />}
      {decision}
      {source && (
        <span className="ml-1 text-[10px] font-normal opacity-70">[{source}]</span>
      )}
    </span>
  )
}

function ProgressPill({ fields }: { fields: Record<KycFieldKey, KycFieldState> }) {
  const done = FIELD_ORDER.filter(k => isTerminal(fields[k].decision)).length
  const total = FIELD_ORDER.length
  const allDone = done === total
  const color = allDone ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>
      {done}/{total} done
    </span>
  )
}

function FieldDots({ fields }: { fields: Record<KycFieldKey, KycFieldState> }) {
  return (
    <span className="flex gap-0.5">
      {FIELD_ORDER.map(k => {
        const d = fields[k].decision
        const color =
          d === 'APPROVED' ? 'bg-green-500' : d === 'REJECTED' ? 'bg-red-500' : 'bg-gray-300'
        return <span key={k} className={`inline-block h-2 w-2 rounded-full ${color}`} title={FIELD_LABELS[k]} />
      })}
    </span>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function KycApprovalsPage() {
  // ── Entry list ─────────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<KycApprovalEntry[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  // ── Brand filter (cross-tenant Gifsy queue, #38) — the review-queue now spans
  //    every brand for the platform operator; this filters the list by tenant. Only
  //    surfaced when >1 brand is present (i.e. the Gifsy cross-tenant view).
  const [brandFilter, setBrandFilter] = useState<string>('ALL')

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // ── Upload + validate (preview) ────────────────────────────────────────────
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [previewResult, setPreviewResult] = useState<KycVerifyPreviewResult | null>(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  // ── Commit state ───────────────────────────────────────────────────────────
  const [commitResult, setCommitResult] = useState<KycVerifyCommitResult | null>(null)
  const [commitLoading, setCommitLoading] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  // ── Export ─────────────────────────────────────────────────────────────────
  const [exportLoading, setExportLoading] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // ── Portal-field remark inputs (keyed submissionId+fieldKey) ───────────────
  const [remarkInputs, setRemarkInputs] = useState<Record<string, string>>({})

  // ── Per-field loading / error state ───────────────────────────────────────
  const [fieldLoading, setFieldLoading] = useState<Record<string, boolean>>({})
  const [fieldError, setFieldError] = useState<Record<string, string>>({})

  // ── Lightbox (enlarged photo) ──────────────────────────────────────────────
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null)

  // ── Load entries on mount ──────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setListLoading(true)
      setListError(null)
      try {
        const res = await fetch('/api/kyc/review-queue')
        // Unwrap { success, data: { entries } }
        const data = await unwrapJson<{ entries: KycApprovalEntry[] }>(res)
        // Ensure every entry has all 7 fields initialised
        const normalised = data.entries.map(e => ({
          ...e,
          fields: { ...defaultFields(), ...e.fields },
        }))
        setEntries(normalised)
        if (normalised.length > 0) setSelectedId(normalised[0].submissionId)
      } catch (err) {
        setListError(err instanceof Error ? err.message : 'Failed to load entries.')
      } finally {
        setListLoading(false)
      }
    }
    load()
  }, [])

  // ── Export review dump ─────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setExportLoading(true)
    setExportError(null)
    try {
      const res = await fetch('/api/kyc/review-dump')
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `kyc-review-dump-${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(href)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setExportLoading(false)
    }
  }, [])

  // ── Upload + validate (bulk-verify dry-run preview, apply=false) ───────────
  const handleValidate = useCallback(async () => {
    if (!uploadFile) return
    setUploadLoading(true)
    setUploadError(null)
    setPreviewResult(null)
    setCommitResult(null)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      const res = await fetch('/api/kyc/bulk-verify?apply=false', {
        method: 'POST',
        body: fd,
      })
      // Unwrap { success, data: { committed, updates, errors, summary } }
      const result = await unwrapJson<KycVerifyPreviewResult>(res)
      setPreviewResult(result)
      // Merge preview updates into entries state (never clear portal decisions)
      setEntries(prev => {
        const map = new Map(prev.map(e => [e.submissionId, e]))
        for (const upd of result.updates) {
          const entry = map.get(upd.submissionId)
          if (!entry) continue
          const newFields = { ...entry.fields }
          for (const [rawKey, val] of Object.entries(upd.fields)) {
            const key = rawKey as KycFieldKey
            if (val) {
              newFields[key] = { decision: val.decision, remark: val.remark, source: 'EXCEL' }
            }
          }
          map.set(upd.submissionId, { ...entry, fields: newFields })
        }
        return Array.from(map.values())
      })
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Validation failed.')
    } finally {
      setUploadLoading(false)
    }
  }, [uploadFile])

  // ── Commit bulk-verify (apply=true) ───────────────────────────────────────
  const handleCommit = useCallback(async () => {
    if (!uploadFile || !previewResult) return
    setCommitLoading(true)
    setCommitError(null)
    setCommitResult(null)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      const res = await fetch('/api/kyc/bulk-verify?apply=true', {
        method: 'POST',
        body: fd,
      })
      // Unwrap { success, data: { committed, results, errors, summary } }
      const result = await unwrapJson<KycVerifyCommitResult>(res)
      setCommitResult(result)
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Commit failed.')
    } finally {
      setCommitLoading(false)
    }
  }, [uploadFile, previewResult])

  // ── Portal field decision (POST /api/kyc/:id/verify) ──────────────────────
  const applyFieldDecision = useCallback(
    async (submissionId: string, key: KycFieldKey, decision: 'APPROVED' | 'REJECTED', remark?: string) => {
      const fk = `${submissionId}:${key}`
      setFieldLoading(prev => ({ ...prev, [fk]: true }))
      setFieldError(prev => ({ ...prev, [fk]: '' }))
      try {
        const res = await fetch(`/api/kyc/${submissionId}/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fieldKey: key, decision, remark: remark ?? undefined }),
        })
        // Unwrap { success, data: KycVerifyFieldResponse }
        const result = await unwrapJson<KycVerifyFieldResponse>(res)

        // Reflect the returned field decision (authoritative from backend)
        setEntries(prev =>
          prev.map(e => {
            if (e.submissionId !== submissionId) return e
            return {
              ...e,
              fields: {
                ...e.fields,
                [key]: { decision: result.fieldDecision, remark: remark ?? undefined, source: 'PORTAL' as const },
              },
            }
          })
        )
      } catch (err) {
        setFieldError(prev => ({
          ...prev,
          [fk]: err instanceof Error ? err.message : 'Field verify failed.',
        }))
      } finally {
        setFieldLoading(prev => ({ ...prev, [fk]: false }))
      }
    },
    []
  )

  const remarkKey = (submissionId: string, key: KycFieldKey) => `${submissionId}:${key}`

  const setRemark = (submissionId: string, key: KycFieldKey, val: string) => {
    setRemarkInputs(prev => ({ ...prev, [remarkKey(submissionId, key)]: val }))
  }

  const getRemark = (submissionId: string, key: KycFieldKey) =>
    remarkInputs[remarkKey(submissionId, key)] ?? ''

  // ── Derived ────────────────────────────────────────────────────────────────
  const brands = Array.from(new Set(entries.map(e => e.clientId))).sort()
  const visibleEntries =
    brandFilter === 'ALL' ? entries : entries.filter(e => e.clientId === brandFilter)
  const selected = entries.find(e => e.submissionId === selectedId) ?? null

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-[#1A1A2E]">KYC Approvals — Verification Workspace</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-3xl">
          Hybrid Excel + portal verification: <strong>export</strong> the dump, fill the 7 decision
          columns offline (bank penny-drop, GST portal, address + photo review), then{' '}
          <strong>upload</strong> to preview, then <strong>commit</strong> to apply. Any field can
          also be set here in the portal — the last write per field wins, and blank Excel cells
          never clear a portal decision.
        </p>
      </div>

      {/* ── Top action bar ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Bulk Actions — 3-Step Flow</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* Step 1 — Export */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-gray-500 w-20">Step 1</span>
            <Button
              onClick={handleExport}
              disabled={exportLoading}
              size="sm"
              className="flex items-center gap-1.5 bg-[var(--brand-primary)] hover:bg-[#a00d24] text-white"
            >
              {exportLoading
                ? <><RefreshCw className="h-3 w-3 animate-spin" />Exporting…</>
                : <><Download className="h-3 w-3" />Export Review Dump (.xlsx)</>}
            </Button>
            <span className="text-xs text-gray-400">Download full dump — fill verification cols offline.</span>
            {exportError && (
              <span className="text-xs text-red-600 font-medium flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />{exportError}
              </span>
            )}
          </div>

          {/* Step 2 — Upload + Preview */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-bold text-gray-500 w-20">Step 2</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={e => {
                  setUploadFile(e.target.files?.[0] ?? null)
                  setPreviewResult(null)
                  setCommitResult(null)
                  setUploadError(null)
                  setCommitError(null)
                }}
                className="text-xs text-gray-600 file:mr-2 file:py-1 file:px-2 file:rounded file:border file:border-gray-300 file:text-xs file:bg-gray-50 hover:file:bg-gray-100"
              />
            </label>
            <Button
              onClick={handleValidate}
              disabled={!uploadFile || uploadLoading}
              size="sm"
              variant="outline"
              className="flex items-center gap-1.5 border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-red-50"
            >
              {uploadLoading
                ? <><RefreshCw className="h-3 w-3 animate-spin" />Validating…</>
                : <><Upload className="h-3 w-3" />Validate &amp; Preview</>}
            </Button>
            {uploadError && (
              <span className="text-xs text-red-600 font-medium flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />{uploadError}
              </span>
            )}
          </div>

          {/* Step 3 — Commit (only enabled after a clean preview) */}
          {previewResult && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-bold text-gray-500 w-20">Step 3</span>
              <Button
                onClick={handleCommit}
                disabled={commitLoading || !!commitResult}
                size="sm"
                className="flex items-center gap-1.5 bg-green-700 hover:bg-green-800 text-white disabled:opacity-40"
              >
                {commitLoading
                  ? <><RefreshCw className="h-3 w-3 animate-spin" />Committing…</>
                  : commitResult
                  ? <><CheckCircle className="h-3 w-3" />Committed</>
                  : <><CheckCircle className="h-3 w-3" />Commit (apply=true)</>}
              </Button>
              <span className="text-xs text-gray-400">
                Writes decisions to DB — triggers APPROVED / RE_UPLOAD side-effects.
              </span>
              {commitError && (
                <span className="text-xs text-red-600 font-medium flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />{commitError}
                </span>
              )}
            </div>
          )}

          {/* Preview summary */}
          {previewResult && !commitResult && (
            <div className="space-y-3 pt-1 border-t border-gray-100">
              <p className="text-xs text-gray-600">
                <strong>Preview:</strong> {previewResult.summary.rowsParsed} rows parsed ·{' '}
                {previewResult.summary.fieldsSet} fields merged ·{' '}
                {previewResult.summary.errors > 0 ? (
                  <span className="text-red-600 font-semibold">{previewResult.summary.errors} errors</span>
                ) : (
                  <span className="text-green-700 font-semibold">0 errors</span>
                )}
              </p>
              {previewResult.errors.length > 0 && (
                <ErrorTable errors={previewResult.errors} filename="kyc-bulk-verify-preview-errors.xlsx" />
              )}
            </div>
          )}

          {/* Commit result summary */}
          {commitResult && (
            <div className="space-y-3 pt-1 border-t border-gray-100">
              <p className="text-xs text-gray-600">
                <strong>Committed:</strong>{' '}
                {commitResult.summary.approved} approved ·{' '}
                {commitResult.summary.reupload} re-upload ·{' '}
                {commitResult.summary.recorded} recorded ·{' '}
                {commitResult.summary.skipped} skipped ·{' '}
                {commitResult.summary.commitErrors > 0 ? (
                  <span className="text-red-600 font-semibold">{commitResult.summary.commitErrors} commit errors</span>
                ) : (
                  <span className="text-green-700 font-semibold">0 commit errors</span>
                )}
              </p>
              {commitResult.errors.length > 0 && (
                <ErrorTable errors={commitResult.errors} filename="kyc-bulk-verify-commit-errors.xlsx" />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Two-pane workspace ─────────────────────────────────────────────── */}
      <div className="flex gap-4 items-start">

        {/* Left — queue list */}
        <div className="w-72 shrink-0 space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
            Queue
            {!listLoading && (
              <span className="ml-1 font-normal normal-case text-gray-400">
                ({visibleEntries.length}{brandFilter !== 'ALL' ? ` of ${entries.length}` : ''})
              </span>
            )}
          </p>

          {/* Brand filter — only when the queue spans multiple brands (Gifsy view, #38) */}
          {brands.length > 1 && (
            <select
              value={brandFilter}
              onChange={e => setBrandFilter(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-md px-2 py-1.5 bg-white text-gray-700"
              aria-label="Filter queue by brand"
            >
              <option value="ALL">All brands ({entries.length})</option>
              {brands.map(b => (
                <option key={b} value={b}>
                  {b} ({entries.filter(e => e.clientId === b).length})
                </option>
              ))}
            </select>
          )}

          {listLoading && (
            <div className="flex items-center gap-2 text-sm text-gray-400 px-1">
              <RefreshCw className="h-4 w-4 animate-spin" />Loading…
            </div>
          )}
          {listError && (
            <div className="text-xs text-red-600 flex items-center gap-1 px-1">
              <AlertTriangle className="h-3 w-3" />{listError}
            </div>
          )}
          {!listLoading && !listError && entries.length === 0 && (
            <p className="text-xs text-gray-400 px-1">No submissions pending review.</p>
          )}

          {visibleEntries.map(e => {
            const isSelected = e.submissionId === selectedId
            return (
              <button
                key={e.submissionId}
                onClick={() => setSelectedId(e.submissionId)}
                className={`w-full text-left rounded-lg border px-3 py-2.5 space-y-1 transition-colors ${
                  isSelected
                    ? 'border-[var(--brand-primary)] bg-red-50 shadow-sm'
                    : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-800 truncate">{e.outletName}</span>
                  <ProgressPill fields={e.fields} />
                </div>
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-gray-500 font-mono">{e.outletCode}</p>
                  {brands.length > 1 && (
                    <span className="text-[10px] bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5 font-medium">
                      {e.clientId}
                    </span>
                  )}
                </div>
                <FieldDots fields={e.fields} />
              </button>
            )
          })}
        </div>

        {/* Right — selected entry detail */}
        {selected ? (
          <div className="flex-1 min-w-0 space-y-4">

            {/* Entry header */}
            <Card>
              <CardContent className="pt-4 pb-3 space-y-2">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <span>
                    <span className="font-semibold text-gray-800">{selected.outletName}</span>
                    <span className="ml-2 text-gray-400 font-mono text-xs">{selected.outletCode}</span>
                  </span>
                  <span className="text-gray-600">{selected.ownerName}</span>
                  <span className="text-gray-500">{selected.mobile}</span>
                  <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 self-center">
                    {selected.partnerClass}
                  </span>
                </div>

                {/* Name mismatch banner */}
                {selected.nameMismatch && (
                  <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-xs text-amber-800">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Address name mismatch — self-declaration required
                  </div>
                )}

                {/* Board geo */}
                {selected.boardGeo && (
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <MapPin className="h-3 w-3 text-gray-400" />
                    Board photo location: {selected.boardGeo.lat}, {selected.boardGeo.lng}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Details grid */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Details</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                  <Fragment key="gst">
                    <dt className="text-gray-500">GST Number</dt>
                    <dd className="font-mono text-gray-800">{selected.gstNumber || '—'}</dd>
                  </Fragment>
                  <Fragment key="pan">
                    <dt className="text-gray-500">PAN</dt>
                    <dd className="font-mono text-gray-800">{selected.panNumber || '—'}</dd>
                  </Fragment>
                  <Fragment key="addr">
                    <dt className="text-gray-500">Address</dt>
                    <dd className="text-gray-700">
                      {selected.address}, {selected.city}, {selected.state} — {selected.pincode}
                    </dd>
                  </Fragment>
                  {selected.paymentMode === 'bank' ? (
                    <Fragment key="payment-bank">
                      <dt className="text-gray-500">Payment</dt>
                      <dd className="text-gray-700">
                        Bank — {selected.bankName ?? '—'}<br />
                        Holder: {selected.accountHolderName ?? '—'}<br />
                        A/C: {selected.accountNumber ?? '—'} &nbsp; IFSC: {selected.ifscCode ?? '—'}
                      </dd>
                    </Fragment>
                  ) : (
                    <Fragment key="payment-upi">
                      <dt className="text-gray-500">Payment</dt>
                      <dd className="text-gray-700">
                        {selected.paymentMode === 'upi' ? `UPI — ${selected.upiId ?? '—'}` : `Mode: ${selected.paymentMode ?? '—'}`}
                      </dd>
                    </Fragment>
                  )}
                </dl>
              </CardContent>
            </Card>

            {/* Documents (only shown if documents are present on the entry) */}
            {selected.documents && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Documents</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-3">
                    {(
                      [
                        { url: selected.documents.boardPhotoUrl,      label: 'Board Photo' },
                        { url: selected.documents.ownerPhotoUrl,      label: 'Owner Photo' },
                        { url: selected.documents.gstCertificateUrl,  label: 'GST Certificate' },
                        { url: selected.documents.addressDocUrl,      label: 'Address Document' },
                        { url: selected.documents.selfDeclarationUrl, label: 'Self-Declaration' },
                        { url: selected.documents.chequeUrl,          label: 'Cancelled Cheque' },
                      ] as { url?: string; label: string }[]
                    ).map(({ url, label }) =>
                      !url ? null : isPdf(url) ? (
                        <a
                          key={label}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex flex-col items-center justify-center gap-1 h-24 w-24 rounded border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                        >
                          <FileText className="h-6 w-6" />
                          <span className="text-[10px] text-center leading-tight px-1">{label} ↗</span>
                        </a>
                      ) : (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setLightbox({ url, label })}
                          title="Click to enlarge"
                          className="flex flex-col items-center gap-1 group"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={label}
                            className="h-24 w-24 object-cover rounded border border-gray-200 transition group-hover:ring-2 group-hover:ring-[var(--brand-primary)]"
                          />
                          <span className="text-[10px] text-gray-500">{label}</span>
                        </button>
                      )
                    )}
                  </div>
                  <p className="text-[10px] text-gray-400 mt-2">Click a photo to enlarge.</p>
                </CardContent>
              </Card>
            )}

            {/* 7 approval fields — wired to POST /api/kyc/:id/verify */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Field Decisions</CardTitle>
              </CardHeader>
              <CardContent className="divide-y divide-gray-100">
                {FIELD_ORDER.map(key => {
                  const fieldState = selected.fields[key]
                  const remark = getRemark(selected.submissionId, key)
                  const canReject = remark.trim().length > 0
                  const fk = remarkKey(selected.submissionId, key)
                  const isLoading = !!fieldLoading[fk]
                  const fError = fieldError[fk] ?? ''

                  return (
                    <div key={key} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                      {/* Label + chip */}
                      <div className="sm:w-52 shrink-0">
                        <p className="text-sm font-medium text-gray-700">{FIELD_LABELS[key]}</p>
                        <div className="mt-1">
                          <DecisionChip decision={fieldState.decision} source={fieldState.source} />
                        </div>
                        {fieldState.decision === 'REJECTED' && fieldState.remark && (
                          <p className="text-xs text-red-600 mt-0.5 italic">{fieldState.remark}</p>
                        )}
                      </div>

                      {/* Controls */}
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            disabled={isLoading}
                            onClick={() => applyFieldDecision(selected.submissionId, key, 'APPROVED')}
                            className="flex items-center gap-1 bg-green-600 hover:bg-green-700 text-white text-xs h-7 px-3 disabled:opacity-50"
                          >
                            {isLoading
                              ? <RefreshCw className="h-3 w-3 animate-spin" />
                              : <CheckCircle className="h-3 w-3" />}
                            Approve
                          </Button>

                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              placeholder="Remark (required to reject)"
                              value={remark}
                              disabled={isLoading}
                              onChange={e => setRemark(selected.submissionId, key, e.target.value)}
                              className="border border-gray-200 rounded px-2 py-1 text-xs h-7 w-52 focus:outline-none focus:ring-1 focus:ring-red-300 disabled:opacity-50"
                            />
                            <Button
                              size="sm"
                              disabled={!canReject || isLoading}
                              onClick={() => {
                                const r = remark.trim()
                                applyFieldDecision(selected.submissionId, key, 'REJECTED', r)
                                setRemark(selected.submissionId, key, '')
                              }}
                              title={canReject ? undefined : 'Enter a remark before rejecting'}
                              className="flex items-center gap-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white text-xs h-7 px-3"
                            >
                              <XCircle className="h-3 w-3" />Reject
                            </Button>
                          </div>
                          {!canReject && !isLoading && (
                            <span className="text-[10px] text-gray-400 italic">Enter remark to enable Reject</span>
                          )}
                        </div>
                        {fError && (
                          <span className="text-xs text-red-600 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />{fError}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>

            {/* Completion banner */}
            <CompletionBanner fields={selected.fields} />

          </div>
        ) : (
          !listLoading && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400 py-16">
              Select an entry from the queue to review.
            </div>
          )
        )}
      </div>

      {/* Lightbox — enlarged photo */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <div className="flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.url}
              alt={lightbox.label}
              className="max-w-[90vw] max-h-[80vh] object-contain rounded shadow-2xl"
            />
            <div className="flex items-center gap-4 text-white">
              <span className="text-sm font-medium">{lightbox.label}</span>
              <a href={lightbox.url} target="_blank" rel="noreferrer" className="text-xs text-blue-300 hover:underline">
                Open original ↗
              </a>
              <button
                onClick={() => setLightbox(null)}
                className="text-xs bg-white/20 hover:bg-white/30 rounded px-3 py-1"
              >
                Close ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Error table (shared by preview + commit) ─────────────────────────────────

function ErrorTable({ errors, filename = 'kyc-bulk-verify-errors.xlsx' }: { errors: { rowNumber: number; submissionId: string; message: string }[]; filename?: string }) {
  return (
    <div className="space-y-2">
    <div className="overflow-x-auto rounded border border-red-200">
      <table className="text-xs border-collapse w-full">
        <thead>
          <tr className="bg-red-50 border-b border-red-200 text-red-700">
            {['Row', 'Submission ID', 'Error'].map(h => (
              <th key={h} className="px-3 py-1.5 font-medium text-left">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {errors.map((err, ei) => (
            <tr key={`err-${err.rowNumber}-${ei}`} className={`border-b border-red-100 ${ei % 2 === 1 ? 'bg-red-50/30' : ''}`}>
              <td className="px-3 py-1.5 font-mono text-red-600 whitespace-nowrap">{err.rowNumber}</td>
              <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{err.submissionId}</td>
              <td className="px-3 py-1.5 text-gray-700">{err.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
      <DownloadErrorReportButton
        columns={['Row', 'Submission ID', 'Message']}
        rows={errors.map(e => ({
          Row:            e.rowNumber,
          'Submission ID': e.submissionId,
          Message:        e.message,
          __errors:       [e.message],
        }))}
        errorsByRow={(row) => (row.__errors as string[]) ?? []}
        filename={filename}
        sheetName="KYC Errors"
      />
    </div>
  )
}

// ─── Completion banner ────────────────────────────────────────────────────────

function CompletionBanner({ fields }: { fields: Record<KycFieldKey, KycFieldState> }) {
  const terminalCount = FIELD_ORDER.filter(k => isTerminal(fields[k].decision)).length
  const total = FIELD_ORDER.length
  const allTerminal = terminalCount === total
  const rejectedKeys = FIELD_ORDER.filter(k => fields[k].decision === 'REJECTED')

  if (!allTerminal) {
    return (
      <div className="rounded-lg bg-gray-100 border border-gray-200 px-4 py-3 text-sm text-gray-600">
        {terminalCount} of {total} fields reviewed
      </div>
    )
  }

  if (rejectedKeys.length === 0) {
    return (
      <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800 flex items-center gap-2">
        <CheckCircle className="h-4 w-4 shrink-0" />
        All fields approved — outlet credentials created + WhatsApp sent (committed via backend)
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
      <RefreshCw className="h-4 w-4 shrink-0" />
      Sent back to sales for re-share:{' '}
      <span className="font-semibold">
        {rejectedKeys.map(k => FIELD_LABELS[k]).join(', ')}
      </span>
    </div>
  )
}
