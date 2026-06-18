'use client';

/**
 * Admin TDS page — P6.5d
 *
 * Features:
 *   - FY selector
 *   - 194R tab (CLIENT_ADMIN + GIFSY_ADMIN): liability table + export + off-platform upload
 *   - 194C tab (GIFSY_ADMIN only): liability table + export
 *   - Deposit upload panel (section toggle, preview→apply two-step)
 *
 * Money: all API fields are integer paise; displayed via formatINR from @/lib/money
 * Auth:  bearer token from localStorage (matches other admin pages)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Download,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle,
  XCircle,
  RotateCcw,
  ChevronDown,
  Landmark,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { authHeader } from '@/lib/api-client';
import { formatINR } from '@/lib/money';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Tds194RRow {
  panNumber:        string;
  baseFyTotalPaise: number | string;
  liabilityPaise:   number | string;
  depositedPaise:   number | string;
  outstandingPaise: number | string;
}

interface Tds194RResponse {
  section:  string;
  fyLabel:  string;
  summary: {
    baseFyTotalPaise: number | string;
    liabilityPaise:   number | string;
    depositedPaise:   number | string;
    outstandingPaise: number | string;
  };
  rows: Tds194RRow[];
}

interface Tds194CRow {
  panNumber:               string;
  entityType:              string;
  maxSinglePaise:          number | string;
  thresholdMet:            boolean;
  liabilityPaise:          number | string;
  liabilityNoThresholdPaise: number | string;
  depositedPaise:          number | string;
  outstandingPaise:        number | string;
}

interface Tds194CResponse {
  section: string;
  fyLabel: string;
  summary: {
    liabilityPaise:          number | string;
    liabilityNoThresholdPaise: number | string;
    depositedPaise:          number | string;
    outstandingPaise:        number | string;
  };
  rows: Tds194CRow[];
}

interface UploadResult {
  processed: number;
  succeeded: number;
  skipped:   number;
  failed:    number;
  errors:    string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Numeric paise that may arrive as number or numeric string → always number */
function p(v: number | string | undefined | null): number {
  return Number(v ?? 0);
}

/** Current and recent financial years (e.g. "2025-26", "2024-25") */
function buildFyOptions(): string[] {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed
  // FY starts April; current FY is year-1 if before April
  const startYear = month >= 4 ? year : year - 1;
  return [0, 1, 2].map((offset) => {
    const s = startYear - offset;
    return `${s}-${String(s + 1).slice(-2)}`;
  });
}

