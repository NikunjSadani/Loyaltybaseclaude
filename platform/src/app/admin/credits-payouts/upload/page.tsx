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
import { getActiveFields }       from '@/lib/credits-payouts-fields';
import { generateCreditTemplate, getEligibleOutlets } from '@/lib/credits-payouts-template';
import { parseCreditUpload }     from '@/lib/credits-payouts-parser';
import { saveBatch, confirmBatch, newBatchId, isUploadWindowOpen } from '@/lib/credits-payouts-store';
import { createPayoutEntriesFromBatch }         from '@/lib/credits-payouts-payout-store';
import { notifyGifsyNewBatch, notifyBatchOutlets } from '@/lib/credits-payouts-notify';
import { getGifsySettings }      from '@/lib/gifsy-settings';
import type { CreditField, CreditParseResult, CreditBatch } from '@/types';

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

type Step = 'template' | 'upload' | 'preview' | 'done';

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

  /** true while we are still within the monthly upload window */
  const uploadWindowOpen = isUploadWindowOpen(cp.monthCutoffDay);

  const [step,        setStep]        = useState<Step>('template');
  const [period]                      = useState(getPreviousMonth());
  const [fields,      setFields]      = useState<CreditField[]>([]);
  const [fileName,    setFileName]    = useState('');
  const [dragging,    setDragging]    = useState(false);
  const [parsing,     setParsing]     = useState(false);
  const [parseResult, setParseResult] = useState<CreditParseResult | null>(null);
  const [saved,       setSaved]       = useState(false);
  const [savedBatch,  setSavedBatch]  = useState<CreditBatch | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setFields(getActiveFields());
  }, []);

  // ─── Step 1: Download template ─────────────────────────────────────────────

  function handleDownloadTemplate() {
    const outlets = getEligibleOutlets();
    const buf     = generateCreditTemplate(fields, period, outlets);
    downloadBuffer(buf, `credits-payouts-${period}-template.xlsx`);
  }

  // ─── Step 2: Upload file ───────────────────────────────────────────────────

  async function processFile(file: File) {
    setFileName(file.name);
    setParsing(true);
    setParseResult(null);

    const buf    = await file.arrayBuffer();
    const outlets = getEligibleOutlets();
    const result  = parseCreditUpload(buf, {
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
  }, [fields, period, cp]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Step 3: Confirm ───────────────────────────────────────────────────────

  function handleConfirm() {
    if (!parseResult?.canProceed) return;

    const batchId = newBatchId(period);
    const batch: CreditBatch = {
      id:             batchId,
      period,
      status:         cp.fourEyesEnabled ? 'PENDING_CONFIRM' : 'CONFIRMED',
      uploadedBy:     session.name,
      uploadedAt:     new Date().toISOString(),
      confirmedAt:    cp.fourEyesEnabled ? undefined : new Date().toISOString(),
      confirmedBy:    cp.fourEyesEnabled ? undefined : session.name,
      totalOutlets:   [...new Set(parseResult.rows.filter((r) => r.status === 'OK').map((r) => r.outletId))].length,
      totalPoints:    parseResult.summary.totalPoints,
      totalPayoutInr: parseResult.summary.totalPayoutInr,
      rows:           parseResult.rows,
    };

    saveBatch(batch);

    // If 4-eyes not enabled, auto-confirm
    if (!cp.fourEyesEnabled) {
      confirmBatch(batchId, session.name);
    }

    // Phase 2: create pending payout entries for all PAYOUT-type rows
    createPayoutEntriesFromBatch(batch);

    // Phase 2: notify Gifsy team of new batch
    const outlets    = getEligibleOutlets();
    const outletMap  = new Map(outlets.map((o) => [o.id, o]));
    const phoneMap:  Record<string, string>  = {};
    const nameMap:   Record<string, string>  = {};
    const pointsMap: Record<string, number>  = {};
    for (const row of parseResult.rows.filter((r) => r.status === 'OK' && r.awardType === 'POINTS')) {
      const phone = outletMap.get(row.outletId)?.phone;
      if (phone) phoneMap[row.outletId] = phone;
      nameMap[row.outletId]   = row.outletName;
      pointsMap[row.outletId] = (pointsMap[row.outletId] ?? 0) + row.amount;
    }

    // Fire-and-forget notifications (no await — don't block UI)
    void notifyBatchOutlets({ phoneMap, pointsMap, period, outletNames: nameMap });
    void notifyGifsyNewBatch({
      tenantName:      'Client',
      period,
      batchId,
      totalOutlets:    batch.totalOutlets,
      totalPoints:     batch.totalPoints,
      totalPayoutInr:  batch.totalPayoutInr,
      uploadedBy:      session.name,
      recipientEmails: cp.notifyEmails ?? [],
    });

    setSavedBatch(batch);
    setSaved(true);
    setStep('done');
  }

  // ─── Download report ────────────────────────────────────────────────────────

  function handleDownloadReport() {
    if (!parseResult) return;
    // Build a simple report: OK rows + error rows
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
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Upload Report');
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
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ─── Render ────────────────────────────────────────────────────────────────

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

      {/* Cutoff banner — shown when the upload window for this period has closed */}
      {!uploadWindowOpen && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800">Upload window closed</p>
            <p className="text-xs text-amber-700 mt-0.5">
              The cutoff for <strong>{monthLabel(period)}</strong> was day&nbsp;
              <strong>{cp.monthCutoffDay}</strong> of this month.
              New uploads for this period are no longer accepted.
              Contact your Gifsy admin if you need a manual override.
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
            The template is pre-populated with {fields.length} active field{fields.length !== 1 ? 's' : ''} for {monthLabel(period)}.
            Fill in the values and upload below.
          </p>
          {fields.length === 0 ? (
            <div className="bg-amber-50 rounded-lg p-4 text-xs text-amber-700">
              No active fields configured. Please ask your Gifsy admin to set up fields before uploading.
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
          {/* Header error */}
          {parseResult.headerError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800">File format error</p>
                <p className="text-xs text-red-700 mt-1">{parseResult.headerError}</p>
              </div>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'OK Rows',      value: parseResult.summary.ok,             color: 'text-emerald-600' },
              { label: 'Skipped',      value: parseResult.summary.skipped,        color: 'text-gray-500' },
              { label: 'Errors',       value: parseResult.summary.errors,         color: 'text-red-600' },
              { label: 'Total Pts',    value: parseResult.summary.totalPoints.toLocaleString('en-IN'), color: 'text-blue-600' },
            ].map((c) => (
              <div key={c.label} className="bg-white rounded-xl border border-gray-200 p-3 text-center">
                <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
              </div>
            ))}
          </div>

          {parseResult.summary.totalPayoutInr > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <p className="text-sm text-emerald-800">
                Total Payout: <strong>₹{parseResult.summary.totalPayoutInr.toLocaleString('en-IN')}</strong>
              </p>
            </div>
          )}

          {/* Error rows (first 10) */}
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

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            {parseResult.canProceed && !saved && (
              <button
                onClick={handleConfirm}
                disabled={!uploadWindowOpen}
                title={!uploadWindowOpen ? `Upload window closed (cutoff: day ${cp.monthCutoffDay})` : undefined}
                className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <CheckCircle className="w-4 h-4" />
                {cp.fourEyesEnabled ? 'Submit for Approval' : 'Confirm & Credit'}
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
          <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto" />
          <div>
            <p className="font-semibold text-gray-900">
              {cp.fourEyesEnabled ? 'Submitted for approval' : 'Credits confirmed successfully'}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Batch ID: <code className="font-mono bg-gray-100 px-1 rounded">{savedBatch.id}</code>
            </p>
            <p className="text-xs text-gray-500">
              {savedBatch.totalOutlets} outlet{savedBatch.totalOutlets !== 1 ? 's' : ''}
              {savedBatch.totalPoints > 0 && ` · ${savedBatch.totalPoints.toLocaleString('en-IN')} pts`}
              {savedBatch.totalPayoutInr > 0 && ` · ₹${savedBatch.totalPayoutInr.toLocaleString('en-IN')} payout`}
            </p>
          </div>
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
