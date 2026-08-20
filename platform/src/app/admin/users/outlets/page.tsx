'use client';

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import {
  Store, Search, Upload, Download, X, AlertCircle, CheckCircle2,
  Loader2, Building2, MapPin, Users, FileText, ArrowRightLeft,
  RefreshCw, Eye, Clock, XCircle, CheckCircle, Archive, SquarePen,
} from 'lucide-react';
import {
  validateOutletUploadHeaders,
  validateReKYCFlagHeaders,
  validateDeactivateHeaders,
  validateOutletUpload,
  validateReKYCFlagUpload,
  validateDeactivateUpload,
  validateParkUpload,
  validateUnparkUpload,
  parseOutletUploadRows,
  parseReKYCFlagRows,
  parseDeactivateRows,
  getOutletAdditionTemplateData,
  getReKYCFlagTemplateData,
  getDeactivateTemplateData,
  getParkTemplateData,
  getUnparkTemplateData,
  generateOutletGuideHtml,
  buildOutletUploadErrorReport,
  buildReKYCErrorReport,
  buildDeactivateErrorReport,
  type UploadErrorReport,
} from '@/lib/outlet-upload';
import DownloadErrorReportButton from '@/components/admin/DownloadErrorReportButton';
import { useGifsySettings } from '@/lib/gifsy-settings';
import { downloadBlob } from '@/lib/download';
import { chunkArray } from '@/lib/chunk';
import type { HierarchyEmployee } from '@/types';
import type {
  OutletUploadRow,
  OutletUploadValidationResult,
  ReKYCFlagRow,
  ReKYCFlagValidationResult,
  OutletDeactivateValidationResult,
  OutletParkValidationResult,
  OutletUnparkValidationResult,
  KYCStatus,
} from '@/types';

// ─── Constants ─────────────────────────────────────────────────────────────────

const LEAF_ROLE_CODE    = 'XSR';     // Deoleo config
// Fallback allow-lists used only until per-tenant Gifsy Settings hydrate. The live values
// come from useGifsySettings().outletPrograms / outletCategories (editable in Gifsy Settings).
const DEFAULT_PROGRAMS   = ['Trade Loyalty', 'Gold Programme'];
const DEFAULT_CATEGORIES = ['Premium', 'Standard', 'Economy'];

// ─── Outlet master data ──────────────────────────────────────────────────────────

type KYCStatusLocal = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'RE_KYC_REQUIRED' | 'PARKED';

// Server pagination envelope (mirrors channel-partners / admin users).
interface Pagination {
  page:  number;
  limit: number;
  total: number;
  pages: number;
}

const PAGE_SIZE = 50;

// The backend caps every outlet bulk endpoint at 500 rows/request (a transaction-scale safety
// valve, not a real limit). We hide that entirely: any upload is POSTed in sequential 500-row
// batches, so no row cap ever surfaces in the UI. Outlet Master already did this inline; this
// shared helper gives Re-KYC / Deactivate / Park / Un-park (and the master's un-park step) the same.
const UPLOAD_BATCH_SIZE = 500;

async function postInBatches<T>(
  url: string,
  items: T[],
  buildBody: (batch: T[]) => unknown,
  onProgress?: (done: number, total: number) => void,
): Promise<
  | { ok: true; data: Record<string, unknown>[] }
  | { ok: false; message: string; appliedBatches: number; totalBatches: number }
> {
  const batches = chunkArray(items, UPLOAD_BATCH_SIZE);
  const data: Record<string, unknown>[] = [];
  for (let b = 0; b < batches.length; b++) {
    onProgress?.(b, batches.length);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(batches[b])),
      });
    } catch {
      return { ok: false, message: 'Network error — please try again', appliedBatches: b, totalBatches: batches.length };
    }
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try { const j = await res.json(); message = j?.error ?? j?.message ?? message; } catch { /* non-JSON body */ }
      return { ok: false, message, appliedBatches: b, totalBatches: batches.length };
    }
    const j = await res.json().catch(() => null);
    data.push((j?.data ?? j ?? {}) as Record<string, unknown>);
  }
  return { ok: true, data };
}

/** Suffix appended to a batched-upload error when some batches already succeeded, so the admin
 *  knows to re-upload only the remainder rather than the whole file. */
function batchRemainderNote(appliedBatches: number): string {
  return appliedBatches > 0
    ? ` (${appliedBatches} batch${appliedBatches > 1 ? 'es' : ''} of 500 already applied — re-upload the remaining rows.)`
    : '';
}

interface MockOutlet {
  outletId:        string;
  outletName:      string;
  outletType:      string;
  programName:     string;
  programCategory: string;
  beat:            string;
  distributorId:   string;
  distributorName: string;
  zone:            string;
  city:            string;
  state:           string;
  metro:           boolean;
  xsrId:           string;
  xsrName:         string;
  kycStatus:       KYCStatusLocal;
  isActive:        boolean;
  addedDate:       string;
  phone?:          string;
  // Owner-group linkage (from GET /api/admin/outlets). parentCode is the parent's
  // partnerCode (e.g. "CPP01"); undefined/blank → outlet is standalone (ungrouped).
  parentId?:           string;
  parentCode?:         string;
  parentBusinessName?: string;
}

// ─── KYC status config ─────────────────────────────────────────────────────────

const KYC_STATUS_CONFIG: Record<KYCStatusLocal, { label: string; badgeCls: string; icon: React.ReactNode }> = {
  NOT_STARTED:      { label: 'KYC Pending',    badgeCls: 'bg-gray-100 text-gray-600',        icon: <AlertCircle  className="w-3 h-3" /> },
  IN_PROGRESS:      { label: 'In Progress',    badgeCls: 'bg-blue-100 text-blue-700',         icon: <Clock        className="w-3 h-3" /> },
  SUBMITTED:        { label: 'Submitted',      badgeCls: 'bg-purple-100 text-purple-700',     icon: <Clock        className="w-3 h-3" /> },
  APPROVED:         { label: 'KYC Approved',   badgeCls: 'bg-green-100 text-green-700',       icon: <CheckCircle  className="w-3 h-3" /> },
  REJECTED:         { label: 'Rejected',       badgeCls: 'bg-red-100 text-red-700',           icon: <XCircle      className="w-3 h-3" /> },
  RE_KYC_REQUIRED:  { label: 'Re-KYC Required',badgeCls: 'bg-amber-100 text-amber-700',       icon: <RefreshCw    className="w-3 h-3" /> },
  PARKED:           { label: 'Parked',         badgeCls: 'bg-slate-100 text-slate-600',       icon: <Archive      className="w-3 h-3" /> },
};

const TYPE_COLORS: Record<string, string> = {
  SSS:     'bg-gray-100 text-gray-600',
  WHOLESALER:   'bg-blue-50 text-blue-700',
  SUB_STOCKIST: 'bg-purple-50 text-purple-700',
  SSS_TOT:      'bg-indigo-50 text-indigo-700',
};

// ─── Shared upload hook ────────────────────────────────────────────────────────

type UploadState = 'idle' | 'parsed' | 'confirmed';

// ─── Validation panel component ────────────────────────────────────────────────

