'use client';

/**
 * Admin Target Upload page — FE-A (Targets / Stream T).
 *
 * Data source:
 *   Server-side xlsx (the client-side parsing path is REMOVED — backend parses now):
 *     Template download: GET /api/admin/targets/template?months=YYYY-MM,YYYY-MM
 *                        → RAW xlsx binary (NOT JSON-wrapped) → browser download
 *     Upload:            POST /api/admin/targets/upload (FormData, field "file")
 *                        → { success: true, data: { batchId, month, monthsInBatch,
 *                             totalRows, acceptedCount, rejectedCount, rows } }
 *
 * The client-side xlsx parsing path is REMOVED. The backend parses now.
 * UI shell / styling is preserved; only the data layer changes.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Upload, Download, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, FileSpreadsheet,
  AlertTriangle, Info,
} from 'lucide-react';
import { authHeader } from '@/lib/api-client';
import { buildMonthRange, formatMonth } from '@/lib/targets';
import DownloadErrorReportButton from '@/components/admin/DownloadErrorReportButton';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single parsed row as returned by the backend */
interface UploadRow {
  rowIndex:  number;
  outletCode?: string;
  outletId?:   string;
  month?:      string;
  status:      'accepted' | 'rejected' | 'skipped' | 'updated' | 'error';
  remarks?:    string;
  [key: string]: unknown;
}

interface UploadResult {
  batchId:       string;
  month:         string;
  monthsInBatch: string[];
  writableMonths?:       string[];
  skippedLockedMonths?:  string[];
  totalRows:     number;
  acceptedCount: number;
  rejectedCount: number;
  rows:          UploadRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Trigger a browser download from a Blob */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TargetUploadPage() {
  // Month range for template
  const monthOptions = buildMonthRange(12);
  const [fromMonth, setFromMonth] = useState(monthOptions[0]?.value ?? '');
  const [toMonth,   setToMonth]   = useState(monthOptions[2]?.value ?? monthOptions[0]?.value ?? '');

  // Upload state
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const [fileName,    setFileName]    = useState('');
  const [uploading,   setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [result,      setResult]      = useState<UploadResult | null>(null);

  // Template download state
  const [downloading,   setDownloading]   = useState(false);
  const [downloadError, setDownloadError] = useState('');

  // KPI count hint (fetched once on mount)
  const [kpiCount, setKpiCount] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/admin/kpis', { headers: authHeader() })
      .then(r => r.json())
      .then((j: { success: boolean; data?: unknown[] }) => {
        if (j.success && Array.isArray(j.data)) setKpiCount(j.data.filter((k: unknown) => (k as { enabled?: boolean }).enabled).length);
      })
      .catch(() => {});
  }, []);

  // ── Month helpers ──────────────────────────────────────────────────────────

  function selectedMonths(): string[] {
    const from = monthOptions.findIndex(m => m.value === fromMonth);
    const to   = monthOptions.findIndex(m => m.value === toMonth);
    if (from < 0 || to < 0 || to < from) return [];
    return monthOptions.slice(from, to + 1).map(m => m.value);
  }

  function handleFromChange(val: string) {
    setFromMonth(val);
    const fromIdx = monthOptions.findIndex(m => m.value === val);
    const toIdx   = monthOptions.findIndex(m => m.value === toMonth);
    if (toIdx < fromIdx) setToMonth(val);
  }

  // Quarter-aware presets
  const PRESETS = (() => {
    const now  = new Date();
    const cm   = now.getMonth() + 1;
    const cy   = now.getFullYear();
    const cq   = Math.ceil(cm / 3);
    const curr = monthOptions[0]?.value ?? '';

    const tqEndM  = cq * 3;
    const tqEnd   = `${cy}-${String(tqEndM).padStart(2, '0')}`;

    const nq      = cq === 4 ? 1 : cq + 1;
    const ny      = cq === 4 ? cy + 1 : cy;
    const nqStart = `${ny}-${String((nq - 1) * 3 + 1).padStart(2, '0')}`;
    const nqEnd   = `${ny}-${String(nq * 3).padStart(2, '0')}`;

    const mo = (i: number) => monthOptions[i]?.value ?? curr;

    return [
      { label: 'This Quarter', from: curr,    to: tqEnd,  key: 'tq'  },
      { label: 'Next Quarter', from: nqStart, to: nqEnd,  key: 'nq'  },
      { label: '6 months',     from: curr,    to: mo(5),  key: '6m'  },
      { label: '12 months',    from: curr,    to: mo(11), key: '12m' },
    ];
  })();

  const activePreset = PRESETS.find(p => p.from === fromMonth && p.to === toMonth)?.key ?? null;

