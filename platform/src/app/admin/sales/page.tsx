'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Download, Upload, FileSpreadsheet,
  CheckCircle2, Info, Trash2, History, AlertTriangle, BarChart3,
} from 'lucide-react';
import { buildAchievementReportBuffer } from '@/lib/achievement-report';
import { DEOLEO_DEFAULT_KPIS } from '@/lib/platform/tenant-kpi-config';
import type { TenantKpiDef } from '@/lib/platform/tenant-kpi-config';
import { formatMonth } from '@/lib/targets';

// ── Types ─────────────────────────────────────────────────────────────────────

interface UploadBatch {
  id:            string;
  month:         string;
  totalRows:     number;
  acceptedCount: number;
  rejectedCount: number;
  status:        string;
  createdAt:     string;
}

interface PaceKpi {
  code:     string;
  target:   number | null;
  achieved: number | null;
  pace:     number | null;
}

interface PaceOutlet {
  outletCode: string;
  outletName: string;
  outletType: string;
  month:      string;
  kpis:       PaceKpi[];
}

interface PaceData {
  month:   string;
  outlets: PaceOutlet[];
}

// ── Upload result row type (from backend) ─────────────────────────────────────

interface UploadResultRow {
  rowIndex:   number;
  outletCode: string;
  status:     string;
  remarks:    string;
}