function ValidationPanel<R extends { rowNum: number; outletId: string; status: string; errors: string[] }>({
  testId,
  result,
  onConfirm,
  onClear,
  confirmLabel = 'Confirm Upload',
  errorReportFilename,
  errorReport,
  submitting,
  submitNote,
  parentIdByRow,
}: {
  testId:        string;
  result:        { headerError: string | null; rows: R[]; hasErrors: boolean; canProceed: boolean; summary: Record<string, number> };
  onConfirm:     () => void;
  onClear:       () => void;
  confirmLabel?: string;
  errorReportFilename: string;
  errorReport?:  UploadErrorReport;
  /** True while the upload is being submitted (batches in flight) — disables the
   *  buttons and shows the progress note. */
  submitting?:   boolean;
  submitNote?:   string | null;
  /** Optional per-row Parent ID lookup (keyed by rowNum). When provided (outlet
   *  master upload), a "Parent ID" preview column is shown so the admin can see
   *  which outlets will be linked to an owner group before confirming. */
  parentIdByRow?: Record<number, string>;
}) {
  if (result.headerError) {
    return (
      <div data-testid={testId} className="bg-red-50 border border-red-200 rounded-xl p-4">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-700">Header Error</p>
            <p className="text-xs text-red-600 mt-1">{result.headerError}</p>
          </div>
        </div>
        <button onClick={onClear} className="mt-3 text-xs text-red-600 hover:underline">Clear and try again</button>
      </div>
    );
  }

  return (
    <div data-testid={testId} className="space-y-3">
      {/* Summary chips */}
      <div className="grid grid-cols-3 gap-3">
        {Object.entries(result.summary).map(([k, v]) => (
          <div key={k} className={`p-3 rounded-xl border text-center ${k === 'errors' && (v as number) > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
            <p className={`text-xl font-bold ${k === 'errors' && (v as number) > 0 ? 'text-red-700' : 'text-gray-800'}`}>{v as number}</p>
            <p className={`text-xs mt-0.5 capitalize ${k === 'errors' && (v as number) > 0 ? 'text-red-600' : 'text-gray-500'}`}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</p>
          </div>
        ))}
      </div>

      {/* Row results */}
      {result.rows.length > 0 && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto max-h-64">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Row</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Outlet ID</th>
                  {parentIdByRow && <th className="px-3 py-2 text-left font-medium text-gray-500">Parent ID</th>}
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {result.rows.map((r) => (
                  <tr key={r.rowNum} className={r.status === 'ERROR' ? 'bg-red-50' : 'bg-white'}>
                    <td className="px-3 py-2 text-gray-500">{r.rowNum}</td>
                    <td className="px-3 py-2 font-mono text-gray-700">{r.outletId || '—'}</td>
                    {parentIdByRow && <td className="px-3 py-2 font-mono text-gray-600">{parentIdByRow[r.rowNum] || '—'}</td>}
                    <td className="px-3 py-2">
                      {r.status === 'OK'
                        ? <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />OK</span>
                        : <span className="text-red-600 flex items-center gap-1"><AlertCircle className="w-3 h-3" />Error</span>
                      }
                    </td>
                    <td className="px-3 py-2 text-red-600">{r.errors.join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result.hasErrors && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-700">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Fix all errors in the Excel file and re-upload. The file will not be processed until all rows are valid.</span>
          </div>
          {errorReport && (
            <DownloadErrorReportButton
              columns={errorReport.columns}
              rows={errorReport.rows}
              errorsByRow={(row) => (row.__errors as string[]) ?? []}
              filename={errorReportFilename}
              sheetName="Errors"
              errorHeader={errorReport.errorHeader}
            />
          )}
        </div>
      )}

      <div className="flex gap-3">
        <button onClick={onClear} disabled={submitting} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          Clear
        </button>
        {result.canProceed && (
          <button
            data-testid="confirm-outlet-upload-btn"
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 animate-spin" />{submitNote ?? 'Saving…'}</>
              : confirmLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Success panel ─────────────────────────────────────────────────────────────

function SuccessPanel({ message, detail, onDone }: { message: string; detail?: React.ReactNode; onDone: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
        <CheckCircle2 className="w-6 h-6 text-green-600" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-900">{message}</p>
        {detail !== undefined
          ? <div className="text-xs text-gray-500 mt-1">{detail}</div>
          : <p className="text-xs text-gray-500 mt-1">Data has been processed and the outlet list will reflect changes momentarily.</p>}
      </div>
      <button onClick={onDone} className="px-5 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)]">
        Done
      </button>
    </div>
  );
}

// ─── Upload section component ──────────────────────────────────────────────────

function UploadSection({
  testIdInput,
  testIdPanel,
  onFileChange,
  validationResult,
  uploadState,
  onConfirm,
  onClear,
  confirmLabel,
  submitError,
  errorReportFilename,
  errorReport,
  uploadDisabledReason,
  submitting,
  submitNote,
  parentIdByRow,
  successMessage,
  successDetail,
}: {
  testIdInput:       string;
  testIdPanel:       string;
  errorReportFilename: string;
  onFileChange:      (file: File) => void;
  validationResult:  OutletUploadValidationResult | ReKYCFlagValidationResult | OutletDeactivateValidationResult | OutletParkValidationResult | OutletUnparkValidationResult | null;
  uploadState:       UploadState;
  onConfirm:         () => void;
  onClear:           () => void;
  confirmLabel?:     string;
  /** API error surfaced after a failed confirm (e.g. all-invalid 400). */
  submitError?:      string | null;
  errorReport?:      UploadErrorReport;
  /** Submit-in-flight state (batched upload progress note). */
  submitting?:       boolean;
  submitNote?:       string | null;
  /** When set, the upload is blocked (tenant config still loading / failed /
   *  no types enabled) and this reason is shown instead of the dropzone. */
  uploadDisabledReason?: string | null;
  /** Optional per-row Parent ID lookup (keyed by rowNum) — outlet master only.
   *  Passed through to the ValidationPanel to render the Parent ID preview column. */
  parentIdByRow?: Record<number, string>;
  /** Optional custom success message + detail node (Park / Un-park surface the
   *  backend {parked|unparked} count + any notFound codes). Defaults to the generic panel. */
  successMessage?: string;
  successDetail?:  React.ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (!file.name.endsWith('.xlsx')) {
      setFileError('Only .xlsx files are accepted. CSV is not supported as it cannot hold multiple sheets.');
      return;
    }
    setFileError('');
    onFileChange(file);
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        data-testid={testIdInput}
        className="hidden"
        onChange={handleChange}
      />

      {fileError && (
        <div data-testid="file-type-error" className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{fileError}</span>
        </div>
      )}

      {uploadState === 'idle' && uploadDisabledReason && (
        <div
          data-testid="upload-disabled"
          className="w-full border-2 border-dashed border-gray-200 rounded-xl py-10 flex flex-col items-center gap-3 bg-gray-50/70"
        >
          <AlertCircle className="w-7 h-7 text-amber-400" />
          <p className="text-sm font-medium text-gray-500 text-center px-6">{uploadDisabledReason}</p>
        </div>
      )}

      {uploadState === 'idle' && !uploadDisabledReason && !fileError && (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full border-2 border-dashed border-gray-200 rounded-xl py-10 flex flex-col items-center gap-3 hover:border-[var(--brand-primary)]/40 hover:bg-green-50/30 transition-colors"
        >
          <Upload className="w-8 h-8 text-gray-300" />
          <div className="text-center">
            <p className="text-sm font-medium text-gray-700">Drop your XLSX file here or click to browse</p>
            <p className="text-xs text-gray-400 mt-1">Only .xlsx format accepted · Large files upload automatically in batches</p>
          </div>
        </button>
      )}

      {uploadState === 'idle' && !uploadDisabledReason && fileError && (
        <button
          type="button"
          onClick={() => { setFileError(''); fileRef.current?.click(); }}
          className="mt-2 text-sm text-[var(--brand-primary)] hover:underline"
        >
          Try again
        </button>
      )}

      {submitError && (
        <div data-testid="submit-error" className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{submitError}</span>
        </div>
      )}

      {(uploadState === 'parsed' || uploadState === 'confirmed') && validationResult && (
        uploadState === 'confirmed' ? (
          <SuccessPanel
            message={successMessage ?? 'Upload processed successfully'}
            detail={successDetail}
            onDone={onClear}
          />
        ) : (
          <ValidationPanel
            testId={testIdPanel}
            result={validationResult as any}
            onConfirm={onConfirm}
            onClear={onClear}
            confirmLabel={confirmLabel}
            errorReportFilename={errorReportFilename}
            errorReport={errorReport}
            submitting={submitting}
            submitNote={submitNote}
            parentIdByRow={parentIdByRow}
          />
        )
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

type TabId = 'master' | 'rekyc' | 'deactivate' | 'parked';

/** Backend result of a park / un-park POST — count applied + codes the backend skipped. */
interface ParkResult { count: number; notFound: string[]; }

// ── Outlet edit modal ───────────────────────────────────────────────────────────
// Single-record edit of the OUTLET MASTER fields only — exactly the columns the bulk
// "Outlet Master" Excel upload can change. Sensitive identity/money/address fields
// (owner name, phone, PAN, GST, bank, address) are NOT here by design — they stay on
// the KYC / Re-KYC flow. Grouping + active-state keep their dedicated actions.
function OutletEditModal({
  outlet,
  outletTypes,
  onClose,
  onSaved,
}: {
  outlet:      MockOutlet;
  outletTypes: string[];
  onClose:     () => void;
  onSaved:     (msg: string) => void;
}) {
  const [outletType, setOutletType]           = useState(outlet.outletType);
  const [name, setName]                        = useState(outlet.outletName);
  const [programName, setProgramName]          = useState(outlet.programName);
  const [programCategory, setProgramCategory]  = useState(outlet.programCategory);
  const [city, setCity]                        = useState(outlet.city);
  const [state, setState]                      = useState(outlet.state);
  const [beat, setBeat]                        = useState(outlet.beat);
  const [zone, setZone]                        = useState(outlet.zone);
  const [distributorCode, setDistributorCode]  = useState(outlet.distributorId);
  const [distributorName, setDistributorName]  = useState(outlet.distributorName);
  const [metro, setMetro]                      = useState(outlet.metro);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the current type selectable even if it's not in the enabled-types list.
  const typeOptions = useMemo(
    () => (outletTypes.includes(outletType) ? outletTypes : [outletType, ...outletTypes].filter(Boolean)),
    [outletTypes, outletType],
  );

  const canSubmit = name.trim().length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    // Send ONLY changed fields (a PATCH; unsent fields are left untouched by the backend).
    const body: Record<string, string> = {};
    if (name.trim() !== outlet.outletName) body.name = name.trim();
    if (outletType !== outlet.outletType) body.outletTypeId = outletType;
    if (programName !== outlet.programName) body.programName = programName;
    if (programCategory !== outlet.programCategory) body.programCategory = programCategory;
    if (city !== outlet.city) body.city = city;
    if (state !== outlet.state) body.state = state;
    if (beat !== outlet.beat) body.beat = beat;
    if (zone !== outlet.zone) body.zone = zone;
    if (distributorCode !== outlet.distributorId) body.distributorCode = distributorCode;
    if (distributorName !== outlet.distributorName) body.distributorName = distributorName;
    if (metro !== outlet.metro) body.metro = metro ? 'Yes' : '';
    if (Object.keys(body).length === 0) { onClose(); return; }
    try {
      const res = await fetch(`/api/admin/outlets/${encodeURIComponent(outlet.outletId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({ success: false, error: 'Unexpected response' }));
      if (res.ok && j.success) {
        onSaved('Outlet updated.');
        onClose();
      } else {
        setError(j?.error ?? `Could not save changes (HTTP ${res.status})`);
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const field = (label: string, value: string, set: (v: string) => void) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[var(--brand-primary)]"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Edit Outlet</h2>
            <p className="text-xs font-mono text-gray-400">{outlet.outletId}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {field('Outlet name', name, setName)}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Outlet type</label>
            <select
              value={outletType}
              onChange={(e) => setOutletType(e.target.value)}
              aria-label="Outlet type"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-[var(--brand-primary)]"
            >
              {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field('Program name', programName, setProgramName)}
            {field('Program category', programCategory, setProgramCategory)}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field('City', city, setCity)}
            {field('State', state, setState)}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field('Beat', beat, setBeat)}
            {field('Zone', zone, setZone)}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field('Distributor code', distributorCode, setDistributorCode)}
            {field('Distributor name', distributorName, setDistributorName)}
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={metro} onChange={(e) => setMetro(e.target.checked)} className="rounded border-gray-300" />
            Metro outlet
          </label>

          <p className="text-[11px] text-gray-400">
            Owner name, phone, PAN, GST, bank and address are verified fields — change them via Re-KYC.
          </p>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit} className="px-4 py-2 text-sm font-semibold bg-[var(--brand-primary)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function OutletsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('master');

  // Per-tenant allowed Program Name / Program Category lists (owner-editable in Gifsy Settings).
  // Falls back to the module defaults until settings hydrate, and if a list is absent/empty.
  const settings = useGifsySettings();
  const validPrograms   = settings.outletPrograms?.length   ? settings.outletPrograms   : DEFAULT_PROGRAMS;
  const validCategories = settings.outletCategories?.length ? settings.outletCategories : DEFAULT_CATEGORIES;

  // ── Outlet list state ──
  // `outlets` = the CURRENT server page (drives the table). Server-paginated +
  // server-filtered (search + KYC status), so it is NOT the full tenant list.
  const [outlets, setOutlets]         = useState<MockOutlet[]>([]);
  const [editOutlet, setEditOutlet]   = useState<MockOutlet | null>(null);
  const [editToast, setEditToast]     = useState<string | null>(null);
  const [pagination, setPagination]   = useState<Pagination | null>(null);
  const [page,          setPage]      = useState(1);
  const [outletTypes, setOutletTypes] = useState<string[]>([]);
  const [employees, setEmployees]     = useState<HierarchyEmployee[]>([]);
  const [search,        setSearch]    = useState('');
  const [kycFilter,     setKycFilter] = useState<KYCStatusLocal | 'ALL'>('ALL');

  // `allOutlets` = the FULL tenant outlet list, fetched separately (all pages) and
  // used ONLY by the upload validators (create-vs-update-vs-reactivate detection,
  // Outlet-ID existence checks for Re-KYC / Deactivate, and the header stat counts).
  // It is refreshed on mount and after a successful upsert — never on search/paging.
  const [allOutlets, setAllOutlets]   = useState<MockOutlet[]>([]);

  // Outlet master (upsert) upload state
  const [outletValidation, setOutletValidation] = useState<OutletUploadValidationResult | null>(null);
  const [outletParsedRows, setOutletParsedRows] = useState<OutletUploadRow[]>([]);
  const [outletUploadState, setOutletUploadState] = useState<UploadState>('idle');

  // Re-KYC upload state
  const [rekycValidation, setRekycValidation] = useState<ReKYCFlagValidationResult | null>(null);
  const [rekycParsedRows, setRekycParsedRows] = useState<ReKYCFlagRow[]>([]);
  const [rekycUploadState, setRekycUploadState] = useState<UploadState>('idle');

  // Deactivate upload state
  const [deactivateValidation, setDeactivateValidation] = useState<OutletDeactivateValidationResult | null>(null);
  const [deactivateUploadState, setDeactivateUploadState] = useState<UploadState>('idle');

  // Park / Un-park upload state (Parked / Removed tab). Same single-column ('Outlet ID')
  // upload shape as deactivate; two independent sub-actions on one tab.
  const [parkValidation, setParkValidation] = useState<OutletParkValidationResult | null>(null);
  const [parkUploadState, setParkUploadState] = useState<UploadState>('idle');
  const [parkResult, setParkResult] = useState<ParkResult | null>(null);
  const [unparkValidation, setUnparkValidation] = useState<OutletUnparkValidationResult | null>(null);
  const [unparkUploadState, setUnparkUploadState] = useState<UploadState>('idle');
  const [unparkResult, setUnparkResult] = useState<ParkResult | null>(null);

  // "Download Outlet Master" (server export) state — surfaced so a failure is
  // visible instead of the button silently doing nothing.
  const [masterDownloadState, setMasterDownloadState] = useState<'idle' | 'loading' | 'error'>('idle');
  // "Download Parked Outlets" (Parked/Removed tab) state.
  const [parkedDownloadState, setParkedDownloadState] = useState<'idle' | 'loading' | 'error'>('idle');

  // The tenant's owner-group parent codes (partnerCode), for validating the Outlet Master
  // upload's Parent ID column upfront. `null` = not yet loaded (validation skips Parent ID and
  // lets the backend catch it); a Set (possibly empty) = loaded and enforced.
  const [parentCodes, setParentCodes] = useState<Set<string> | null>(null);

  // When the Outlet Master upload targets PARKED outlets, the admin can opt (explicitly, default
  // OFF) to un-park them as part of applying the upload — otherwise they stay hidden.
  const [unparkOnApply, setUnparkOnApply] = useState(false);

  // Batched-upload progress notes for the non-master uploads (null = idle). Shown on the confirm
  // button as "Uploading batch X of Y…" so a large multi-batch upload doesn't look frozen.
  const [rekycProgress,      setRekycProgress]      = useState<string | null>(null);
  const [deactivateProgress, setDeactivateProgress] = useState<string | null>(null);
  const [parkProgress,       setParkProgress]       = useState<string | null>(null);
  const [unparkProgress,     setUnparkProgress]     = useState<string | null>(null);

  // Tenant-config load status. The upload validators key on outletTypes (+ the
  // employee hierarchy); validating BEFORE these load — or when the config fetch
  // failed — produced false "no outlet types are enabled" rejections for every
  // row. Track the load so the upload can be gated until the config is ready.
  const [outletsLoadStatus, setOutletsLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [employeesLoaded,   setEmployeesLoaded]   = useState(false);

  // Confirm-submit errors (surfaced when the backend rejects the confirm POST,
  // e.g. an all-invalid 400 — previously swallowed by a `.catch(()=>{})`).
  const [outletSubmitError,     setOutletSubmitError]     = useState<string | null>(null);
  const [rekycSubmitError,      setRekycSubmitError]      = useState<string | null>(null);
  const [deactivateSubmitError, setDeactivateSubmitError] = useState<string | null>(null);
  const [parkSubmitError,       setParkSubmitError]       = useState<string | null>(null);
  const [unparkSubmitError,     setUnparkSubmitError]     = useState<string | null>(null);

  // Upload progress note (non-null while the master upsert is in flight). The backend
  // caps each request at 500 rows, so a large file is sent in sequential batches and
  // this note shows "Uploading batch X of Y…" (null = idle).
  const [outletUploadProgress,  setOutletUploadProgress]  = useState<string | null>(null);

  // ── Current-page loader (server-paginated + server-filtered) ──
  // Sends ?page&limit&search&kycStatus; the server filters + paginates so the table
  // shows only the matching page. Re-runs on page / search / kyc-filter change.
  const loadOutlets = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search.trim())        params.set('search', search.trim());
      if (kycFilter !== 'ALL')  params.set('kycStatus', kycFilter);
      const j = await fetch(`/api/admin/outlets?${params.toString()}`).then(r => r.json());
      if (j.success) {
        if (Array.isArray(j.data.outlets)) setOutlets(j.data.outlets);
        if (j.data.pagination) setPagination(j.data.pagination as Pagination);
        // Enabled outlet types come from the backend (tenant's OutletTypeClientConfig).
        if (Array.isArray(j.data.outletTypes)) setOutletTypes(j.data.outletTypes);
        setOutletsLoadStatus('ready');
      } else {
        // Keep a prior good load; otherwise surface the failure so the upload warns.
        setOutletsLoadStatus((s) => (s === 'ready' ? s : 'error'));
      }
    } catch {
      // Leave prior state on transient error, but mark error if we never loaded.
      setOutletsLoadStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, [page, search, kycFilter]);

  // ── Full-list loader (validation only) ──
  // The upload validators need the WHOLE tenant outlet list (not one page): the
  // Outlet-Master validator classifies each row create/update/reactivate from the
  // existing set, and Re-KYC / Deactivate check Outlet-ID existence; the header
  // stats also count by KYC status over ALL outlets. One lightweight call to
  // GET /api/admin/outlets/ids returns the whole tenant list projected to just the
  // 3 fields consumed here ({ outletId, isActive, kycStatus }) — replacing the old
  // ~23-request page-through of the paginated list endpoint. Called on mount + after upsert.
  const loadAllOutlets = useCallback(async () => {
    try {
      const j = await fetch('/api/admin/outlets/ids').then(r => r.json());
      if (j.success && Array.isArray(j.data.outlets)) {
        setAllOutlets(j.data.outlets as MockOutlet[]);
      }
      // On a non-success payload, leave the prior good validation list in place.
    } catch {
      /* leave prior good validation list on transient error */
    }
  }, []);

  // ── API fetch on mount ──
  useEffect(() => {
    void loadAllOutlets();
    fetch('/api/admin/hierarchy-config')
      .then(r => r.json())
      .then(j => { if (j.success && Array.isArray(j.data.employees)) setEmployees(j.data.employees); })
      .catch(() => {})
      .finally(() => setEmployeesLoaded(true));
    // Owner-group parent codes — used to validate the Outlet Master Parent ID column upfront.
    // On failure `parentCodes` stays null, so Parent ID validation is skipped (backend still checks)
    // rather than false-rejecting a legitimate code.
    fetch('/api/admin/parents')
      .then(r => r.json())
      .then(j => {
        if (j.success && Array.isArray(j.data?.parents)) {
          setParentCodes(new Set<string>(
            j.data.parents.map((p: { partnerCode?: string }) => (p.partnerCode ?? '').trim()).filter(Boolean),
          ));
        }
      })
      .catch(() => { /* leave null → skip Parent ID validation, backend still enforces */ });
  }, [loadAllOutlets]);

  // ── Debounced page load on search / filter / page change ──
  useEffect(() => {
    const t = setTimeout(() => { void loadOutlets(); }, 250);
    return () => clearTimeout(t);
  }, [loadOutlets]);

  // A new search or KYC filter resets to page 1 (the old page index is meaningless
  // for a different result set). loadOutlets then re-fires via its `page` dep.
  useEffect(() => {
    setPage(1);
  }, [search, kycFilter]);

  // Why the Outlet Master upload is blocked, if it is (null = ready). The validator
  // checks each row's Outlet Type against the tenant's enabled types and the XSR ID
  // against the employee hierarchy — so it must not run until BOTH have loaded. A
  // genuinely-empty type list (config loaded, zero types) gets the correct message,
  // not the old "ask Gifsy to enable" applied during a load race.
  const outletUploadDisabledReason: string | null =
    outletsLoadStatus === 'loading' ? 'Loading outlet configuration… please wait a moment.'
    : outletsLoadStatus === 'error' ? 'Could not load this tenant’s outlet configuration. Refresh the page and try again.'
    : !employeesLoaded ? 'Loading employee hierarchy… please wait a moment.'
    : outletTypes.length === 0 ? 'No outlet types are enabled for this tenant. Confirm you are in the correct tenant workspace, or ask Gifsy to enable outlet types before adding outlets.'
    : null;

  // Re-KYC / Deactivate validate Outlet IDs against the loaded outlet list, so they
  // only need the outlet fetch to have completed (no outlet-type/hierarchy check).
  const outletListDisabledReason: string | null =
    outletsLoadStatus === 'loading' ? 'Loading outlet list… please wait a moment.'
    : outletsLoadStatus === 'error' ? 'Could not load the outlet list. Refresh the page and try again.'
    : null;

  // ── Derived stats (over the FULL tenant list, not the current page) ──
  const stats = useMemo(() => ({
    total:       allOutlets.length,
    notStarted:  allOutlets.filter(o => o.kycStatus === 'NOT_STARTED').length,
    inProgress:  allOutlets.filter(o => o.kycStatus === 'IN_PROGRESS' || o.kycStatus === 'SUBMITTED').length,
    approved:    allOutlets.filter(o => o.kycStatus === 'APPROVED').length,
    rejected:    allOutlets.filter(o => o.kycStatus === 'REJECTED').length,
    rekyc:       allOutlets.filter(o => o.kycStatus === 'RE_KYC_REQUIRED').length,
  }), [allOutlets]);

  // Count of OK rows in the master upload that target a PARKED outlet — drives the parked
  // warning banner + the explicit "un-park these & apply" toggle.
  const parkedOkCount = useMemo(
    () => outletValidation?.rows.filter(r => r.status === 'OK' && r.parked).length ?? 0,
    [outletValidation],
  );

  // ── Tab switch — resets upload state to prevent stale panels ──
  const handleTabSwitch = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
    setOutletValidation(null);    setOutletParsedRows([]); setOutletUploadState('idle');     setOutletSubmitError(null); setOutletUploadProgress(null); setUnparkOnApply(false);
    setRekycValidation(null);     setRekycParsedRows([]); setRekycUploadState('idle');         setRekycSubmitError(null); setRekycProgress(null);
    setDeactivateValidation(null); setDeactivateUploadState('idle');                          setDeactivateSubmitError(null); setDeactivateProgress(null);
    setParkValidation(null);   setParkUploadState('idle');   setParkSubmitError(null);   setParkResult(null);   setParkProgress(null);
    setUnparkValidation(null); setUnparkUploadState('idle'); setUnparkSubmitError(null); setUnparkResult(null); setUnparkProgress(null);
  }, []);

  // The server now applies search + KYC filter + pagination, so the table renders
  // the current page (`outlets`) directly — no client-side filtering.

  // ── File parsers ──
  const parseXlsx = useCallback((file: File): Promise<Record<string, string>[]> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data     = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          // Find the data sheet (skip Dos & Don'ts) — H1 fix
          const DATA_SHEET_EXCLUDES = new Set(["Dos & Don'ts"]);
          const sheetName = workbook.SheetNames.find(n => !DATA_SHEET_EXCLUDES.has(n));
          if (!sheetName) {
            reject(new Error('No data sheet found. Please use the provided template.'));
            return;
          }
          const sheet = workbook.Sheets[sheetName];
          // raw:false → SheetJS returns FORMATTED STRINGS for every cell. Without it,
          // a numeric cell (e.g. a Distributor ID typed as 304077) comes back as a
          // NUMBER, and the row parsers' `.trim()` throws — surfacing as the misleading
          // "Failed to read file" header error. This makes the Record<string,string>
          // type honest for all three uploads (outlet / re-KYC / deactivate).
          const rows      = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '', raw: false });
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }, []);

  // ── Handle outlet master upload (CREATE / UPDATE / REACTIVATE upsert) ──
  const handleOutletFile = useCallback(async (file: File) => {
    // Backstop the dropzone guard: never validate Outlet Types against an unloaded
    // or empty list (it falsely rejects every row). Surface the real reason instead.
    if (outletUploadDisabledReason) {
      setOutletValidation({ headerError: outletUploadDisabledReason, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, creates: 0, updates: 0, reactivates: 0, errors: 0 } });
      setOutletUploadState('parsed');
      return;
    }
    try {
      const rows     = await parseXlsx(file);
      const headers  = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateOutletUploadHeaders(headers);
      if (headerErr) {
        setOutletValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, creates: 0, updates: 0, reactivates: 0, errors: 0 } });
        setOutletUploadState('parsed');
        return;
      }
      const parsed   = parseOutletUploadRows(rows as Record<string, string>[]);
      // Validate against the FULL tenant list (not the current page).
      const existing = allOutlets.map(o => ({ outletId: o.outletId, isActive: o.isActive }));
      // PARKED outlet IDs (from the full tenant list) — a row targeting one is flagged so the
      // upload never silently "succeeds" on a hidden outlet. Parent codes validate the Parent ID.
      const parkedIds = new Set(allOutlets.filter(o => o.kycStatus === 'PARKED').map(o => o.outletId));
      const result   = validateOutletUpload(parsed, existing, validPrograms, validCategories, outletTypes, employees, LEAF_ROLE_CODE, parentCodes ?? undefined, parkedIds);
      setOutletParsedRows(parsed);
      setOutletValidation(result);
      setOutletUploadState('parsed');
    } catch {
      setOutletValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, creates: 0, updates: 0, reactivates: 0, errors: 0 } });
      setOutletUploadState('parsed');
    }
  }, [allOutlets, outletTypes, employees, parseXlsx, validPrograms, validCategories, outletUploadDisabledReason, parentCodes]);

  // ── Handle re-KYC upload ──
  const handleReKYCFile = useCallback(async (file: File) => {
    try {
      const rows    = await parseXlsx(file);
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateReKYCFlagHeaders(headers);
      if (headerErr) {
        setRekycValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, flagged: 0, errors: 0 } });
        setRekycUploadState('parsed');
        return;
      }
      const parsed          = parseReKYCFlagRows(rows as Record<string, string>[]);
      const existingOutlets = allOutlets.map(o => ({ outletId: o.outletId, kycStatus: o.kycStatus as unknown as KYCStatus }));
      const result          = validateReKYCFlagUpload(parsed, existingOutlets);
      setRekycParsedRows(parsed);
      setRekycValidation(result);
      setRekycUploadState('parsed');
    } catch {
      setRekycValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, flagged: 0, errors: 0 } });
      setRekycUploadState('parsed');
    }
  }, [allOutlets, parseXlsx]);

  // ── Handle deactivate upload ──
  const handleDeactivateFile = useCallback(async (file: File) => {
    try {
      const rows    = await parseXlsx(file);
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateDeactivateHeaders(headers);
      if (headerErr) {
        setDeactivateValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, deactivates: 0, errors: 0 } });
        setDeactivateUploadState('parsed');
        return;
      }
      const parsed   = parseDeactivateRows(rows as Record<string, string>[]);
      const existing = allOutlets.map(o => ({ outletId: o.outletId, isActive: o.isActive }));
      const result   = validateDeactivateUpload(parsed, existing);
      setDeactivateValidation(result);
      setDeactivateUploadState('parsed');
    } catch {
      setDeactivateValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, deactivates: 0, errors: 0 } });
      setDeactivateUploadState('parsed');
    }
  }, [allOutlets, parseXlsx]);

  // ── Handle park upload ──
  const handleParkFile = useCallback(async (file: File) => {
    try {
      const rows    = await parseXlsx(file);
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateDeactivateHeaders(headers);
      if (headerErr) {
        setParkValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, parked: 0, errors: 0 } });
        setParkUploadState('parsed');
        return;
      }
      const parsed   = parseDeactivateRows(rows as Record<string, string>[]);
      const existing = allOutlets.map(o => ({ outletId: o.outletId, kycStatus: o.kycStatus as unknown as string }));
      const result   = validateParkUpload(parsed, existing);
      setParkValidation(result);
      setParkUploadState('parsed');
    } catch {
      setParkValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, parked: 0, errors: 0 } });
      setParkUploadState('parsed');
    }
  }, [allOutlets, parseXlsx]);

  // ── Handle un-park upload ──
  const handleUnparkFile = useCallback(async (file: File) => {
    try {
      const rows    = await parseXlsx(file);
      const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
      const headerErr = validateDeactivateHeaders(headers);
      if (headerErr) {
        setUnparkValidation({ headerError: headerErr, rows: [], hasErrors: true, canProceed: false, summary: { total: 0, unparked: 0, errors: 0 } });
        setUnparkUploadState('parsed');
        return;
      }
      const parsed   = parseDeactivateRows(rows as Record<string, string>[]);
      const existing = allOutlets.map(o => ({ outletId: o.outletId, kycStatus: o.kycStatus as unknown as string }));
      const result   = validateUnparkUpload(parsed, existing);
      setUnparkValidation(result);
      setUnparkUploadState('parsed');
    } catch {
      setUnparkValidation({ headerError: 'Failed to read file — please ensure it is a valid XLSX file', rows: [], hasErrors: true, canProceed: false, summary: { total: 0, unparked: 0, errors: 0 } });
      setUnparkUploadState('parsed');
    }
  }, [allOutlets, parseXlsx]);

  // ── Download helpers ──
  function downloadXlsx(wb: XLSX.WorkBook, filename: string) {
    const buf   = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob  = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    downloadBlob(blob, filename);
  }

  function downloadOutletTemplate() {
    const { headers, exampleRows, dosAndDonts } = getOutletAdditionTemplateData(validPrograms, validCategories, outletTypes, LEAF_ROLE_CODE);
    const wb = XLSX.utils.book_new();
    // Sheet 1: Dos & Don'ts (opens first)
    const ddSheet = aoaToSheetSafe(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    // Sheet 2: Data
    const dataSheet = aoaToSheetSafe([headers, ...exampleRows]);
    dataSheet['!cols'] = headers.map(h => ({ wch: h.includes('Name') ? 28 : h.includes('Manager') ? 34 : 20 }));
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Outlet Upload');
    downloadXlsx(wb, 'outlet-master-template.xlsx');
  }

  function downloadReKYCTemplate() {
    const { headers, exampleRows, dosAndDonts } = getReKYCFlagTemplateData();
    const wb = XLSX.utils.book_new();
    const ddSheet = aoaToSheetSafe(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    const dataSheet = aoaToSheetSafe([headers, ...exampleRows]);
    dataSheet['!cols'] = headers.map(h => ({ wch: h.includes('Document') ? 30 : h === 'Outlet ID' ? 18 : 22 }));
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Re-KYC Flags');
    downloadXlsx(wb, 'outlet-rekyc-flags-template.xlsx');
  }

  function downloadDeactivateTemplate() {
    const { headers, exampleRows, dosAndDonts } = getDeactivateTemplateData();
    const wb = XLSX.utils.book_new();
    const ddSheet = aoaToSheetSafe(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    const dataSheet = aoaToSheetSafe([headers, ...exampleRows]);
    dataSheet['!cols'] = [{ wch: 22 }];
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Deactivate Upload');
    downloadXlsx(wb, 'outlet-deactivation-template.xlsx');
  }

  function downloadParkTemplate() {
    const { headers, exampleRows, dosAndDonts } = getParkTemplateData();
    const wb = XLSX.utils.book_new();
    const ddSheet = aoaToSheetSafe(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    const dataSheet = aoaToSheetSafe([headers, ...exampleRows]);
    dataSheet['!cols'] = [{ wch: 22 }];
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Park Upload');
    downloadXlsx(wb, 'outlet-park-template.xlsx');
  }

  function downloadUnparkTemplate() {
    const { headers, exampleRows, dosAndDonts } = getUnparkTemplateData();
    const wb = XLSX.utils.book_new();
    const ddSheet = aoaToSheetSafe(dosAndDonts);
    ddSheet['!cols'] = [{ wch: 28 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ddSheet, "Dos & Don'ts");
    const dataSheet = aoaToSheetSafe([headers, ...exampleRows]);
    dataSheet['!cols'] = [{ wch: 22 }];
    XLSX.utils.book_append_sheet(wb, dataSheet, 'Un-park Upload');
    downloadXlsx(wb, 'outlet-unpark-template.xlsx');
  }

  // Export the tenant's currently-parked outlets. The data sheet leads with an "Outlet ID"
  // column so the file re-uploads STRAIGHT into Un-park (that parser reads Outlet ID and
  // ignores the extra Name/City columns) — download → trim → un-park in one loop.
  async function downloadParkedOutlets() {
    setParkedDownloadState('loading');
    try {
      const res = await fetch('/api/admin/outlets/parked');
      if (!res.ok) { setParkedDownloadState('error'); return; }  // don't download an empty file on an API error
      const j = await res.json().catch(() => null);
      const list: { outletId?: string; name?: string; city?: string }[] =
        j?.success && Array.isArray(j.data?.outlets) ? j.data.outlets : [];
      const headers = ['Outlet ID', 'Outlet Name', 'City'];
      const body = list.map(o => [o.outletId ?? '', o.name ?? '', o.city ?? '']);
      const wb = XLSX.utils.book_new();
      const ws = aoaToSheetSafe([headers, ...body]);
      ws['!cols'] = [{ wch: 22 }, { wch: 28 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Parked Outlets');
      downloadXlsx(wb, 'parked-outlets.xlsx');
      setParkedDownloadState('idle');
    } catch {
      setParkedDownloadState('error');
    }
  }

  function downloadGuide() {
    const html = generateOutletGuideHtml(outletTypes);
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'outlet-management-guide.html';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Tab config ──
  const tabs: { id: TabId; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'master',     label: 'Outlet Master',      icon: <Store className="w-4 h-4" />,    count: stats.total },
    { id: 'rekyc',      label: 'Re-KYC Flagging',    icon: <RefreshCw className="w-4 h-4" /> },
    { id: 'deactivate', label: 'Deactivate Outlets', icon: <XCircle className="w-4 h-4" />   },
    { id: 'parked',     label: 'Parked / Removed',   icon: <Archive className="w-4 h-4" />   },
  ];

  const inputCls  = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]';

  return (
    <div className="space-y-5 fade-in">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 role="heading" className="text-xl font-bold text-gray-900">Outlet Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Add or update outlets, flag for re-KYC, and manage activations
          </p>
        </div>
        <button
          data-testid="download-outlet-guide"
          onClick={downloadGuide}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors shrink-0"
        >
          <FileText className="w-4 h-4" />
          Operations Guide
        </button>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1 w-fit">
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => handleTabSwitch(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === t.id ? 'bg-[var(--brand-primary)] text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === t.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
              }`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ═══════════════ OUTLET MASTER TAB ═══════════════ */}
      {activeTab === 'master' && (
        <div className="space-y-5">

          {/* Download Outlet Master */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Outlet Master</h2>
              <p className="text-xs text-gray-400 mt-0.5">Complete outlet dump with KYC, banking, hierarchy, and lifecycle data</p>
              {masterDownloadState === 'error' && (
                <p data-testid="download-outlet-master-error" className="text-xs text-red-600 mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> Could not download the outlet master. Please try again.
                </p>
              )}
            </div>
            <button
              data-testid="download-outlet-master"
              disabled={masterDownloadState === 'loading'}
              onClick={async () => {
                setMasterDownloadState('loading');
                try {
                  const res = await fetch('/api/admin/reports/outlet-master');
                  if (!res.ok) { setMasterDownloadState('error'); return; }
                  const blob = await res.blob();
                  downloadBlob(blob, `outlet-master-${new Date().toISOString().split('T')[0]}.xlsx`);
                  setMasterDownloadState('idle');
                } catch { setMasterDownloadState('error'); }
              }}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-60 transition-colors shrink-0"
            >
              <Download className="w-4 h-4" /> {masterDownloadState === 'loading' ? 'Preparing…' : 'Download Outlet Master'}
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            {[
              { testId: 'stat-total-outlets', label: 'Total',       value: stats.total,      cls: 'text-gray-600 bg-gray-100',    filter: 'ALL'             },
              { testId: 'stat-pending-kyc',   label: 'KYC Pending', value: stats.notStarted, cls: 'text-gray-600 bg-gray-100',    filter: 'NOT_STARTED'     },
              { testId: 'stat-in-progress',   label: 'In Progress', value: stats.inProgress, cls: 'text-blue-600 bg-blue-100',    filter: 'IN_PROGRESS'     },
              { testId: 'stat-approved',      label: 'Approved',    value: stats.approved,   cls: 'text-green-600 bg-green-100',  filter: 'APPROVED'        },
              { testId: 'stat-rejected',      label: 'Rejected',    value: stats.rejected,   cls: 'text-red-600 bg-red-100',      filter: 'REJECTED'        },
              { testId: 'stat-rekyc',         label: 'Re-KYC',      value: stats.rekyc,      cls: 'text-amber-600 bg-amber-100',  filter: 'RE_KYC_REQUIRED' },
            ].map(s => (
              <button
                key={s.testId}
                data-testid={s.testId}
                onClick={() => setKycFilter(s.filter as KYCStatusLocal | 'ALL')}
                className={`bg-white border border-gray-200 rounded-xl p-3 flex items-center gap-2 hover:shadow-md transition-all text-left ${
                  kycFilter === s.filter ? 'border-[var(--brand-primary)] ring-1 ring-[var(--brand-primary)]/20' : ''
                }`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.cls} shrink-0`}>
                  <Store className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-lg font-bold text-gray-900">{s.value}</p>
                  <p className="text-xs text-gray-500">{s.label}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Upload + search bar */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <Upload className="w-4 h-4 text-[var(--brand-primary)]" />
                  Outlet Master Upload
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  New Outlet ID → create · Existing + active → update fields · Existing + inactive → reactivate
                </p>
              </div>
              <button
                data-testid="download-outlet-template"
                onClick={downloadOutletTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Download Template
              </button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700 space-y-1">
              <p className="font-semibold">How upsert works</p>
              <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                <li><strong>New Outlet ID</strong> → outlet is created (all required fields must be filled)</li>
                <li><strong>Existing active Outlet ID</strong> → only the fields you fill are updated; blank = keep existing</li>
                <li><strong>Existing inactive Outlet ID</strong> → outlet is reactivated; any filled fields are also updated</li>
                <li><strong>Outlet Name cannot be changed here</strong> — use Re-KYC Flagging to request a name correction</li>
                <li><strong>XSR ID</strong> must be an ISR-level employee if provided</li>
                <li><strong>Parent ID</strong> links an outlet to an owner group — blank = standalone; a parent code (e.g. CPP01) = link to that group</li>
              </ul>
            </div>

            {/* Parked-target warning + explicit un-park opt-in (default OFF, so a routine
                re-upload never un-parks by accident). Only shown once a file is validated. */}
            {outletUploadState === 'parsed' && parkedOkCount > 0 && (
              <div data-testid="parked-warning" className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
                <Archive className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-amber-800">
                    {parkedOkCount} of these outlet{parkedOkCount > 1 ? 's are' : ' is'} currently parked (hidden from the sales team).
                  </p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    Your changes will be saved, but {parkedOkCount > 1 ? 'they' : 'it'} will stay hidden from reps unless un-parked.
                  </p>
                  <label className="flex items-center gap-2 mt-2 text-sm text-amber-800 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="unpark-on-apply"
                      checked={unparkOnApply}
                      onChange={e => setUnparkOnApply(e.target.checked)}
                      className="rounded border-amber-300 text-amber-600 focus:ring-amber-400"
                    />
                    Un-park {parkedOkCount > 1 ? 'these outlets' : 'this outlet'} and apply changes
                  </label>
                </div>
              </div>
            )}

            <UploadSection
              testIdInput="outlet-upload-input"
              testIdPanel="outlet-validation-panel"
              errorReportFilename="outlet-upload-errors.xlsx"
              parentIdByRow={Object.fromEntries(outletParsedRows.map(r => [r.rowNum, r.parentId]))}
              uploadDisabledReason={outletUploadDisabledReason}
              errorReport={outletValidation ? buildOutletUploadErrorReport(outletValidation, outletParsedRows) : undefined}
              onFileChange={handleOutletFile}
              validationResult={outletValidation}
              uploadState={outletUploadState}
              onConfirm={async () => {
                setOutletSubmitError(null);
                // Send the full parsed rows (the field data) for the OK rows, not the
                // gutted validation results — the route needs name/type/xsr/etc to persist.
                const okIds = new Set((outletValidation?.rows ?? []).filter(r => r.status === 'OK').map(r => r.outletId));
                const rows = outletParsedRows.filter(r => okIds.has(r.outletId));

                // The backend caps each /upsert request at 500 rows, so split a large
                // upload into sequential batches and aggregate the result. One file in,
                // one combined summary out — no manual file-splitting.
                const CHUNK = 500;
                const batches = chunkArray(rows, CHUNK);

                let created = 0, updated = 0, reactivated = 0;
                const rowErrs: Array<{ rowNum?: number; outletId?: string; errors?: string[] }> = [];
                setOutletUploadProgress(batches.length > 1 ? `Uploading batch 1 of ${batches.length}…` : 'Saving…');
                try {
                  for (let b = 0; b < batches.length; b++) {
                    if (batches.length > 1) setOutletUploadProgress(`Uploading batch ${b + 1} of ${batches.length}…`);
                    const res = await fetch('/api/admin/outlets/upsert', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ rows: batches[b] }),
                    });
                    const j = await res.json().catch(() => null);
                    if (!res.ok) {
                      const saved = created + updated + reactivated;
                      setOutletSubmitError(
                        `${batches.length > 1 ? `Batch ${b + 1} of ${batches.length} failed` : 'Upload failed'} (${res.status}): ${j?.error ?? j?.message ?? 'please try again'}.` +
                        (saved ? ` ${saved} outlet(s) were already saved — re-upload the remaining rows.` : ''),
                      );
                      setOutletUploadProgress(null);
                      return;
                    }
                    // A 200 does NOT mean rows were written — the backend validates each row
                    // and returns created/updated/reactivated counts + a per-row errors[].
                    const d = j?.data ?? j ?? {};
                    created     += Number(d.created ?? 0);
                    updated     += Number(d.updated ?? 0);
                    reactivated += Number(d.reactivated ?? 0);
                    if (Array.isArray(d.errors)) rowErrs.push(...d.errors);
                  }
                  setOutletUploadProgress(null);
                  // Treat zero writes across ALL batches as a failure and surface the reason.
                  if (created + updated + reactivated === 0) {
                    const detail = rowErrs.length
                      ? rowErrs.slice(0, 6).map(e => `Row ${e.rowNum} (${e.outletId}): ${(e.errors ?? []).join('; ')}`).join('  |  ')
                      : 'The server accepted the request but saved no outlets.';
                    setOutletSubmitError(`No outlets were saved. ${detail}`);
                    return;
                  }

                  // Upsert wrote something. Only NOW (after the field update landed) do the explicit
                  // un-park, if the admin opted in — so a failed upsert can never expose an outlet
                  // (the visibility change happens strictly after a successful update). Default OFF.
                  if (unparkOnApply) {
                    const parkedCodes = (outletValidation?.rows ?? [])
                      .filter(r => r.status === 'OK' && r.parked)
                      .map(r => r.outletId);
                    if (parkedCodes.length) {
                      setOutletUploadProgress('Un-parking selected outlets…');
                      const unparkRes = await postInBatches('/api/admin/outlets/unpark', parkedCodes, (batch) => ({ outletCodes: batch }));
                      setOutletUploadProgress(null);
                      if (!unparkRes.ok) {
                        // Field changes DID save; only the un-park failed. Be honest + refresh, and
                        // don't discard the successful upsert by pretending nothing happened.
                        setOutletSubmitError(`Field changes were saved, but un-parking failed: ${unparkRes.message} Un-park them from the Parked / Removed tab.${batchRemainderNote(unparkRes.appliedBatches)}`);
                        void loadOutlets();
                        void loadAllOutlets();
                        return;
                      }
                    }
                  }

                  setOutletUploadState('confirmed');
                  // Reflect the new/updated rows: refresh the current page AND the
                  // full validation list (stats + create/update detection).
                  void loadOutlets();
                  void loadAllOutlets();
                } catch {
                  setOutletUploadProgress(null);
                  setOutletSubmitError('Network error — please try again');
                }
              }}
              onClear={() => { setOutletValidation(null); setOutletParsedRows([]); setOutletUploadState('idle'); setOutletSubmitError(null); setOutletUploadProgress(null); setUnparkOnApply(false); }}
              confirmLabel="Apply Changes"
              submitError={outletSubmitError}
              submitting={outletUploadProgress !== null}
              submitNote={outletUploadProgress}
            />
          </div>

          {/* Search + filter */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  data-testid="outlet-search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by ID, name, ISR, beat, city…"
                  className={`w-full pl-9 pr-3 py-2 ${inputCls}`}
                />
              </div>
              <select
                value={kycFilter}
                onChange={e => setKycFilter(e.target.value as KYCStatusLocal | 'ALL')}
                className={inputCls}
              >
                <option value="ALL">All KYC Statuses</option>
                <option value="NOT_STARTED">KYC Pending</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="SUBMITTED">Submitted</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="RE_KYC_REQUIRED">Re-KYC Required</option>
              </select>
            </div>
          </div>

          {/* Outlet table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Outlet</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Type</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Program</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Group</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Location</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Assigned ISR</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">KYC Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Added</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {outlets.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-16 text-center">
                        <Store className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                        <p className="text-sm text-gray-400">No outlets match your filters</p>
                      </td>
                    </tr>
                  ) : outlets.map(o => {
                    const sc = KYC_STATUS_CONFIG[o.kycStatus];
                    return (
                      <tr key={o.outletId} data-testid="outlet-row" className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 bg-gray-100 rounded-full flex items-center justify-center shrink-0">
                              <Building2 className="w-3.5 h-3.5 text-gray-500" />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-gray-900">{o.outletName}</p>
                              <p className="text-xs font-mono text-gray-400">{o.outletId}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TYPE_COLORS[o.outletType] ?? 'bg-gray-100 text-gray-600'}`}>
                            {o.outletType}
                          </span>
                          {o.metro && <span className="ml-1 text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-full">Metro</span>}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-xs font-medium text-gray-700">{o.programName}</p>
                          <p className="text-[11px] text-gray-400">{o.programCategory || '—'}</p>
                        </td>
                        <td className="px-4 py-3">
                          {o.parentCode
                            ? <span
                                title={o.parentBusinessName || undefined}
                                className="inline-block text-xs font-mono font-medium text-gray-700 bg-gray-100 px-2 py-0.5 rounded-full"
                              >
                                {o.parentCode}
                              </span>
                            : <span className="text-xs text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-start gap-1">
                            <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-xs font-medium text-gray-700">{o.beat}</p>
                              <p className="text-[11px] text-gray-400">{o.city}, {o.state}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Users className="w-3 h-3 text-[var(--brand-primary)] shrink-0" />
                            <div>
                              <p className="text-xs font-medium text-gray-800">{o.xsrName}</p>
                              <p className="text-[11px] font-mono text-gray-400">{o.xsrId}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span data-testid="kyc-status-badge" className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${sc.badgeCls}`}>
                            {sc.icon}
                            {sc.label}
                          </span>
                          {o.isActive && (
                            <p className="text-[10px] text-green-600 mt-0.5 flex items-center gap-1">
                              <Eye className="w-2.5 h-2.5" /> Active
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">{o.addedDate}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => setEditOutlet(o)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-[var(--brand-primary)] border border-gray-200 hover:border-[var(--brand-primary)] rounded-lg px-2.5 py-1.5 transition-colors"
                            aria-label={`Edit ${o.outletName}`}
                          >
                            <SquarePen className="w-3.5 h-3.5" />
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs text-gray-500">
                {pagination
                  ? <>Showing {outlets.length} of {pagination.total} matching · Page{' '}
                      <strong className="text-gray-700">{pagination.page}</strong> of{' '}
                      <strong className="text-gray-700">{Math.max(1, pagination.pages)}</strong></>
                  : <>Showing {outlets.length} outlets</>}
                {' · '}{stats.approved} active · {stats.notStarted} awaiting KYC · {stats.rekyc} re-KYC pending
              </p>
              {pagination && pagination.pages > 1 && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    data-testid="outlets-prev-page"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={pagination.page <= 1}
                    className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    data-testid="outlets-next-page"
                    onClick={() => setPage(p => p + 1)}
                    disabled={pagination.page >= pagination.pages}
                    className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ RE-KYC TAB ═══════════════ */}
      {activeTab === 'rekyc' && (
        <div data-testid="rekyc-upload-section" className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-[var(--brand-primary)]" />
                  Flag Outlets for Re-KYC
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Mark which KYC fields need to be re-captured for specific outlets. The sales team will see a Re-KYC Required badge and must re-fill only the flagged fields. Outlet stays active throughout. Use this flow to request an Outlet Name correction.
                </p>
              </div>
              <button
                data-testid="download-rekyc-template"
                onClick={downloadReKYCTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Template
              </button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700 space-y-1">
              <p className="font-semibold">How this works</p>
              <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                <li>Enter <strong>Yes</strong> in any column whose data needs to be re-captured</li>
                <li>At least one field must be marked Yes per row</li>
                <li>Add a Remarks note so the sales team understands why re-KYC is needed</li>
                <li><strong>Outlet Name</strong> — mark Yes here to request a name correction; it goes through the KYC approval chain</li>
                <li>Document fields (Owner Photo, Address Proof, etc.) must be re-uploaded via the KYC form — not via Excel</li>
              </ul>
            </div>

            <UploadSection
              testIdInput="rekyc-upload-input"
              testIdPanel="rekyc-validation-panel"
              errorReportFilename="outlet-rekyc-errors.xlsx"
              uploadDisabledReason={outletListDisabledReason}
              errorReport={rekycValidation ? buildReKYCErrorReport(rekycValidation, rekycParsedRows) : undefined}
              onFileChange={handleReKYCFile}
              validationResult={rekycValidation}
              uploadState={rekycUploadState}
              onConfirm={async () => {
                setRekycSubmitError(null);
                // Post the full parsed ReKYCFlagRow[] (raw per-field "Yes"/blank cells),
                // not the gutted validation results — the route maps each row to the
                // persisted ReKYCFlags JSON. Filter to the rows validation marked OK.
                const okOutletIds = new Set(
                  (rekycValidation?.rows ?? []).filter(r => r.status === 'OK').map(r => r.outletId),
                );
                const rows = rekycParsedRows.filter(r => okOutletIds.has(r.outletId));
                setRekycProgress('Saving…');
                const result = await postInBatches('/api/admin/outlets/rekyc-flag', rows, (batch) => ({ rows: batch }),
                  (done, total) => { if (total > 1) setRekycProgress(`Uploading batch ${done + 1} of ${total}…`); });
                setRekycProgress(null);
                if (!result.ok) {
                  setRekycSubmitError(`Re-KYC flagging failed: ${result.message}${batchRemainderNote(result.appliedBatches)}`);
                  return;
                }
                setRekycUploadState('confirmed');
              }}
              onClear={() => { setRekycValidation(null); setRekycUploadState('idle'); setRekycSubmitError(null); setRekycProgress(null); }}
              confirmLabel="Flag for Re-KYC"
              submitError={rekycSubmitError}
              submitting={rekycProgress !== null}
              submitNote={rekycProgress}
            />
          </div>

          {/* Outlets currently flagged for re-KYC (full tenant list) */}
          {allOutlets.some(o => o.kycStatus === 'RE_KYC_REQUIRED') && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-amber-50">
                <p className="text-xs font-semibold text-amber-700 flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5" />
                  Currently flagged for re-KYC ({allOutlets.filter(o => o.kycStatus === 'RE_KYC_REQUIRED').length})
                </p>
              </div>
              <div className="divide-y divide-gray-50">
                {allOutlets.filter(o => o.kycStatus === 'RE_KYC_REQUIRED').map(o => (
                  <div key={o.outletId} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 bg-amber-100 rounded-full flex items-center justify-center shrink-0">
                        <Building2 className="w-3.5 h-3.5 text-amber-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{o.outletName}</p>
                        <p className="text-xs text-gray-400 font-mono">{o.outletId} · {o.xsrName}</p>
                      </div>
                    </div>
                    <span className="text-xs text-amber-700 bg-amber-100 px-2 py-1 rounded-full font-medium flex items-center gap-1 shrink-0">
                      <RefreshCw className="w-3 h-3" /> Re-KYC Required
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ DEACTIVATE TAB ═══════════════ */}
      {activeTab === 'deactivate' && (
        <div data-testid="deactivate-upload-section" className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-red-500" />
                  Deactivate Outlets
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Upload a list of Outlet IDs to mark them inactive. Inactive outlets are removed from the sales team's KYC queue and excluded from target calculations. Only currently-active outlets can be deactivated. To reactivate, upload the outlet via Outlet Master.
                </p>
              </div>
              <button
                data-testid="download-deactivate-template"
                onClick={downloadDeactivateTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Template
              </button>
            </div>

            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 space-y-1">
              <p className="font-semibold">⚠ Important — this action cannot be undone via upload</p>
              <ul className="list-disc list-inside space-y-0.5 text-red-600">
                <li>Only Outlet IDs that exist in the system are accepted</li>
                <li>Outlets already inactive will be rejected — do not include them</li>
                <li>Coordinate with the field team before deactivating — the assigned ISR loses access immediately</li>
                <li>Open KYC submissions for deactivated outlets must be handled manually</li>
              </ul>
            </div>

            <UploadSection
              testIdInput="deactivate-upload-input"
              testIdPanel="deactivate-validation-panel"
              errorReportFilename="outlet-deactivate-errors.xlsx"
              uploadDisabledReason={outletListDisabledReason}
              errorReport={deactivateValidation ? buildDeactivateErrorReport(deactivateValidation) : undefined}
              onFileChange={handleDeactivateFile}
              validationResult={deactivateValidation}
              uploadState={deactivateUploadState}
              onConfirm={async () => {
                setDeactivateSubmitError(null);
                const codes = deactivateValidation?.rows.filter(r => r.status === 'OK').map(r => r.outletId) ?? [];
                setDeactivateProgress('Saving…');
                const result = await postInBatches('/api/admin/outlets/deactivate', codes, (batch) => ({ outletCodes: batch }),
                  (done, total) => { if (total > 1) setDeactivateProgress(`Uploading batch ${done + 1} of ${total}…`); });
                setDeactivateProgress(null);
                if (!result.ok) {
                  setDeactivateSubmitError(`Deactivation failed: ${result.message}${batchRemainderNote(result.appliedBatches)}`);
                  return;
                }
                setDeactivateUploadState('confirmed');
              }}
              onClear={() => { setDeactivateValidation(null); setDeactivateUploadState('idle'); setDeactivateSubmitError(null); setDeactivateProgress(null); }}
              confirmLabel="Deactivate Outlets"
              submitError={deactivateSubmitError}
              submitting={deactivateProgress !== null}
              submitNote={deactivateProgress}
            />
          </div>

          {/* Currently active outlets quick reference */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-600 flex items-center gap-2">
                <Eye className="w-3.5 h-3.5" />
                Active outlets ({allOutlets.filter(o => o.isActive).length}) — these can be deactivated
              </p>
            </div>
            <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
              {allOutlets.filter(o => o.isActive).map(o => (
                <div key={o.outletId} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 bg-green-100 rounded-full flex items-center justify-center shrink-0">
                      <Building2 className="w-3.5 h-3.5 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{o.outletName}</p>
                      <p className="text-xs text-gray-400 font-mono">{o.outletId} · {o.city}</p>
                    </div>
                  </div>
                  <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded-full font-medium flex items-center gap-1 shrink-0">
                    <Eye className="w-3 h-3" /> Active
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ PARKED / REMOVED TAB ═══════════════ */}
      {activeTab === 'parked' && (
        <div data-testid="parked-upload-section" className="space-y-5">

          {/* Explainer + parked-outlets export */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <Archive className="w-4 h-4 text-slate-500" />
                  Parked / Removed Outlets
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Parked outlets are fully removed from the sales team&apos;s KYC queue and hidden from reps. Use this to bulk-remove KYC-pending outlets you&apos;re not pursuing. Un-park to return them to the queue.
                </p>
              </div>
              <button
                data-testid="download-parked-outlets"
                onClick={downloadParkedOutlets}
                disabled={parkedDownloadState === 'loading'}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-60 transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> {parkedDownloadState === 'loading' ? 'Preparing…' : 'Download Parked Outlets'}
              </button>
            </div>
            {parkedDownloadState === 'error' && (
              <p data-testid="download-parked-error" className="text-xs text-red-600 mt-2 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> Could not download the parked outlets. Please try again.
              </p>
            )}
          </div>

          {/* Park block */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <Archive className="w-4 h-4 text-slate-500" />
                  Park Outlets
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  Upload a list of Outlet IDs to park them — they are removed from the sales team&apos;s KYC queue. Only KYC-pending outlets are parked; any code that is already parked or no longer KYC-pending is reported back.
                </p>
              </div>
              <button
                data-testid="download-park-template"
                onClick={downloadParkTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Template
              </button>
            </div>

            <UploadSection
              testIdInput="park-upload-input"
              testIdPanel="park-validation-panel"
              errorReportFilename="outlet-park-errors.xlsx"
              uploadDisabledReason={outletListDisabledReason}
              errorReport={parkValidation ? buildDeactivateErrorReport(parkValidation) : undefined}
              onFileChange={handleParkFile}
              validationResult={parkValidation}
              uploadState={parkUploadState}
              successMessage={parkResult ? `${parkResult.count} outlet(s) parked` : undefined}
              successDetail={parkResult ? (
                parkResult.notFound.length > 0
                  ? <span data-testid="park-notfound">{parkResult.notFound.length} code(s) were not parked (not found or no longer KYC-pending): {parkResult.notFound.join(', ')}</span>
                  : <span>All uploaded outlets were parked and removed from the sales queue.</span>
              ) : undefined}
              onConfirm={async () => {
                setParkSubmitError(null);
                const codes = parkValidation?.rows.filter(r => r.status === 'OK').map(r => r.outletId) ?? [];
                setParkProgress('Saving…');
                const result = await postInBatches('/api/admin/outlets/park', codes, (batch) => ({ outletCodes: batch }),
                  (done, total) => { if (total > 1) setParkProgress(`Uploading batch ${done + 1} of ${total}…`); });
                setParkProgress(null);
                if (!result.ok) {
                  setParkSubmitError(`Parking failed: ${result.message}${batchRemainderNote(result.appliedBatches)}`);
                  return;
                }
                // Aggregate the per-batch { parked, notFound } into one result for the success panel.
                const parked = result.data.reduce((s, d) => s + Number(d.parked ?? 0), 0);
                const notFound = result.data.flatMap(d => Array.isArray(d.notFound) ? (d.notFound as string[]) : []);
                setParkResult({ count: parked, notFound });
                setParkUploadState('confirmed');
                // Refresh so the parked reference list + stats reflect the change.
                void loadOutlets();
                void loadAllOutlets();
              }}
              onClear={() => { setParkValidation(null); setParkUploadState('idle'); setParkSubmitError(null); setParkResult(null); setParkProgress(null); }}
              confirmLabel="Park Outlets"
              submitError={parkSubmitError}
              submitting={parkProgress !== null}
              submitNote={parkProgress}
            />
          </div>

          {/* Un-park block */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-slate-500" />
                  Un-park Outlets
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  Upload a list of Outlet IDs to return them to the sales team&apos;s KYC queue. Only currently-parked outlets can be un-parked.
                </p>
              </div>
              <button
                data-testid="download-unpark-template"
                onClick={downloadUnparkTemplate}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors shrink-0"
              >
                <Download className="w-4 h-4" /> Template
              </button>
            </div>

            <UploadSection
              testIdInput="unpark-upload-input"
              testIdPanel="unpark-validation-panel"
              errorReportFilename="outlet-unpark-errors.xlsx"
              uploadDisabledReason={outletListDisabledReason}
              errorReport={unparkValidation ? buildDeactivateErrorReport(unparkValidation) : undefined}
              onFileChange={handleUnparkFile}
              validationResult={unparkValidation}
              uploadState={unparkUploadState}
              successMessage={unparkResult ? `${unparkResult.count} outlet(s) un-parked` : undefined}
              successDetail={unparkResult ? (
                unparkResult.notFound.length > 0
                  ? <span data-testid="unpark-notfound">{unparkResult.notFound.length} code(s) were not un-parked (not found or not currently parked): {unparkResult.notFound.join(', ')}</span>
                  : <span>All uploaded outlets were returned to the sales queue.</span>
              ) : undefined}
              onConfirm={async () => {
                setUnparkSubmitError(null);
                const codes = unparkValidation?.rows.filter(r => r.status === 'OK').map(r => r.outletId) ?? [];
                setUnparkProgress('Saving…');
                const result = await postInBatches('/api/admin/outlets/unpark', codes, (batch) => ({ outletCodes: batch }),
                  (done, total) => { if (total > 1) setUnparkProgress(`Uploading batch ${done + 1} of ${total}…`); });
                setUnparkProgress(null);
                if (!result.ok) {
                  setUnparkSubmitError(`Un-parking failed: ${result.message}${batchRemainderNote(result.appliedBatches)}`);
                  return;
                }
                const unparked = result.data.reduce((s, d) => s + Number(d.unparked ?? 0), 0);
                const notFound = result.data.flatMap(d => Array.isArray(d.notFound) ? (d.notFound as string[]) : []);
                setUnparkResult({ count: unparked, notFound });
                setUnparkUploadState('confirmed');
                void loadOutlets();
                void loadAllOutlets();
              }}
              onClear={() => { setUnparkValidation(null); setUnparkUploadState('idle'); setUnparkSubmitError(null); setUnparkResult(null); setUnparkProgress(null); }}
              confirmLabel="Un-park Outlets"
              submitError={unparkSubmitError}
              submitting={unparkProgress !== null}
              submitNote={unparkProgress}
            />
          </div>

          {/* Currently parked outlets quick reference (from the full tenant list) */}
          {allOutlets.some(o => o.kycStatus === 'PARKED') && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-slate-50">
                <p className="text-xs font-semibold text-slate-600 flex items-center gap-2">
                  <Archive className="w-3.5 h-3.5" />
                  Currently parked ({allOutlets.filter(o => o.kycStatus === 'PARKED').length}) — these can be un-parked
                </p>
              </div>
              <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
                {allOutlets.filter(o => o.kycStatus === 'PARKED').map(o => (
                  <div key={o.outletId} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 bg-slate-100 rounded-full flex items-center justify-center shrink-0">
                        <Building2 className="w-3.5 h-3.5 text-slate-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{o.outletName}</p>
                        <p className="text-xs text-gray-400 font-mono">{o.outletId}{o.city ? ` · ${o.city}` : ''}</p>
                      </div>
                    </div>
                    <span className="text-xs text-slate-700 bg-slate-100 px-2 py-1 rounded-full font-medium flex items-center gap-1 shrink-0">
                      <Archive className="w-3 h-3" /> Parked
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {editOutlet && (
        <OutletEditModal
          outlet={editOutlet}
          outletTypes={outletTypes}
          onClose={() => setEditOutlet(null)}
          onSaved={(msg) => { setEditToast(msg); setTimeout(() => setEditToast(null), 3000); void loadOutlets(); }}
        />
      )}

      {editToast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-gray-900 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          {editToast}
        </div>
      )}
    </div>
  );
}