/** Trigger a browser download of a blob response (xlsx) */
async function downloadXlsx(url: string, filename: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) {
      try {
        const j = (await res.json()) as { error?: string; message?: string };
        return j.error ?? j.message ?? `HTTP ${res.status}`;
      } catch { return `HTTP ${res.status}`; }
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href:     objectUrl,
      download: filename,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
    return null; // no error
  } catch (err) {
    return err instanceof Error ? err.message : 'Download failed';
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function OutstandingCell({ paise }: { paise: number | string }) {
  const v = p(paise);
  if (v === 0) return <span className="text-gray-500">—</span>;
  if (v < 0)   return <span className="text-emerald-600 font-semibold">{formatINR(-v)} cr</span>;
  return <span className="font-semibold text-red-600">{formatINR(v)}</span>;
}

function SummaryCard({ label, paise }: { label: string; paise: number | string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-bold text-gray-900 mt-1">{formatINR(p(paise))}</p>
    </div>
  );
}

/** Two-step upload panel: template download → pick file → preview (apply=false) → confirm (apply=true) */
function UploadPanel({
  title,
  templateUrl,
  templateFilename,
  uploadUrlFn,
  onApplied,
}: {
  title:             string;
  templateUrl:       string;
  templateFilename:  string;
  /** Returns the upload URL with the correct apply=true|false param */
  uploadUrlFn:       (apply: boolean) => string;
  /** Called after a successful apply so parent can refresh the table */
  onApplied:         () => void;
}) {
  const fileInputRef   = useRef<HTMLInputElement>(null);
  // Store the picked File in state so we can re-submit it on confirm
  const pendingFileRef = useRef<File | null>(null);
  const [fileName,      setFileName]      = useState('');
  const [uploading,     setUploading]     = useState(false);
  const [uploadError,   setUploadError]   = useState('');
  const [preview,       setPreview]       = useState<UploadResult | null>(null);
  const [confirming,    setConfirming]    = useState(false);
  const [confirmError,  setConfirmError]  = useState('');
  const [done,          setDone]          = useState(false);
  const [dlError,       setDlError]       = useState('');

  async function handleDownloadTemplate() {
    setDlError('');
    const err = await downloadXlsx(templateUrl, templateFilename);
    if (err) setDlError(err);
  }

  async function handleFile(file: File) {
    pendingFileRef.current = file;
    setFileName(file.name);
    setUploading(true);
    setUploadError('');
    setPreview(null);
    setDone(false);
    setConfirmError('');

    try {
      const form = new FormData();
      form.append('file', file);
      const res  = await fetch(uploadUrlFn(false), {
        method:  'POST',
        headers: authHeader(),
        body:    form,
      });
      const json = (await res.json()) as { success: boolean; data?: UploadResult; error?: string };
      if (!res.ok || !json.success) {
        setUploadError(json.error ?? `Upload failed (HTTP ${res.status})`);
        return;
      }
      setPreview(json.data!);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset value so same file can be re-picked; the File object itself is kept in pendingFileRef
    e.target.value = '';
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  async function handleConfirm() {
    if (!preview) return;
    const file = pendingFileRef.current;
    if (!file) {
      setConfirmError('No file found — please re-select and preview again.');
      return;
    }
    setConfirming(true);
    setConfirmError('');

    try {
      const form = new FormData();
      form.append('file', file);
      const res  = await fetch(uploadUrlFn(true), {
        method:  'POST',
        headers: authHeader(),
        body:    form,
      });
      const json = (await res.json()) as { success: boolean; data?: UploadResult; error?: string };
      if (!res.ok || !json.success) {
        setConfirmError(json.error ?? `Apply failed (HTTP ${res.status})`);
        return;
      }
      setDone(true);
      pendingFileRef.current = null;
      onApplied();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setConfirming(false);
    }
  }

  function handleReset() {
    pendingFileRef.current = null;
    setFileName('');
    setPreview(null);
    setDone(false);
    setUploadError('');
    setConfirmError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-gray-900 text-sm">{title}</h3>

      {/* Template download */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleDownloadTemplate}
          className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
        >
          <Download className="w-4 h-4" />
          Download Template
        </button>
        {dlError && <p className="text-xs text-red-600">{dlError}</p>}
      </div>

      {/* Drop zone */}
      {!done && (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-xl px-6 py-8 text-center cursor-pointer hover:border-[var(--brand-primary)] hover:bg-green-50/20 transition-colors"
        >
          <FileSpreadsheet className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          {fileName
            ? <p className="text-sm font-medium text-gray-700">{fileName}</p>
            : (
              <>
                <p className="text-sm text-gray-400">Drop your filled template here or <span className="text-[var(--brand-primary)] font-medium underline">browse</span></p>
                <p className="text-xs text-gray-300 mt-1">.xlsx files only</p>
              </>
            )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      )}

      {uploading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <div className="w-4 h-4 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
          Uploading and parsing…
        </div>
      )}

      {uploadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          {uploadError}
        </div>
      )}

      {/* Preview */}
      {preview && !done && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Processed', value: preview.processed, color: 'gray'  },
              { label: 'Succeeded', value: preview.succeeded, color: 'green' },
              { label: 'Skipped',   value: preview.skipped,   color: 'gray'  },
              { label: 'Failed',    value: preview.failed,    color: preview.failed > 0 ? 'red' : 'gray' },
            ].map((s) => (
              <div
                key={s.label}
                className={`rounded-xl border px-4 py-3 text-center ${
                  s.color === 'green' ? 'bg-green-50 border-green-200 text-green-700'
                  : s.color === 'red' ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-gray-50 border-gray-200 text-gray-700'
                }`}
              >
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs font-medium mt-0.5 opacity-70">{s.label}</p>
              </div>
            ))}
          </div>

          {preview.errors.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 max-h-40 overflow-y-auto space-y-1">
              <p className="text-xs font-semibold text-amber-800">Errors ({preview.errors.length})</p>
              {preview.errors.slice(0, 20).map((e, i) => (
                <p key={i} className="text-xs text-amber-700">• {e}</p>
              ))}
            </div>
          )}

          {confirmError && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-sm text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              {confirmError}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleConfirm}
              disabled={confirming}
              className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40"
            >
              <CheckCircle className="w-4 h-4" />
              {confirming ? 'Applying…' : 'Confirm & Apply'}
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <RotateCcw className="w-4 h-4" />
              Upload Again
            </button>
          </div>
        </div>
      )}

      {/* Done */}
      {done && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-emerald-800">Applied successfully</p>
            {preview && (
              <p className="text-xs text-emerald-700 mt-0.5">
                {preview.succeeded} succeeded · {preview.skipped} skipped · {preview.failed} failed
              </p>
            )}
          </div>
          <button
            onClick={handleReset}
            className="ml-auto text-xs text-emerald-700 underline hover:no-underline"
          >
            Upload another
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminTdsPage() {
  const session  = useAdminSession();
  const isGifsy  = session.role === 'GIFSY_ADMIN';

  const fyOptions = buildFyOptions();
  const [fy,        setFy]        = useState(fyOptions[0] ?? '2025-26');
  const [activeTab, setActiveTab] = useState<'194R' | '194C'>('194R');

  // ── 194R data ──────────────────────────────────────────────────────────────
  const [r194Loading, setR194Loading] = useState(false);
  const [r194Error,   setR194Error]   = useState('');
  const [r194,        setR194]        = useState<Tds194RResponse | null>(null);
  const [dlR194Err,   setDlR194Err]   = useState('');

  const fetch194R = useCallback(async () => {
    setR194Loading(true);
    setR194Error('');
    try {
      const res  = await fetch(`/api/admin/tds/194r?fy=${encodeURIComponent(fy)}`, { headers: authHeader() });
      const json = (await res.json()) as { success: boolean; data?: Tds194RResponse; error?: string };
      if (!res.ok || !json.success) {
        setR194Error(json.error ?? `Failed to load 194R data (HTTP ${res.status})`);
        return;
      }
      setR194(json.data!);
    } catch (err) {
      setR194Error(err instanceof Error ? err.message : 'Failed to load 194R data');
    } finally {
      setR194Loading(false);
    }
  }, [fy]);

  // ── 194C data ──────────────────────────────────────────────────────────────
  const [r194cLoading, setR194cLoading] = useState(false);
  const [r194cError,   setR194cError]   = useState('');
  const [r194c,        setR194c]        = useState<Tds194CResponse | null>(null);
  const [dlR194cErr,   setDlR194cErr]   = useState('');

  const fetch194C = useCallback(async () => {
    if (!isGifsy) return;
    setR194cLoading(true);
    setR194cError('');
    try {
      const res  = await fetch(`/api/admin/tds/194c?fy=${encodeURIComponent(fy)}`, { headers: authHeader() });
      const json = (await res.json()) as { success: boolean; data?: Tds194CResponse; error?: string };
      if (!res.ok || !json.success) {
        setR194cError(json.error ?? `Failed to load 194C data (HTTP ${res.status})`);
        return;
      }
      setR194c(json.data!);
    } catch (err) {
      setR194cError(err instanceof Error ? err.message : 'Failed to load 194C data');
    } finally {
      setR194cLoading(false);
    }
  }, [fy, isGifsy]);

  // ── Deposit upload section toggle ──────────────────────────────────────────
  const [depositSection, setDepositSection] = useState<'194R' | '194C'>('194R');

  // Load on mount and when FY changes
  useEffect(() => {
    fetch194R();
  }, [fetch194R]);

  useEffect(() => {
    if (isGifsy) fetch194C();
  }, [fetch194C, isGifsy]);

  async function handleDownload194R() {
    setDlR194Err('');
    const err = await downloadXlsx(
      `/api/admin/tds/194r/export?fy=${encodeURIComponent(fy)}`,
      `tds-194r-${fy}.xlsx`,
    );
    if (err) setDlR194Err(err);
  }

  async function handleDownload194C() {
    setDlR194cErr('');
    const err = await downloadXlsx(
      `/api/admin/tds/194c/export?fy=${encodeURIComponent(fy)}`,
      `tds-194c-${fy}.xlsx`,
    );
    if (err) setDlR194cErr(err);
  }

  const tabs = [
    { id: '194R' as const, label: '194R — Perquisites',      show: true },
    { id: '194C' as const, label: '194C — Contractor (Gifsy)',show: isGifsy },
  ].filter((t) => t.show);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
          <Landmark className="w-5 h-5 text-[var(--brand-primary)]" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900">TDS Management</h2>
          <p className="text-sm text-gray-500">Liability overview, deposit tracking, and bulk uploads.</p>
        </div>

        {/* FY selector */}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Financial Year</label>
          <div className="relative">
            <select
              value={fy}
              onChange={(e) => setFy(e.target.value)}
              className="border border-gray-200 rounded-lg pl-3 pr-8 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:border-gray-400 appearance-none"
            >
              {fyOptions.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-2.5 w-4 h-4 text-gray-400" />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── 194R Tab ─────────────────────────────────────────────────────────── */}
      {activeTab === '194R' && (
        <div className="space-y-5">
          {/* Summary cards */}
          {r194 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard label="Total Amount Paid"  paise={r194.summary.baseFyTotalPaise} />
              <SummaryCard label="TDS Liability"      paise={r194.summary.liabilityPaise} />
              <SummaryCard label="Deposited"          paise={r194.summary.depositedPaise} />
              <SummaryCard label="Outstanding"        paise={r194.summary.outstandingPaise} />
            </div>
          )}

          {/* Liability table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h3 className="font-semibold text-gray-900 text-sm">
                  194R Liability — {r194?.fyLabel ?? fy}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">Section 194R: TDS on perquisites / gifts</p>
              </div>
              <div className="flex items-center gap-2">
                {dlR194Err && <p className="text-xs text-red-600">{dlR194Err}</p>}
                <button
                  onClick={handleDownload194R}
                  className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download 194R Excel
                </button>
              </div>
            </div>

            {r194Loading && (
              <div className="flex items-center justify-center py-12" aria-label="Loading">
                <div className="w-6 h-6 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
              </div>
            )}

            {r194Error && (
              <div className="flex items-center gap-2 m-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                <XCircle className="w-4 h-4 shrink-0" /> {r194Error}
              </div>
            )}

            {!r194Loading && !r194Error && r194 && (
              <>
                {r194.rows.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-10">No 194R records for {fy}.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600">Deductee PAN</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">Amount Paid</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">TDS Liability</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">Deposited</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">Outstanding</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {r194.rows.map((row, i) => (
                          <tr key={i} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3 font-mono text-xs text-gray-800">{row.panNumber || '—'}</td>
                            <td className="px-4 py-3 text-right text-gray-700">{formatINR(p(row.baseFyTotalPaise))}</td>
                            <td className="px-4 py-3 text-right text-gray-700">{formatINR(p(row.liabilityPaise))}</td>
                            <td className="px-4 py-3 text-right text-gray-700">{formatINR(p(row.depositedPaise))}</td>
                            <td className="px-4 py-3 text-right">
                              <OutstandingCell paise={row.outstandingPaise} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Off-platform 194R upload */}
          <UploadPanel
            title="Off-Platform 194R Upload"
            templateUrl="/api/admin/tds/off-platform/template"
            templateFilename={`tds-off-platform-template.xlsx`}
            uploadUrlFn={(apply) =>
              `/api/admin/tds/off-platform/upload?apply=${apply}`
            }
            onApplied={fetch194R}
          />

          {/* Deposit upload — 194R */}
          <UploadPanel
            title="Deposit Upload — 194R"
            templateUrl="/api/admin/tds/deposits/template"
            templateFilename={`tds-deposits-194r-template.xlsx`}
            uploadUrlFn={(apply) =>
              `/api/admin/tds/deposits/upload?section=194R&apply=${apply}`
            }
            onApplied={fetch194R}
          />
        </div>
      )}

      {/* ── 194C Tab (GIFSY_ADMIN only) ──────────────────────────────────────── */}
      {activeTab === '194C' && isGifsy && (
        <div className="space-y-5">
          {/* Summary cards */}
          {r194c && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard label="TDS (with threshold)"    paise={r194c.summary.liabilityPaise} />
              <SummaryCard label="TDS (no threshold)"     paise={r194c.summary.liabilityNoThresholdPaise} />
              <SummaryCard label="Deposited"              paise={r194c.summary.depositedPaise} />
              <SummaryCard label="Outstanding"            paise={r194c.summary.outstandingPaise} />
            </div>
          )}

          {/* Liability table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h3 className="font-semibold text-gray-900 text-sm">
                  194C Liability — {r194c?.fyLabel ?? fy}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">Section 194C: TDS on contractor payments</p>
              </div>
              <div className="flex items-center gap-2">
                {dlR194cErr && <p className="text-xs text-red-600">{dlR194cErr}</p>}
                <button
                  onClick={handleDownload194C}
                  className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download 194C Excel
                </button>
              </div>
            </div>

            {r194cLoading && (
              <div className="flex items-center justify-center py-12" aria-label="Loading">
                <div className="w-6 h-6 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
              </div>
            )}

            {r194cError && (
              <div className="flex items-center gap-2 m-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                <XCircle className="w-4 h-4 shrink-0" /> {r194cError}
              </div>
            )}

            {!r194cLoading && !r194cError && r194c && (
              <>
                {r194c.rows.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-10">No 194C records for {fy}.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          <th className="text-left  px-4 py-3 text-xs font-semibold text-gray-600">PAN</th>
                          <th className="text-left  px-4 py-3 text-xs font-semibold text-gray-600">Entity</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">Max Single Pmt</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">TDS (with threshold)</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">TDS (no threshold)</th>
                          <th className="text-center px-4 py-3 text-xs font-semibold text-gray-600">Threshold Met</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">Deposited</th>
                          <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600">Outstanding</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {r194c.rows.map((row, i) => (
                          <tr key={i} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3 font-mono text-xs text-gray-800">{row.panNumber || '—'}</td>
                            <td className="px-4 py-3 text-xs text-gray-700">{row.entityType}</td>
                            <td className="px-4 py-3 text-right text-gray-700">{formatINR(p(row.maxSinglePaise))}</td>
                            <td className="px-4 py-3 text-right text-gray-700">{formatINR(p(row.liabilityPaise))}</td>
                            <td className="px-4 py-3 text-right text-gray-700">{formatINR(p(row.liabilityNoThresholdPaise))}</td>
                            <td className="px-4 py-3 text-center">
                              {row.thresholdMet
                                ? <CheckCircle className="w-4 h-4 text-emerald-500 mx-auto" />
                                : <span className="text-gray-400 text-xs">No</span>}
                            </td>
                            <td className="px-4 py-3 text-right text-gray-700">{formatINR(p(row.depositedPaise))}</td>
                            <td className="px-4 py-3 text-right">
                              <OutstandingCell paise={row.outstandingPaise} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Deposit upload — section toggle */}
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 text-sm">Deposit Upload</h3>
              <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                {(['194R', '194C'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setDepositSection(s)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                      depositSection === s
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <UploadPanel
              key={depositSection} // remount when section changes so state resets
              title={`Deposit Upload — ${depositSection}`}
              templateUrl="/api/admin/tds/deposits/template"
              templateFilename={`tds-deposits-${depositSection.toLowerCase()}-template.xlsx`}
              uploadUrlFn={(apply) =>
                `/api/admin/tds/deposits/upload?section=${depositSection}&apply=${apply}`
              }
              onApplied={depositSection === '194R' ? fetch194R : fetch194C}
            />
          </div>
        </div>
      )}

      {/* Guard: 194C tab shown but user is CLIENT_ADMIN (shouldn't happen but belt-and-suspenders) */}
      {activeTab === '194C' && !isGifsy && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
          <p className="text-sm text-amber-800">
            Section 194C data is only available to Gifsy Platform Admins.
          </p>
        </div>
      )}
    </div>
  );
}