interface UploadResult {
  batchId:       string;
  month:         string;
  monthsInBatch: string[];
  totalRows:     number;
  acceptedCount: number;
  rejectedCount: number;
  rows:          UploadResultRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadBuffer(buf: ArrayBuffer, filename: string) {
  downloadBlob(
    new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    filename,
  );
}

/** Current month and previous month — sales upload is always historical */
function getSalesMonthOptions(): Array<{ value: string; label: string }> {
  const now  = new Date();
  const opts: Array<{ value: string; label: string }> = [];
  for (const offset of [0, -1]) {
    const d     = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    opts.push({ value, label: formatMonth(value) });
  }
  return opts;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function authHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Upload History Component ──────────────────────────────────────────────────

function UploadHistory({ refreshKey }: { refreshKey: number }) {
  const [batches,    setBatches]    = useState<UploadBatch[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId,  setConfirmId]  = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setFetchError(false);
    // ↳ Repointed: /api/admin/sales/batches → /api/admin/achievements/batches
    fetch('/api/admin/achievements/batches', { headers: authHeader() })
      .then(r => r.json())
      .then(body => {
        if (body.success) setBatches(body.data);
        else setFetchError(true);
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  async function handleDelete(batchId: string) {
    setDeletingId(batchId);
    setConfirmId(null);
    try {
      // Backend DELETE on the achievements module — deletes the SalesUploadBatch and
      // cascades its OutletSalesRecord rows. (The old /admin/sales/batches/:id route
      // never existed post platform-Prisma-retirement; this is the real endpoint.)
      const res  = await fetch(`/api/admin/achievements/batches/${batchId}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setBatches(prev => prev.filter(b => b.id !== batchId));
        setDeleteError(null);
      } else {
        setDeleteError('Could not delete this upload — please try again.');
      }
    } catch (e) {
      console.error('Delete batch failed:', e);
      setDeleteError('Network error deleting this upload — please try again.');
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <div className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
        Loading upload history…
      </div>
    );
  }

  if (fetchError) {
    return (
      <p className="text-sm text-amber-600 py-2">Could not load upload history — try refreshing the page.</p>
    );
  }

  if (batches.length === 0) {
    return (
      <p className="text-sm text-gray-400 py-2">No uploads yet for this tenant.</p>
    );
  }

  return (
    <div className="divide-y divide-gray-100">
      {deleteError && (
        <p className="text-sm text-red-600 py-2 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          {deleteError}
        </p>
      )}
      {batches.map(batch => (
        <div key={batch.id} className="flex items-center justify-between py-3 gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-800">{formatMonth(batch.month)}</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                {batch.acceptedCount} rows saved
              </span>
              {batch.rejectedCount > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  {batch.rejectedCount} skipped
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">{formatDate(batch.createdAt)}</p>
          </div>

          {/* Confirm → Delete flow */}
          {confirmId === batch.id ? (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-red-600 font-medium flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                Delete all {batch.acceptedCount} records?
              </span>
              <button
                onClick={() => handleDelete(batch.id)}
                disabled={deletingId === batch.id}
                className="px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deletingId === batch.id ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button
                onClick={() => setConfirmId(null)}
                className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmId(batch.id)}
              disabled={deletingId === batch.id}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-40 shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Pace View Component ───────────────────────────────────────────────────────

function PaceView({ month }: { month: string }) {
  const [paceData,   setPaceData]   = useState<PaceData | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!month) return;
    setLoading(true);
    setFetchError(null);
    setPaceData(null);
    // ↳ New endpoint: /api/admin/achievements/pace?month=YYYY-MM
    fetch(`/api/admin/achievements/pace?month=${encodeURIComponent(month)}`, {
      headers: authHeader(),
    })
      .then(r => r.json())
      .then(body => {
        if (body.success) setPaceData(body.data as PaceData);
        else setFetchError(body.error ?? 'Failed to load pace data');
      })
      .catch(() => setFetchError('Network error loading pace data'))
      .finally(() => setLoading(false));
  }, [month]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <div className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
        Loading pace data…
      </div>
    );
  }

  if (fetchError) {
    return <p className="text-sm text-amber-600 py-2">{fetchError}</p>;
  }

  if (!paceData || paceData.outlets.length === 0) {
    return (
      <p className="text-sm text-gray-400 py-2">
        No pace data for {formatMonth(month)}. Upload targets and achievements first.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Outlet</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Type</th>
            {paceData.outlets[0]?.kpis.map(k => (
              <th
                key={k.code}
                colSpan={3}
                className="text-center px-3 py-2 font-semibold text-gray-600 border-l border-gray-200 whitespace-nowrap"
              >
                {k.code}
              </th>
            ))}
          </tr>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-3 py-1" />
            <th className="px-3 py-1" />
            {paceData.outlets[0]?.kpis.map(k => (
              <React.Fragment key={k.code}>
                <th className="text-center px-2 py-1 font-medium text-gray-500 border-l border-gray-200">Target</th>
                <th className="text-center px-2 py-1 font-medium text-gray-500">Achieved</th>
                <th className="text-center px-2 py-1 font-medium text-gray-500">Pace</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {paceData.outlets.map(outlet => (
            <tr key={outlet.outletCode} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
              <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">
                <span className="block text-xs font-semibold text-gray-900">{outlet.outletName}</span>
                <span className="block text-[10px] text-gray-400 font-mono">{outlet.outletCode}</span>
              </td>
              <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{outlet.outletType}</td>
              {outlet.kpis.map(k => {
                const pctVal = k.pace !== null ? Math.round(k.pace * 100) : null;
                const pctColor =
                  pctVal === null  ? 'text-gray-400' :
                  pctVal >= 100    ? 'text-emerald-600 font-semibold' :
                  pctVal >= 80     ? 'text-amber-600' :
                  pctVal >= 60     ? 'text-orange-500' :
                                     'text-red-500';
                return (
                  <React.Fragment key={`${outlet.outletCode}-${k.code}`}>
                    <td className="text-center px-2 py-2 border-l border-gray-100 text-gray-700">
                      {k.target ?? '—'}
                    </td>
                    <td className="text-center px-2 py-2 text-gray-700">
                      {k.achieved ?? '—'}
                    </td>
                    <td className={`text-center px-2 py-2 ${pctColor}`}>
                      {pctVal !== null ? `${pctVal}%` : '—'}
                    </td>
                  </React.Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SalesUploadPage() {
  const monthOptions                = getSalesMonthOptions();
  const [salesMonth, setSalesMonth] = useState(monthOptions[0].value);
  const [kpiDefs, setKpiDefs]       = useState<TenantKpiDef[]>(DEOLEO_DEFAULT_KPIS);
  const [fileName,    setFileName]  = useState('');
  const [uploading,   setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [saved,       setSaved]     = useState(false);
  const [historyKey,  setHistoryKey] = useState(0);  // bump to refresh history
  const [showPace,    setShowPace]  = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch the tenant's KPI definitions from the backend.
  useEffect(() => {
    fetch('/api/admin/kpis', { headers: authHeader() })
      .then(r => r.json())
      .then(j => {
        if (j.success && Array.isArray(j.data) && j.data.length > 0) {
          // Backend KpiDef → FE TenantKpiDef: the FE keys template columns by
          // `id`, which must be the KPI *code* (e.g. MONTH_TGT), not the cuid.
          type BackendKpi = {
            code: string; label: string; unit: string; isPrimary: boolean;
            hasNameOverride: boolean; nameOverrideLabel: string | null;
            order: number; enabled: boolean;
          };
          setKpiDefs(
            (j.data as BackendKpi[]).map((k) => ({
              id: k.code,
              label: k.label,
              unit: k.unit,
              isPrimary: k.isPrimary,
              hasNameOverride: k.hasNameOverride,
              nameOverrideLabel: k.nameOverrideLabel ?? '',
              order: k.order,
              enabled: k.enabled,
            })),
          );
        }
      })
      .catch(() => {});
  }, []);

  // ── Template download ──────────────────────────────────────────────────

  async function handleDownloadTemplate() {
    setDownloadError('');
    try {
      // Single source of truth: the backend builds the template from the SAME
      // month-group layout the achievement upload parser expects (real outlet
      // roster + enabled KpiDef columns), so template → fill → upload round-trips.
      const res = await fetch(
        `/api/admin/achievements/template?month=${encodeURIComponent(salesMonth)}`,
        { headers: authHeader() },
      );
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          msg = j.error ?? j.message ?? msg;
        } catch { /* body was not JSON */ }
        setDownloadError(msg);
        return;
      }
      const blob = await res.blob();
      downloadBlob(blob, `sales_template_${salesMonth}.xlsx`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Template download failed');
    }
  }

  // ── Upload file → send directly to backend via multipart ──────────────

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setUploadResult(null);
    setSaved(false);

    // Upload the raw xlsx to the backend (multipart); the backend parses + stores
    // and returns the authoritative per-row result used for the report download.
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file, file.name);

      const res  = await fetch('/api/admin/achievements/upload', {
        method:  'POST',
        headers: authHeader(),   // NO Content-Type — browser sets multipart boundary
        body:    formData,
      });
      const body = await res.json();

      if (res.ok && body.success) {
        setUploadResult(body.data as UploadResult);
        setSaved(true);
        setHistoryKey(k => k + 1);
      } else {
        console.error('[SALES] Upload failed:', body);
      }
    } catch (e) {
      console.error('[SALES] Upload error:', e);
    } finally {
      setUploading(false);
    }
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  // ── Download report ────────────────────────────────────────────────────

  function handleDownloadReport() {
    if (!uploadResult) return;
    // Built from the AUTHORITATIVE backend response (uploadResult.rows), not a
    // local re-parse — the backend is the single source of truth for what stored.
    downloadBuffer(
      buildAchievementReportBuffer(uploadResult.rows),
      `sales_upload_report_${salesMonth}.xlsx`,
    );
  }

  const currentMonthLabel = monthOptions.find(m => m.value === salesMonth)?.label ?? salesMonth;

  // Summary derived from upload result (authoritative server counts). The backend
  // rejectedCount counts only rejected_outlet/rejected_kpi rows; blank-skipped rows
  // are neither saved nor rejected, so derive them so the tiles reconcile to total
  // (saved + skipped + rejected === total).
  const summary = uploadResult
    ? {
        total:    uploadResult.totalRows,
        saved:    uploadResult.acceptedCount,
        rejected: uploadResult.rejectedCount,
        skipped:  Math.max(
          0,
          uploadResult.totalRows - uploadResult.acceptedCount - uploadResult.rejectedCount,
        ),
      }
    : null;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 pb-10">

      {/* ── Step 1: Month + Template ──────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-green-50">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 1 — Download Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Select the month, download the template, fill in actual sales numbers, then upload below.
            </p>
          </div>
        </div>

        {/* Month chips — current and previous only */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">Select month</p>
          <div className="flex items-center gap-2">
            {monthOptions.map((m, i) => (
              <button
                key={m.value}
                onClick={() => {
                  setSalesMonth(m.value);
                  setUploadResult(null);
                  setSaved(false);
                  setDownloadError('');
                  setShowPace(false);
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  salesMonth === m.value
                    ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]'
                }`}
              >
                {m.label}{i === 0 ? ' (current)' : ' (previous)'}
              </button>
            ))}
          </div>
        </div>

        {/* Info note */}
        <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-500" />
          <span>
            Template columns match the KPI structure configured for this month&apos;s targets.
            Outlet rows are pre-filled — just paste in your sales numbers.
          </span>
        </div>

        <button
          onClick={handleDownloadTemplate}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
        >
          <Download className="w-4 h-4" />
          Download Template — {currentMonthLabel}
        </button>

        {downloadError && (
          <p className="text-xs text-red-600">{downloadError}</p>
        )}
      </div>

      {/* ── Step 2: Upload ────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-50">
            <Upload className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 2 — Upload Filled Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Drop your completed file here. The file is validated and saved automatically.
            </p>
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-2xl px-8 py-10 text-center cursor-pointer hover:border-[var(--brand-primary)] hover:bg-green-50/30 transition-colors"
        >
          <FileSpreadsheet className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          {fileName
            ? <p className="text-sm font-medium text-gray-700">{fileName}</p>
            : <p className="text-sm text-gray-400">Drop your Excel here or <span className="text-[var(--brand-primary)] font-medium underline">browse</span></p>
          }
          <p className="text-xs text-gray-300 mt-1">Accepts .xlsx and .xls</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {uploading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-4 h-4 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
            Uploading and saving…
          </div>
        )}
      </div>

      {/* ── Step 3: Results ───────────────────────────────────────────────── */}
      {uploadResult && summary && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Upload Result</p>
            {saved && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Saved for {currentMonthLabel}
                <span className="opacity-60 font-normal ml-1">· {uploadResult.batchId.slice(-8)}</span>
              </span>
            )}
          </div>

          {/* Summary stats — saved + skipped + rejected === total */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([
              { label: 'Total rows',     value: summary.total,    cls: 'bg-gray-50   border-gray-200  text-gray-800'  },
              { label: 'Saved',          value: summary.saved,    cls: 'bg-green-50  border-green-200 text-green-700' },
              { label: 'Skipped (blank)',value: summary.skipped,  cls: 'bg-slate-50  border-slate-200 text-slate-600' },
              { label: 'Rejected',       value: summary.rejected, cls: 'bg-amber-50  border-amber-200 text-amber-700' },
            ] as const).map(({ label, value, cls }) => (
              <div key={label} className={`rounded-xl border px-4 py-3 text-center ${cls}`}>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs font-medium mt-0.5 opacity-70">{label}</p>
              </div>
            ))}
          </div>

          {/* Skipped / rejected rows from backend */}
          {uploadResult.rows.filter(r => r.status !== 'accepted').length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1 max-h-44 overflow-y-auto">
              <p className="text-xs font-semibold text-amber-700 mb-2">Rejected rows</p>
              {uploadResult.rows
                .filter(r => r.status !== 'accepted')
                .slice(0, 20)
                .map(r => (
                  <p key={r.rowIndex} className="text-xs text-amber-700">
                    <span className="font-mono font-semibold">Row {r.rowIndex} — {r.outletCode}:</span>{' '}
                    {r.remarks}
                  </p>
                ))}
              {uploadResult.rows.filter(r => r.status !== 'accepted').length > 20 && (
                <p className="text-xs text-amber-500">…download the report for full details</p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Report is built from the authoritative backend uploadResult.rows,
                which is guaranteed present inside this block. */}
            <button
              onClick={handleDownloadReport}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-600 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              Download Report
            </button>
          </div>
        </div>
      )}

      {/* ── Pace View ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-50">
              <BarChart3 className="w-4 h-4 text-indigo-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Pace View — {currentMonthLabel}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Target vs achievement vs pace per outlet × KPI. Pace = achieved ÷ target.
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowPace(v => !v)}
            className="text-xs font-medium text-[var(--brand-primary)] hover:underline"
          >
            {showPace ? 'Hide' : 'Show'}
          </button>
        </div>

        {showPace && <PaceView month={salesMonth} />}
      </div>

      {/* ── Upload History ────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-purple-50">
            <History className="w-4 h-4 text-purple-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Upload History</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Delete test uploads before going live. Deleting removes all saved records for that batch.
            </p>
          </div>
        </div>
        <UploadHistory refreshKey={historyKey} />
      </div>

    </div>
  );
}
