'use client';

/**
 * VisibilityAmountUploadPanel — the GIFSY_ADMIN back-office Excel surface for the
 * AMOUNT_UPLOAD visibility capture mode (VISIBILITY-POSM-DESIGN.md D3). Tenants that
 * capture visibility OUTSIDE the app record it here via a monthly Excel bulk upload
 * (into `OutletVisibilityRecord`), instead of the in-app PHOTO_APPROVAL capture/approve
 * flow. The two modes never collide (different tables) — this panel is only rendered by
 * the admin Visibility page when `visibilityCaptureMode === 'AMOUNT_UPLOAD'`.
 *
 * Restored from the pre-rebuild admin/visibility page (the photo-approval rebuild
 * dropped this bulk-upload surface). Three steps: download the template, upload the
 * completed file (POST /api/admin/visibility/bulk-upload — still live), download a
 * month's records report.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Upload, Download, FileSpreadsheet, Loader2, CheckCircle2, AlertTriangle, XCircle,
} from 'lucide-react';
import { generateVisibilityTemplate, VISIBILITY_UPLOAD_HEADERS } from '@/lib/visibility-upload';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface UploadResult {
  batchId: string;
  rowCount: number;
  successCount: number;
  errorCount: number;
  errorFileBase64: string | null;
}

interface VisibilityRecord {
  id: string;
  outletCode: string;
  month: string;
  status: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED';
  dateOfCapture: string | null;
  approvedBy: string | null;
  uploadBatch: { fileName: string; createdAt: string; uploadedByUserId: string } | null;
}

export function VisibilityAmountUploadPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recMonth, setRecMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [downloadingReport, setDownloadingReport] = useState(false);

  const handleTemplateDownload = () => {
    const raw = generateVisibilityTemplate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = new Blob([raw as any], { type: XLSX_MIME });
    downloadBlob(blob, 'visibility_upload_template.xlsx');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadFile(e.target.files?.[0] ?? null);
    setUploadResult(null);
    setUploadError(null);
  };

  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadResult(null);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      const res = await fetch('/api/admin/visibility/bulk-upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) setUploadError(json.error ?? 'Upload failed');
      else setUploadResult(json.data as UploadResult);
    } catch {
      setUploadError('Network error — please try again');
    } finally {
      setUploading(false);
    }
  };

  const handleErrorDownload = (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
    downloadBlob(new Blob([bytes], { type: XLSX_MIME }), 'visibility_upload_errors.xlsx');
  };

  const handleReportDownload = useCallback(async () => {
    setDownloadingReport(true);
    try {
      const res = await fetch(`/api/admin/visibility/records?month=${recMonth}&limit=10000`);
      if (!res.ok) return;
      const json = await res.json();
      const rows: VisibilityRecord[] = json.data?.records ?? [];
      const XLSX = await import('xlsx');
      const sheetData = [
        ['Outlet Code', 'Month', 'Status', 'Capture Date', 'Approved By', 'Source File', 'Uploaded At'],
        ...rows.map((r) => [
          r.outletCode,
          r.month,
          r.status,
          r.dateOfCapture ?? '',
          r.approvedBy ?? '',
          r.uploadBatch?.fileName ?? '',
          r.uploadBatch?.createdAt ? new Date(r.uploadBatch.createdAt).toLocaleString() : '',
        ]),
      ];
      const ws = aoaToSheetSafe(sheetData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Visibility Records');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      downloadBlob(new Blob([buf], { type: XLSX_MIME }), `visibility_records_${recMonth}.xlsx`);
    } finally {
      setDownloadingReport(false);
    }
  }, [recMonth]);

  return (
    <div className="space-y-5" data-testid="visibility-amount-upload">
      <div className="rounded-xl bg-blue-50 border border-blue-100 px-4 py-3 flex items-start gap-2">
        <FileSpreadsheet className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
        <p className="text-xs text-blue-700">
          This tenant is in <strong>amount-upload</strong> mode — visibility is captured off-app and
          recorded here via a monthly Excel upload. The in-app photo-capture / approval queue does not apply.
        </p>
      </div>

      {/* Step 1 — download template */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-gray-800">1. Download the upload template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Fill in outlet codes, month (YYYY-MM), status, and optional capture details.
              Do not change or reorder column headers.
            </p>
          </div>
          <button
            onClick={handleTemplateDownload}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-200 text-sm font-semibold hover:bg-indigo-100 transition-colors shrink-0"
          >
            <Download className="w-4 h-4" /> Download Template
          </button>
        </div>
        <div className="mt-3 rounded-lg bg-gray-50 border border-gray-100 p-3">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Required columns</p>
          <div className="flex flex-wrap gap-1.5">
            {VISIBILITY_UPLOAD_HEADERS.map((col) => (
              <span key={col} className="text-[11px] font-mono bg-white border border-gray-200 px-2 py-0.5 rounded text-gray-600">{col}</span>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-2">
            Status values: <strong>PENDING</strong> · <strong>UNDER_REVIEW</strong> · <strong>APPROVED</strong> (case-insensitive).
            &nbsp;Date format: <strong>DD-MM-YYYY</strong>.
          </p>
        </div>
      </div>

      {/* Step 2 — upload file */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-800">2. Upload completed file</p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer px-4 py-2 rounded-xl border-2 border-dashed border-gray-300 text-gray-600 text-sm font-medium hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors">
            <FileSpreadsheet className="w-4 h-4" />
            {uploadFile ? uploadFile.name : 'Choose .xlsx / .xls file'}
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} aria-label="Choose visibility upload file" />
          </label>
          <button
            onClick={handleUpload}
            disabled={!uploadFile || uploading}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-[var(--brand-primary)] text-white text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {uploading ? (<><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</>) : (<><Upload className="w-4 h-4" /> Upload</>)}
          </button>
        </div>

        {uploadError && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {uploadError}
          </div>
        )}

        {uploadResult && (
          <div className={`rounded-xl border p-4 space-y-3 ${uploadResult.errorCount === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className="flex items-center gap-2">
              {uploadResult.errorCount === 0
                ? <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                : <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />}
              <p className={`text-sm font-semibold ${uploadResult.errorCount === 0 ? 'text-emerald-800' : 'text-amber-800'}`}>
                {uploadResult.errorCount === 0
                  ? `All ${uploadResult.successCount} rows uploaded successfully`
                  : `${uploadResult.successCount} of ${uploadResult.rowCount} rows saved — ${uploadResult.errorCount} errors`}
              </p>
            </div>
            <div className="flex gap-4 text-xs">
              <span className="text-gray-600">Total rows: <strong>{uploadResult.rowCount}</strong></span>
              <span className="text-emerald-700">Saved: <strong>{uploadResult.successCount}</strong></span>
              {uploadResult.errorCount > 0 && (
                <span className="text-red-600">Errors: <strong>{uploadResult.errorCount}</strong></span>
              )}
            </div>
            {uploadResult.errorFileBase64 && (
              <button
                onClick={() => handleErrorDownload(uploadResult.errorFileBase64!)}
                className="flex items-center gap-2 text-sm font-semibold text-red-700 hover:underline"
              >
                <Download className="w-4 h-4" /> Download Error Report (.xlsx)
              </button>
            )}
          </div>
        )}
      </div>

      {/* Step 3 — download records report */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-gray-800">3. Download records report</p>
            <p className="text-xs text-gray-500 mt-0.5">Export all visibility records for a month as an Excel file.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="month"
              value={recMonth}
              onChange={(e) => setRecMonth(e.target.value)}
              aria-label="Records month"
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-[var(--brand-primary)]"
            />
            <button
              onClick={handleReportDownload}
              disabled={downloadingReport}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 text-sm font-semibold hover:bg-emerald-100 disabled:opacity-40 transition-colors"
            >
              {downloadingReport ? (<><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>) : (<><Download className="w-4 h-4" /> Download Report</>)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VisibilityAmountUploadPanel;