  const chosenMonths   = selectedMonths();
  const toOptions      = monthOptions.filter(m => m.value >= fromMonth);
  const monthSpanLabel = chosenMonths.length > 0
    ? `${monthOptions.find(m => m.value === chosenMonths[0])?.label} → ${monthOptions.find(m => m.value === chosenMonths[chosenMonths.length - 1])?.label}`
    : '—';

  // ── Template download ──────────────────────────────────────────────────────

  async function handleDownloadTemplate() {
    const months = selectedMonths();
    if (months.length === 0) return;

    setDownloading(true);
    setDownloadError('');

    try {
      const qs       = months.join(',');
      const filename = `targets_template_${months[0]}_to_${months[months.length - 1]}.xlsx`;

      const res = await fetch(`/api/admin/targets/template?months=${encodeURIComponent(qs)}`, {
        headers: authHeader(),
      });

      if (!res.ok) {
        // Try to parse an error message from JSON (backend sends { success: false, error })
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json() as { error?: string; message?: string };
          msg = j.error ?? j.message ?? msg;
        } catch { /* ignore */ }
        setDownloadError(msg);
        return;
      }

      // SUCCESS — the response body is raw xlsx binary
      const blob = await res.blob();
      downloadBlob(blob, filename);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  // ── Download Final Targets (export stored targets for the From month) ───────

  async function handleDownloadFinal() {
    if (!fromMonth) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const res = await fetch(
        `/api/admin/targets/export?month=${encodeURIComponent(fromMonth)}`,
        { headers: authHeader() },
      );
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          msg = j.error ?? j.message ?? msg;
        } catch { /* ignore */ }
        setDownloadError(msg);
        return;
      }
      const blob = await res.blob();
      downloadBlob(blob, `final_targets_${fromMonth}.xlsx`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setUploading(true);
    setUploadError('');
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/admin/targets/upload', {
        method:  'POST',
        headers: authHeader(), // Do NOT add Content-Type — let the browser set multipart boundary
        body:    formData,
      });

      const json = await res.json() as { success: boolean; data?: UploadResult; error?: string };

      if (!res.ok || !json.success) {
        setUploadError(json.error ?? `Upload failed (HTTP ${res.status})`);
        return;
      }

      setResult(json.data!);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, []);

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so the same file can be re-picked
    e.target.value = '';
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const [kpiHintOpen, setKpiHintOpen] = useState(false);

  return (
    <div className="space-y-5 pb-10">

      {/* ── Section 1: KPI hint ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setKpiHintOpen(o => !o)}
          className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gray-100">
              <Info className="w-4 h-4 text-gray-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">About this page</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {kpiCount !== null
                  ? `${kpiCount} enabled KPI${kpiCount !== 1 ? 's' : ''} will appear as columns in the template`
                  : 'KPI columns are driven by the KPI catalogue'}
              </p>
            </div>
          </div>
          {kpiHintOpen
            ? <ChevronUp   className="w-4 h-4 text-gray-400" />
            : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {kpiHintOpen && (
          <div className="border-t border-gray-100 px-6 py-4">
            <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-500" />
              <span>
                The Excel template is built from the tenant&apos;s enabled KPIs and active outlet roster.
                To add or change KPIs, visit{' '}
                <a href="/admin/targets" className="underline font-semibold">KPI Management</a>.
                Upload is parsed server-side — the backend validates outlet codes and KPI columns.
                Blank cells are skipped (not stored as 0).
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: Download Template ───────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-green-50">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 1 — Download Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Generate a blank Excel pre-filled with the outlet roster and KPI columns, then upload it below.
            </p>
          </div>
        </div>

        {/* Preset chips */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 font-semibold mr-1">Quick select:</span>
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => { setFromMonth(p.from); setToMonth(p.to); }}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                activePreset === p.key
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* From / To / Download */}
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">From</label>
            <select
              value={fromMonth}
              onChange={e => handleFromChange(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400"
            >
              {monthOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">To</label>
            <select
              value={toMonth}
              onChange={e => setToMonth(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400"
            >
              {toOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleDownloadTemplate}
            disabled={chosenMonths.length === 0 || downloading}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {downloading
              ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              : <Download className="w-4 h-4" />}
            Download Template
          </button>
          <button
            onClick={handleDownloadFinal}
            disabled={!fromMonth || downloading}
            title="Export the stored (final) targets for the From month"
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 text-sm font-semibold rounded-xl hover:border-gray-400 disabled:opacity-40 transition-colors"
          >
            <Download className="w-4 h-4" />
            Download Final Targets
          </button>
        </div>

        {/* Summary line */}
        {chosenMonths.length > 0 && (
          <p className="text-xs text-gray-500">
            <span className="font-semibold text-gray-700">{monthSpanLabel}</span>
            {' '}· {chosenMonths.length} month{chosenMonths.length !== 1 ? 's' : ''}
            {kpiCount !== null && ` · ${kpiCount} KPI column${kpiCount !== 1 ? 's' : ''} per month`}
          </p>
        )}

        {downloadError && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
            <XCircle className="w-4 h-4 shrink-0" /> {downloadError}
          </div>
        )}
      </div>

      {/* ── Section 3: Upload ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-50">
            <Upload className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Step 2 — Upload Filled Template</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Upload your completed Excel. The backend validates outlet codes and KPI columns. Re-upload is idempotent.
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
            : (
              <>
                <p className="text-sm text-gray-400">Drop your Excel here or <span className="text-[var(--brand-primary)] font-medium underline">browse</span></p>
                <p className="text-xs text-gray-300 mt-1">Accepts .xlsx and .xls</p>
              </>
            )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileInputChange}
            className="hidden"
          />
        </div>

        {uploading && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-4 h-4 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
            Uploading and parsing file…
          </div>
        )}

        {uploadError && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{uploadError}</span>
          </div>
        )}
      </div>

      {/* ── Section 4: Results ─────────────────────────────────────────────── */}
      {result && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Upload Result</p>
            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Batch {result.batchId.slice(-8)}
            </span>
          </div>

          {/* Month chips */}
          <div className="flex flex-wrap gap-1.5">
            {result.monthsInBatch.map(m => (
              <span key={m} className="text-[10px] font-semibold px-2 py-0.5 bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] rounded-full">
                {formatMonth(m)}
              </span>
            ))}
          </div>

          {/* Summary stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total rows"  value={result.totalRows}     color="gray"  />
            <StatCard label="Accepted"    value={result.acceptedCount} color="green" />
            <StatCard label="Rejected"    value={result.rejectedCount} color={result.rejectedCount > 0 ? 'red' : 'gray'} />
            <StatCard label="Months"      value={result.monthsInBatch.length} color="gray" />
          </div>

          {/* Past-month lock notice */}
          {result.skippedLockedMonths && result.skippedLockedMonths.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-amber-700">
                {result.skippedLockedMonths.length} past month{result.skippedLockedMonths.length !== 1 ? 's' : ''} skipped (locked) — targets for a month already in the past can&apos;t be edited.
              </p>
              <p className="text-[11px] text-amber-600 mt-0.5">
                Not saved: {result.skippedLockedMonths.join(', ')}
              </p>
            </div>
          )}

          {/* Rejected rows preview */}
          {result.rows.filter(r => r.status === 'rejected' || r.status === 'error' || r.status === 'skipped').length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1 max-h-44 overflow-y-auto">
              <p className="text-xs font-semibold text-amber-700 mb-2">Skipped / Rejected rows</p>
              {result.rows
                .filter(r => r.status !== 'accepted' && r.status !== 'updated')
                .slice(0, 20)
                .map((r, i) => (
                  <p key={i} className="text-xs text-amber-700">
                    <span className="font-mono font-semibold">
                      Row {r.rowIndex ?? i + 1}
                      {r.outletCode ? ` — ${r.outletCode}` : r.outletId ? ` — ${r.outletId}` : ''}:{' '}
                    </span>
                    {r.remarks ?? String(r.status)}
                  </p>
                ))}
              {result.rows.filter(r => r.status !== 'accepted' && r.status !== 'updated').length > 20 && (
                <p className="text-xs text-amber-500">…{result.rows.filter(r => r.status !== 'accepted' && r.status !== 'updated').length - 20} more rows not shown</p>
              )}
              <div className="pt-2">
                <DownloadErrorReportButton
                  columns={['Row', 'Outlet Code', 'Month', 'Status']}
                  rows={result.rows
                    .filter(r => r.status !== 'accepted' && r.status !== 'updated')
                    .map(r => ({
                      Row:          r.rowIndex,
                      'Outlet Code': r.outletCode ?? r.outletId ?? '',
                      Month:        r.month ?? '',
                      Status:       r.status,
                      __errors:     [r.remarks ?? String(r.status)],
                    }))}
                  errorsByRow={(row) => (row.__errors as string[]) ?? []}
                  filename={`target-upload-errors-${result.batchId || 'batch'}.xlsx`}
                  sheetName="Upload Report"
                  errorHeader="Remarks"
                />
              </div>
            </div>
          )}

          {result.acceptedCount === 0 && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-sm text-amber-700">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              No rows were accepted. Check that the file uses the correct template and outlet codes match the roster.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

const STAT_COLORS = {
  gray:  'bg-gray-50   border-gray-200  text-gray-800',
  green: 'bg-green-50  border-green-200 text-green-700',
  amber: 'bg-amber-50  border-amber-200 text-amber-700',
  red:   'bg-red-50    border-red-200   text-red-700',
} as const;

function StatCard({ label, value, color }: { label: string; value: number; color: keyof typeof STAT_COLORS }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-center ${STAT_COLORS[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs font-medium mt-0.5 opacity-70">{label}</p>
    </div>
  );
}
