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
import { getGifsySettings } from '@/lib/gifsy-settings';
import { jsonToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';
import {
  generateEmployeePointsTemplate,
  type TemplateEmployee,
} from '@/lib/employee-points-template';
import {
  parseEmployeePointsUpload,
  toEmployeeUploadRows,
  type EmployeeParseResult,
} from '@/lib/employee-points-parser';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function downloadBuffer(buf: ArrayBuffer, fileName: string) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  downloadBlob(blob, fileName);
}

/** Mirrors the backend assertWithinUploadWindow: a PRIOR-month period is closed once today's
 *  day has passed the cutoff; the current (or a future) month period is always open. */
function isPeriodWindowOpen(period: string, cutoffDay: number): boolean {
  const current = getCurrentMonth();
  if (period >= current) return true;
  return new Date().getDate() <= cutoffDay;
}

type Step = 'template' | 'upload' | 'preview' | 'done';

interface SkippedRow {
  employeeCode: string;
  fieldName: string;
  points: number;
  reason: string;
}

interface SavedBatch {
  batchCode: string;
  pointsCreditedRows: number;
  pointsCreditedTotal: number;
  skipped: SkippedRow[];
}

/** Human-readable explanation for a server-side employee skip reason. */
function skipReasonLabel(reason: string): string {
  switch (reason) {
    case 'EMPLOYEE_NOT_FOUND':
      return 'Employee Code not found in this tenant (check the roster)';
    case 'EMPLOYEE_INACTIVE':
      return 'Employee is deactivated — reactivate them before crediting';
    case 'UNSUPPORTED_AWARD_TYPE':
      return 'Not a points row — the employee rail credits points only';
    default:
      return reason;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function EmployeePointsUploadPage() {
  const settings = getGifsySettings();
  const safetyCapPoints = settings.creditsPayouts?.safetyCapPoints ?? 50000;
  const cutoffDay = settings.creditsPayouts?.monthCutoffDay ?? 28;

  const [step, setStep] = useState<Step>('template');
  const [period, setPeriod] = useState(getCurrentMonth());
  const [employees, setEmployees] = useState<TemplateEmployee[]>([]);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [fileName, setFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<EmployeeParseResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedBatch, setSavedBatch] = useState<SavedBatch | null>(null);
  const [confirmError, setConfirmError] = useState('');
  // Per-parse idempotency key (FE audit #2/#3): sent on create so a retried confirm returns the SAME
  // draft (no orphan PENDING batch) and a fresh parse supersedes the stale draft — using the audited
  // sourceKey machinery in createEmployeeBatch. Regenerated on each file parse; cleared on reset.
  const [sourceKey, setSourceKey] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Hard in-flight guard (FE audit #3): a double-click can fire two create→confirm pairs before the
  // `confirming` state disables the button on re-render. The backend is safe (F2 guard), but this
  // avoids the racing UI state + the extra orphan draft.
  const confirmInFlight = useRef(false);

  const windowOpen = isPeriodWindowOpen(period, cutoffDay);

  useEffect(() => {
    // Best-effort roster for template pre-fill + pre-flight unknown-code validation. If this fails
    // (e.g. the caller lacks sales_org:manage_hierarchy), we proceed WITHOUT client-side code
    // validation and let the server's EMPLOYEE_NOT_FOUND skip be authoritative.
    fetch('/api/admin/sales-users/options')
      .then((r) => r.json())
      .then((res) => {
        if (res?.success && Array.isArray(res.data?.managers)) {
          setEmployees(
            res.data.managers
              // Guard against a roster row without a code (would become a blank template row / an
              // empty entry in knownCodes).
              .filter((m: { employeeCode?: string }) => !!m.employeeCode?.trim())
              .map((m: { employeeCode: string; name: string }) => ({
                employeeCode: m.employeeCode,
                name: m.name,
              })),
          );
          setRosterLoaded(true);
        }
      })
      .catch(() => {});
  }, []);

  // ─── Step 1: Download template ──────────────────────────────────────────────

  function handleDownloadTemplate() {
    const buf = generateEmployeePointsTemplate(employees, period);
    downloadBuffer(buf, `employee-points-${period}-template.xlsx`);
  }

  // ─── Step 2: Upload file ────────────────────────────────────────────────────

  async function processFile(file: File) {
    setFileName(file.name);
    setParsing(true);
    setParseResult(null);

    const buf = await file.arrayBuffer();
    const knownCodes = rosterLoaded ? new Set(employees.map((e) => e.employeeCode)) : null;
    const result = parseEmployeePointsUpload(buf, { knownCodes, safetyCapPoints });

    // Fresh idempotency key for THIS parsed upload: a retried confirm reuses it (no orphan draft);
    // a new file parse mints a new one (superseding any stale draft for the period server-side).
    setSourceKey(`manual:${period}:${crypto.randomUUID()}`);
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
  }, [employees, rosterLoaded, safetyCapPoints]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Step 3: Confirm ────────────────────────────────────────────────────────

  async function handleConfirm() {
    if (!parseResult?.canProceed) return;
    if (confirmInFlight.current) return; // hard guard against a double-click (FE audit #3)
    confirmInFlight.current = true;
    setConfirming(true);
    setConfirmError('');

    const headers = { 'Content-Type': 'application/json' };

    try {
      const okRows = parseResult.rows.filter((r) => r.status === 'OK');
      const uniqueEmployees = new Set(okRows.map((r) => r.employeeCode));

      const saveRes = await fetch('/api/admin/credits/employee-batches', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          period,
          totalEmployees: uniqueEmployees.size,
          totalPoints: parseResult.summary.totalPoints,
          rows: toEmployeeUploadRows(parseResult.rows),
          sourceKey,
        }),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.success) {
        setConfirmError(saveJson.error ?? 'Failed to save batch');
        setConfirming(false);
        return;
      }

      const batchId = saveJson.data.id;

      const confirmRes = await fetch(`/api/admin/credits/employee-batches/${batchId}/confirm`, {
        method: 'POST',
      });
      const confirmJson = await confirmRes.json();
      if (!confirmJson.success) {
        setConfirmError(confirmJson.error ?? 'Failed to confirm batch');
        setConfirming(false);
        return;
      }

      // The confirm response is the source of truth for what was ACTUALLY credited.
      const cd = confirmJson.data ?? {};
      setSavedBatch({
        batchCode: saveJson.data.batchCode,
        pointsCreditedRows: Number(cd.pointsCredited ?? 0),
        pointsCreditedTotal: Number(cd.pointsCreditedTotal ?? 0),
        skipped: Array.isArray(cd.skipped) ? (cd.skipped as SkippedRow[]) : [],
      });
      setSaved(true);
      setStep('done');
    } catch (e) {
      setConfirmError(String(e));
    } finally {
      setConfirming(false);
      confirmInFlight.current = false; // release on every path (success, early-return, throw)
    }
  }

  // ─── Download report ─────────────────────────────────────────────────────────

  function handleDownloadReport() {
    if (!parseResult) return;
    import('xlsx').then((XLSX) => {
      const rows = parseResult.rows.map((r) => ({
        'Employee Code': r.employeeCode,
        'Employee Name': r.employeeName,
        'Points': r.points || '',
        'Status': r.status,
        'Narration': r.narration,
        'Errors': r.errors.length > 0 ? r.errors.join('; ') : (r.skipReason ?? ''),
      }));
      const ws = jsonToSheetSafe(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Upload Report');

      if (savedBatch && savedBatch.skipped.length > 0) {
        const skippedRows = savedBatch.skipped.map((s) => ({
          'Employee Code': s.employeeCode,
          'Points': s.points,
          'Reason': skipReasonLabel(s.reason),
        }));
        const sws = jsonToSheetSafe(skippedRows);
        XLSX.utils.book_append_sheet(wb, sws, 'Skipped (Not Credited)');
      }

      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      downloadBuffer(buf, `employee-points-${period}-report.xlsx`);
    });
  }

  function handleReset() {
    setStep('template');
    setFileName('');
    setParseResult(null);
    setSaved(false);
    setSavedBatch(null);
    setConfirmError('');
    setSourceKey('');
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
          <h2 className="text-lg font-bold text-gray-900">Upload Employee Points</h2>
          <p className="text-xs text-gray-500">Bulk-credit points to employee wallets, one row per employee.</p>
        </div>
      </div>

      {/* Period picker */}
      <div className="bg-white rounded-xl border border-gray-200 px-5 py-3 flex items-center gap-3 flex-wrap">
        <label htmlFor="er-points-period" className="text-sm font-medium text-gray-700">Period</label>
        <input
          id="er-points-period"
          type="month"
          value={period}
          max={getCurrentMonth()}
          onChange={(e) => { if (e.target.value) setPeriod(e.target.value); }}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
        />
        <span className="text-xs text-gray-500">{monthLabel(period)}</span>
      </div>

      {!windowOpen && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">Upload window closed</p>
            <p className="text-xs text-amber-700 mt-0.5">
              The cutoff for <strong>{monthLabel(period)}</strong> was day&nbsp;
              <strong>{cutoffDay}</strong> of this month. Pick the current month to credit now.
            </p>
          </div>
        </div>
      )}

      {/* Stepper */}
      <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-5 py-3">
        {stepLabel('template', 1, 'Download Template')}
        {stepLabel('upload', 2, 'Upload File')}
        {stepLabel('preview', 3, 'Preview & Confirm')}
      </div>

      {/* Step 1: Download template */}
      {(step === 'template' || step === 'upload') && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Step 1 — Download Template</h3>
          <p className="text-xs text-gray-500">
            {rosterLoaded
              ? `Pre-filled with ${employees.length} active employee${employees.length !== 1 ? 's' : ''}. Enter points (and an optional narration) per row.`
              : 'Enter one row per employee: Employee Code, Points, and an optional narration.'}
          </p>
          <button
            onClick={handleDownloadTemplate}
            disabled={!windowOpen}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            Download Template{rosterLoaded ? ` (${employees.length} employees)` : ''}
          </button>
          {step === 'template' && (
            <button
              onClick={() => setStep('upload')}
              className="block text-xs text-[var(--brand-primary)] hover:underline"
            >
              Skip — I already have a filled template →
            </button>
          )}
        </div>
      )}

      {/* Step 2: Upload */}
      {(step === 'upload' || step === 'template') && (
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
          {parsing && <p className="text-xs text-gray-500 text-center animate-pulse">Parsing file…</p>}
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
              { label: 'OK Rows', value: parseResult.summary.ok, color: 'text-emerald-600' },
              { label: 'Skipped', value: parseResult.summary.skipped, color: 'text-gray-500' },
              { label: 'Errors', value: parseResult.summary.errors, color: 'text-red-600' },
              { label: 'Total Pts', value: parseResult.summary.totalPoints.toLocaleString('en-IN'), color: 'text-blue-600' },
            ].map((c) => (
              <div key={c.label} className="bg-white rounded-xl border border-gray-200 p-3 text-center">
                <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
              </div>
            ))}
          </div>

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
                        Row {r.rowNum} · {r.employeeCode}{r.employeeName ? ` · ${r.employeeName}` : ''}
                      </p>
                      {r.errors.map((e, j) => (
                        <p key={j} className="text-xs text-red-600 mt-0.5">• {e}</p>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {parseResult.summary.skipped > 0 && (
            <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
              <div className="px-4 py-3 bg-amber-50 border-b border-amber-100">
                <p className="text-xs font-semibold text-amber-800 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {parseResult.summary.skipped} row{parseResult.summary.skipped !== 1 ? 's' : ''} skipped — nothing credited
                </p>
              </div>
              <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
                {parseResult.rows
                  .filter((r) => r.status === 'SKIP')
                  .slice(0, 10)
                  .map((r, i) => (
                    <div key={i} className="px-4 py-2.5">
                      <p className="text-xs font-medium text-gray-800">
                        Row {r.rowNum} · {r.employeeCode}{r.employeeName ? ` · ${r.employeeName}` : ''}
                      </p>
                      {r.skipReason && <p className="text-xs text-amber-700 mt-0.5">• {r.skipReason}</p>}
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {parseResult.canProceed && !saved && (
              <button
                onClick={handleConfirm}
                disabled={!windowOpen || confirming}
                className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CheckCircle className="w-4 h-4" />
                {confirming ? 'Crediting…' : 'Confirm & Credit'}
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
        <div className={`bg-white rounded-xl border p-6 text-center space-y-3 ${savedBatch.pointsCreditedRows > 0 && savedBatch.skipped.length === 0 ? 'border-emerald-200' : 'border-amber-200'}`}>
          {/* Honest states (FE audit #5): green ONLY when something was credited and nothing skipped;
              otherwise amber. Never claim "credited successfully" when zero rows were credited. */}
          {savedBatch.pointsCreditedRows > 0 && savedBatch.skipped.length === 0
            ? <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto" />
            : <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto" />}
          <div>
            <p className="font-semibold text-gray-900">
              {savedBatch.pointsCreditedRows === 0
                ? 'No points credited'
                : savedBatch.skipped.length > 0
                  ? 'Points credited — some rows were skipped'
                  : 'Points credited successfully'}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Batch: <code className="font-mono bg-gray-100 px-1 rounded">{savedBatch.batchCode}</code>
            </p>
            <p className="text-xs text-gray-500">
              {savedBatch.pointsCreditedRows > 0
                ? `${savedBatch.pointsCreditedRows} employee${savedBatch.pointsCreditedRows !== 1 ? 's' : ''} credited · ${savedBatch.pointsCreditedTotal.toLocaleString('en-IN')} pts`
                : 'No points credited'}
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
                      {s.employeeCode} · {s.points.toLocaleString('en-IN')} pts
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
