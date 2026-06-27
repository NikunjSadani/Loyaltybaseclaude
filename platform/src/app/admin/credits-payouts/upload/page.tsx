'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Download,
  Upload,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileSpreadsheet,
  ChevronRight,
  RotateCcw,
  Coins,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { generateCreditTemplate } from '@/lib/credits-payouts-template';
import { parseCreditUpload }      from '@/lib/credits-payouts-parser';
import { getGifsySettings }       from '@/lib/gifsy-settings';
import { jsonToSheetSafe }        from '@/lib/xlsx-safe';
import type { CreditField, CreditParseResult } from '@/types';
import type { TemplateOutlet } from '@/lib/credits-payouts-template';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPreviousMonth(): string {
  const now = new Date();
  const y   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const m   = now.getMonth() === 0 ? 12 : now.getMonth();
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function downloadBuffer(buf: ArrayBuffer, fileName: string) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function isUploadWindowOpen(cutoffDay: number): boolean {
  return new Date().getDate() <= cutoffDay;
}

type Step = 'template' | 'upload' | 'preview' | 'done';

interface SkippedRow {
  outletId:  string;
  fieldName: string;
  points:    number;
  reason:    string;
}

interface SavedBatch {
  id:               string;
  batchCode:        string;
  totalOutlets:     number;
  totalPoints:      number;
  /** totalPayoutPaise from the API — integer paise. */
  totalPayoutPaise: number;
  // ── confirm-time actuals (what the server actually did) ──
  /** Number of POINTS rows actually credited. */
  pointsCreditedRows:  number;
  /** Sum of points actually credited (may be < uploaded total if rows were skipped). */
  pointsCreditedTotal: number;
  payoutEntriesCreated: number;
  /** Rows the server could NOT credit, with a reason. */
  skipped: SkippedRow[];
}

/** Human-readable explanation for a server-side skip reason. */
function skipReasonLabel(reason: string): string {
  switch (reason) {
    case 'OUTLET_NOT_FOUND':
      return 'Outlet ID not found in this tenant';
    case 'OUTLET_NOT_LINKED_TO_PARTNER':
      return 'Outlet is not linked to a partner account (onboard/KYC the outlet first)';
    default:
      return reason;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreditsPayoutsUploadPage() {
  const session  = useAdminSession();
  const settings = getGifsySettings();
  const cp       = settings.creditsPayouts ?? {
    monthCutoffDay:  28,
    safetyCapPoints: 50000,
    safetyCapInr:    100000,
    fourEyesEnabled: false,
    notifyEmails:    [],
  };

  const uploadWindowOpen = isUploadWindowOpen(cp.monthCutoffDay);

  const [step,        setStep]        = useState<Step>('template');
  const [period]                      = useState(getPreviousMonth());
  const [fields,      setFields]      = useState<CreditField[]>([]);
  const [outlets,     setOutlets]     = useState<TemplateOutlet[]>([]);
  const [fileName,    setFileName]    = useState('');
  const [dragging,    setDragging]    = useState(false);
  const [parsing,     setParsing]     = useState(false);
  const [parseResult, setParseResult] = useState<CreditParseResult | null>(null);
  const [confirming,  setConfirming]  = useState(false);
  const [saved,       setSaved]       = useState(false);
  const [savedBatch,  setSavedBatch]  = useState<SavedBatch | null>(null);
  const [confirmError, setConfirmError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';

  useEffect(() => {
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/admin/credits/fields?active=true', { headers }).then((r) => r.json()),
      fetch('/api/admin/credits/eligible-outlets',   { headers }).then((r) => r.json()),
    ]).then(([fieldsRes, outletsRes]) => {
      if (fieldsRes.success)  setFields(fieldsRes.data);
      if (outletsRes.success) setOutlets(outletsRes.data);
    }).catch(() => {});
  }, [token]);

  // ─── Step 1: Download template ──────────────────────────────────────────────

  function handleDownloadTemplate() {
    const buf = generateCreditTemplate(fields, period, outlets);
    downloadBuffer(buf, `credits-payouts-${period}-template.xlsx`);
  }

  // ─── Step 2: Upload file ────────────────────────────────────────────────────

  async function processFile(file: File) {
    setFileName(file.name);
    setParsing(true);
    setParseResult(null);

    const buf    = await file.arrayBuffer();
    const result = parseCreditUpload(buf, {
      fields,
      outlets,
      month:           period,
      safetyCapPoints: cp.safetyCapPoints,
      safetyCapInr:    cp.safetyCapInr,
    });

    setParseResult(result);
    setParsing(false);
    setStep('preview');
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [fields, period, outlets, cp]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Step 3: Confirm ────────────────────────────────────────────────────────

  async function handleConfirm() {
    if (!parseResult?.canProceed) return;
    setConfirming(true);
    setConfirmError('');

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    try {
      // Save batch
      const okRows = parseResult.rows.filter((r) => r.status === 'OK');
      const uniqueOutlets = new Set(okRows.map((r) => r.outletId));

      const saveRes = await fetch('/api/admin/credits/batches', {
        method: 'POST', headers,
        body: JSON.stringify({
          period,
          totalOutlets:    uniqueOutlets.size,
          totalPoints:     parseResult.summary.totalPoints,
          // totalPayoutPaise: already in paise from the parser
          totalPayoutPaise: parseResult.summary.totalPayoutPaise,
          rows:             parseResult.rows,
        }),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.success) {
        setConfirmError(saveJson.error ?? 'Failed to save batch');
        setConfirming(false);
        return;
      }

      const batchId = saveJson.data.id;

      // Confirm (creates payout entries + notifies Gifsy)
      const confirmRes = await fetch(`/api/admin/credits/batches/${batchId}/confirm`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const confirmJson = await confirmRes.json();
      if (!confirmJson.success) {
        setConfirmError(confirmJson.error ?? 'Failed to confirm batch');
        setConfirming(false);
        return;
      }

      // The confirm response is the source of truth for what was ACTUALLY credited.
      // (Previously this was ignored, so silently-skipped points showed as "success".)
      const cd = confirmJson.data ?? {};
      setSavedBatch({
        id:               saveJson.data.id,
        batchCode:        saveJson.data.batchCode,
        totalOutlets:     saveJson.data.totalOutlets,
        totalPoints:      Number(saveJson.data.totalPoints),
        // BigInt is serialised to number via toJSON patch in api/src/main.ts
        totalPayoutPaise: Number(saveJson.data.totalPayoutPaise),
        pointsCreditedRows:   Number(cd.pointsCredited ?? 0),
        pointsCreditedTotal:  Number(cd.pointsCreditedTotal ?? 0),
        payoutEntriesCreated: Number(cd.payoutEntriesCreated ?? 0),
        skipped:              Array.isArray(cd.skipped) ? (cd.skipped as SkippedRow[]) : [],
      });
      setSaved(true);
      setStep('done');
    } catch (e) {
      setConfirmError(String(e));
    } finally {
      setConfirming(false);
    }
  }

  // ─── Download report ─────────────────────────────────────────────────────────

  function handleDownloadReport() {
    if (!parseResult) return;
    import('xlsx').then((XLSX) => {
      const rows = parseResult.rows.map((r) => ({
        'Outlet ID':   r.outletId,
        'Outlet Name': r.outletName,
        'Field':       r.fieldName,
        'Amount':      r.amount || '',
        'Award Type':  r.awardType,
        'Status':      r.status,
        'Narration':   r.narration,
        'Errors':      r.errors.join('; '),
      }));
      const ws = jsonToSheetSafe(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Upload Report');

      // After a confirm, append the server-side skipped rows (what was NOT credited
      // and why) so the report actually explains the skips — not just the client parse.
      if (savedBatch && savedBatch.skipped.length > 0) {
        const skippedRows = savedBatch.skipped.map((s) => ({
          'Outlet ID': s.outletId,
          'Field':     s.fieldName,
          'Points':    s.points,
          'Reason':    skipReasonLabel(s.reason),
        }));
        const sws = jsonToSheetSafe(skippedRows);
        XLSX.utils.book_append_sheet(wb, sws, 'Skipped (Not Credited)');
      }

      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      downloadBuffer(buf, `credits-payouts-${period}-report.xlsx`);
    });
  }

  function handleReset() {
    setStep('template');
    setFileName('');
    setParseResult(null);
    setSaved(false);
    setSavedBatch(null);
    setConfirmError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  const stepLabel = (s: Step, n: number, title: string) => (
    <div className={`flex items-center gap-2 ${step === s ? 'text-[var(--brand-primary)]' : step > s || saved ? 'text-emerald-600' : 'text-gray-400'}`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2
        ${step === s ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]'
                    : 'border-current bg-transparent'}`}>
        {n}
      </div>
      <span className="text-sm font-medium hidden sm:block">{title}</span>
      {n < 3 && <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />}
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Coins className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Upload Credits & Payouts</h2>
          <p className="text-xs text-gray-500">Period: <strong>{monthLabel(period)}</strong></p>
        </div>
      </div>

      {!uploadWindowOpen && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">Upload window closed</p>
            <p className="text-xs text-amber-700 mt-0.5">
              The cutoff for <strong>{monthLabel(period)}</strong> was day&nbsp;
              <strong>{cp.monthCutoffDay}</strong> of this month.
            </p>
          </div>
        </div>
      )}

      {/* Stepper */}
      <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-5 py-3">
        {stepLabel('template', 1, 'Download Template')}
        {stepLabel('upload',   2, 'Upload File')}
        {stepLabel('preview',  3, 'Preview & Confirm')}
      </div>

      {/* Step 1: Download template */}
      {(step === 'template' || step === 'upload') && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Step 1 — Download Template</h3>
          <p className="text-xs text-gray-500">
            Template includes {fields.length} active field{fields.length !== 1 ? 's' : ''} for {monthLabel(period)}.
            Outlets: {outlets.length} eligible.
          </p>
          {fields.length === 0 ? (
            <div className="bg-amber-50 rounded-lg p-4 text-xs text-amber-700">
              No active fields configured. Ask your Gifsy admin to set up fields first.
            </div>
          ) : (
            <button
              onClick={handleDownloadTemplate}
              disabled={!uploadWindowOpen}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              Download Template ({fields.filter((f) => f.isActive).length} fields)
            </button>
          )}
          {step === 'template' && fields.length > 0 && (
            <button
              onClick={() => setStep('upload')}
              className="text-xs text-[var(--brand-primary)] hover:underline"
            >
              Skip — I already have a filled template →
            </button>
          )}
        </div>
      )}

      {/* Step 2: Upload */}
      {(step === 'upload' || step === 'template') && fields.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Step 2 — Upload Filled Template</h3>
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer
              ${dragging ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5' : 'border-gray-300 hover:border-gray-400'}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <FileSpreadsheet className="w-8 h-8 text-gray-400 mx-auto mb-3" />
            <p className="text-sm text-gray-600 font-medium">
              {fileName ? fileName : 'Drop your filled template here or click to browse'}
            </p>
            <p className="text-xs text-gray-400 mt-1">.xlsx files only</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
          {parsing && (
            <p className="text-xs text-gray-500 text-center animate-pulse">Parsing file…</p>
          )}
        </div>
      )}

      {/* Step 3: Preview & Confirm */}
      {step === 'preview' && parseResult && (
        <div className="space-y-4">
          {parseResult.headerError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800">File format error</p>
                <p className="text-xs text-red-700 mt-1">{parseResult.headerError}</p>
              </div>
            </div>
          )}

          {confirmError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{confirmError}</p>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'OK Rows',   value: parseResult.summary.ok,      color: 'text-emerald-600' },
              { label: 'Skipped',   value: parseResult.summary.skipped,  color: 'text-gray-500' },
              { label: 'Errors',    value: parseResult.summary.errors,   color: 'text-red-600' },
              { label: 'Total Pts', value: parseResult.summary.totalPoints.toLocaleString('en-IN'), color: 'text-blue-600' },
            ].map((c) => (
              <div key={c.label} className="bg-white rounded-xl border border-gray-200 p-3 text-center">
                <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
              </div>
            ))}
          </div>

          {parseResult.summary.totalPayoutPaise > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <p className="text-sm text-emerald-800">
                {/* totalPayoutPaise is integer paise; divide by 100 for human display */}
                Total Payout: <strong>₹{(parseResult.summary.totalPayoutPaise / 100).toLocaleString('en-IN')}</strong>
              </p>
            </div>
          )}

          {parseResult.hasErrors && (
            <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
              <div className="px-4 py-3 bg-red-50 border-b border-red-100">
                <p className="text-xs font-semibold text-red-800 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {parseResult.summary.errors} error{parseResult.summary.errors !== 1 ? 's' : ''} — fix and re-upload
                </p>
              </div>
              <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
                {parseResult.rows
                  .filter((r) => r.status === 'ERROR')
                  .slice(0, 10)
                  .map((r, i) => (
                    <div key={i} className="px-4 py-2.5">
                      <p className="text-xs font-medium text-gray-800">
                        Row {r.rowNum} · {r.outletId} · {r.fieldName}
                      </p>
                      {r.errors.map((e, j) => (
                        <p key={j} className="text-xs text-red-600 mt-0.5">• {e}</p>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {parseResult.canProceed && !saved && (
              <button
                onClick={handleConfirm}
                disabled={!uploadWindowOpen || confirming}
                className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CheckCircle className="w-4 h-4" />
                {confirming ? 'Saving…' : 'Confirm & Credit'}
              </button>
            )}
            <button
              onClick={handleDownloadReport}
              className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Download className="w-4 h-4" />
              Download Report
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
      {step === 'done' && savedBatch && (
        <div className="bg-white rounded-xl border border-emerald-200 p-6 text-center space-y-3">
          {savedBatch.skipped.length > 0
            ? <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto" />
            : <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto" />}
          <div>
            <p className="font-semibold text-gray-900">
              {savedBatch.skipped.length > 0
                ? 'Credits confirmed — some rows were skipped'
                : 'Credits confirmed successfully'}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Batch: <code className="font-mono bg-gray-100 px-1 rounded">{savedBatch.batchCode}</code>
            </p>
            {/* Show what was ACTUALLY credited (from the confirm response), not just the uploaded totals. */}
            <p className="text-xs text-gray-500">
              {savedBatch.pointsCreditedRows > 0
                ? `${savedBatch.pointsCreditedRows} outlet${savedBatch.pointsCreditedRows !== 1 ? 's' : ''} credited · ${savedBatch.pointsCreditedTotal.toLocaleString('en-IN')} pts`
                : 'No points credited'}
              {savedBatch.payoutEntriesCreated > 0 && ` · ${savedBatch.payoutEntriesCreated} payout entr${savedBatch.payoutEntriesCreated !== 1 ? 'ies' : 'y'}`}
              {savedBatch.totalPayoutPaise > 0 && ` · ₹${(savedBatch.totalPayoutPaise / 100).toLocaleString('en-IN')} payout`}
            </p>
          </div>

          {savedBatch.skipped.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl text-left overflow-hidden">
              <div className="px-4 py-2.5 border-b border-amber-100">
                <p className="text-xs font-semibold text-amber-800 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {savedBatch.skipped.length} row{savedBatch.skipped.length !== 1 ? 's' : ''} NOT credited
                </p>
              </div>
              <div className="divide-y divide-amber-100 max-h-52 overflow-y-auto">
                {savedBatch.skipped.slice(0, 12).map((s, i) => (
                  <div key={i} className="px-4 py-2">
                    <p className="text-xs font-medium text-gray-800">
                      {s.outletId} · {s.fieldName} · {s.points.toLocaleString('en-IN')} pts
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">{skipReasonLabel(s.reason)}</p>
                  </div>
                ))}
                {savedBatch.skipped.length > 12 && (
                  <p className="px-4 py-2 text-xs text-amber-700">
                    …and {savedBatch.skipped.length - 12} more — see the downloaded report.
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="flex gap-3 justify-center pt-2">
            <button
              onClick={handleDownloadReport}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Download className="w-4 h-4" />
              Download Report
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Upload className="w-4 h-4" />
              New Upload
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
