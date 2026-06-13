'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Download, Upload, FileSpreadsheet,
  CheckCircle2, Info, Trash2, History, AlertTriangle,
} from 'lucide-react';
import {
  generateSalesTemplate,
  parseSalesUpload,
  buildSalesReportBuffer,
  type SalesParseResult,
} from '@/lib/sales-excel-upload';
import { getTenantKpiDefs } from '@/lib/platform/tenant-kpi-config';
import { MOCK_OUTLETS, formatMonth } from '@/lib/targets';
import type { NewOutletType } from '@/lib/targets';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAllOutletIds(): Set<string> {
  const ids = new Set<string>();
  const outlets = MOCK_OUTLETS as Record<NewOutletType, Array<{ id: string }>>;
  for (const list of Object.values(outlets)) {
    for (const o of list) ids.add(o.id);
  }
  return ids;
}

function downloadBuffer(buf: ArrayBuffer, filename: string) {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

// ── Upload History Component ──────────────────────────────────────────────────

function UploadHistory({ refreshKey }: { refreshKey: number }) {
  const [batches,   setBatches]   = useState<UploadBatch[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId,  setConfirmId]  = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setFetchError(false);
    fetch('/api/admin/sales/batches')
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
      const res  = await fetch(`/api/admin/sales/batches/${batchId}`, { method: 'DELETE' });
      const body = await res.json();
      if (body.success) {
        setBatches(prev => prev.filter(b => b.id !== batchId));
      }
    } catch (e) {
      console.error('Delete batch failed:', e);
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SalesUploadPage() {
  const monthOptions               = getSalesMonthOptions();
  const [salesMonth, setSalesMonth] = useState(monthOptions[0].value);
  const [kpiDefs]                   = useState(() => getTenantKpiDefs());
  const [fileName,    setFileName]  = useState('');
  const [parsing,     setParsing]   = useState(false);
  const [saving,      setSaving]    = useState(false);
  const [parseResult, setParseResult] = useState<SalesParseResult | null>(null);
  const [saved,       setSaved]     = useState(false);
  const [savedBatchId, setSavedBatchId] = useState<string | null>(null);
  const [historyKey,  setHistoryKey] = useState(0);   // bump to refresh history
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Template download ──────────────────────────────────────────────────

  function handleDownloadTemplate() {
    const buf = generateSalesTemplate(kpiDefs, salesMonth);
    downloadBuffer(buf, `sales_template_${salesMonth}.xlsx`);
  }

  // ── Upload & parse ─────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setParsing(true);
    setParseResult(null);
    setSaved(false);
    setSavedBatchId(null);
    try {
      const arrayBuf = await file.arrayBuffer();
      const result   = parseSalesUpload(arrayBuf, kpiDefs, getAllOutletIds());
      setParseResult(result);
    } catch (e) {
      console.error('Sales upload parse error:', e);
    } finally {
      setParsing(false);
    }
  }, [kpiDefs]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  // ── Save — wired to real API ───────────────────────────────────────────

  async function handleSave() {
    if (!parseResult || parseResult.summary.saved === 0) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/sales/bulk-upload', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month:        salesMonth,
          acceptedRows: parseResult.salesData,
        }),
      });
      const body = await res.json();
      if (res.ok && body.batchId) {
        setSaved(true);
        setSavedBatchId(body.batchId);
        setHistoryKey(k => k + 1);   // refresh history list
      } else {
        console.error('[SALES] Save failed:', body);
      }
    } catch (e) {
      console.error('[SALES] Save error:', e);
    } finally {
      setSaving(false);
    }
  }

  // ── Download report ────────────────────────────────────────────────────

  function handleDownloadReport() {
    if (!parseResult) return;
    downloadBuffer(
      buildSalesReportBuffer(parseResult.rows),
      `sales_upload_report_${salesMonth}.xlsx`,
    );
  }

  const currentMonthLabel = monthOptions.find(m => m.value === salesMonth)?.label ?? salesMonth;

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
                onClick={() => { setSalesMonth(m.value); setParseResult(null); setSaved(false); setSavedBatchId(null); }}
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
              Drop your completed file here. Unknown outlet IDs are automatically skipped.
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

        {parsing && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-4 h-4 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
            Parsing file…
          </div>
        )}
      </div>

      {/* ── Step 3: Results ───────────────────────────────────────────────── */}
      {parseResult && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Upload Result</p>
            {saved && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Saved for {currentMonthLabel}
                {savedBatchId && <span className="opacity-60 font-normal ml-1">· {savedBatchId.slice(-8)}</span>}
              </span>
            )}
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([
              { label: 'Total rows', value: parseResult.summary.total,   cls: 'bg-gray-50   border-gray-200  text-gray-800'  },
              { label: 'Saved',      value: parseResult.summary.saved,   cls: 'bg-green-50  border-green-200 text-green-700' },
              { label: 'Skipped',    value: parseResult.summary.skipped, cls: 'bg-amber-50  border-amber-200 text-amber-700' },
              { label: 'Errors',     value: parseResult.summary.errors,  cls: 'bg-red-50    border-red-200   text-red-700'   },
            ] as const).map(({ label, value, cls }) => (
              <div key={label} className={`rounded-xl border px-4 py-3 text-center ${cls}`}>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs font-medium mt-0.5 opacity-70">{label}</p>
              </div>
            ))}
          </div>

          {/* Skipped / error rows */}
          {parseResult.rows.filter(r => r.status !== 'saved').length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1 max-h-44 overflow-y-auto">
              <p className="text-xs font-semibold text-amber-700 mb-2">Skipped / Error rows</p>
              {parseResult.rows
                .filter(r => r.status !== 'saved')
                .slice(0, 20)
                .map(r => (
                  <p key={r.rowIndex} className="text-xs text-amber-700">
                    <span className="font-mono font-semibold">Row {r.rowIndex} — {r.outletId}:</span>{' '}
                    {r.remarks}
                  </p>
                ))}
              {parseResult.rows.filter(r => r.status !== 'saved').length > 20 && (
                <p className="text-xs text-amber-500">…download the report for full details</p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 flex-wrap">
            {parseResult.summary.saved > 0 && !saved && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {saving
                  ? <><div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Saving…</>
                  : <><CheckCircle2 className="w-4 h-4" /> Save {parseResult.summary.saved} row{parseResult.summary.saved !== 1 ? 's' : ''} for {currentMonthLabel}</>
                }
              </button>
            )}
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

      {/* ── Upload History ────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-purple-50">
            <History className="w-4 h-4 text-purple-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Upload History</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Delete test uploads before going live. Deleting removes all saved records for that month.
            </p>
          </div>
        </div>
        <UploadHistory refreshKey={historyKey} />
      </div>

    </div>
  );
}
