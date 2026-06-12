'use client';

/**
 * Gifsy Payout Download, UTR Upload & Reversal Approval
 *
 * GIFSY_ADMIN only.
 *
 * Workflow:
 *  1. Select period + group type (STANDARD or SEPARATE field)
 *  2. Click "Generate Payout File" → downloads xlsx + creates PayoutBatch
 *  3. Gifsy fills UTR numbers in the downloaded file
 *  4. Upload the filled file → preview UTR rows → apply
 *     ↳ On apply, outlets are notified via WhatsApp (notifyPayoutConfirmed)
 *  5. Pending reversal requests (from client admin) shown for approval/rejection
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Download,
  Upload,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileSpreadsheet,
  Coins,
  Lock,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  BadgeCheck,
  RotateCcw,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import { useAdminSession }         from '@/lib/admin-session';
import { getActiveFields }         from '@/lib/credits-payouts-fields';
import {
  createPayoutBatch,
  generatePayoutFileBuffer,
  PAYOUT_FILE_HEADERS,
} from '@/lib/credits-payouts-payout-download';
import {
  getAllPayoutBatches,
  getBankDetail,
} from '@/lib/credits-payouts-payout-store';
import { parseUtrUpload, applyUtrResult } from '@/lib/credits-payouts-utr';
import {
  approveReversal,
  rejectReversal,
  getAllReversals,
} from '@/lib/credits-payouts-reversal';
import { notifyPayoutConfirmed }   from '@/lib/credits-payouts-notify';
import type {
  CreditField,
  PayoutBatch,
  PayoutGroupType,
  UtrParseResult,
  ReversalRequest,
} from '@/types';

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

const STATUS_COLOR: Record<string, string> = {
  OPEN:          'bg-blue-100 text-blue-800',
  PAID:          'bg-emerald-100 text-emerald-800',
  PARTIALLY_PAID:'bg-amber-100 text-amber-800',
  FAILED:        'bg-red-100 text-red-800',
};

// ─── Gate wrapper ──────────────────────────────────────────────────────────────

export default function PayoutDownloadPage() {
  const session = useAdminSession();

  if (session.role !== 'GIFSY_ADMIN') {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-500">
        <Lock className="w-10 h-10" />
        <p className="text-sm font-medium">This section is restricted to Gifsy administrators.</p>
      </div>
    );
  }

  return <PayoutDownloadContent />;
}

// ─── Main content ──────────────────────────────────────────────────────────────

function PayoutDownloadContent() {
  const session = useAdminSession();

  // ── Generate form state ────────────────────────────────────────────────────
  const [period,      setPeriod]     = useState(getPreviousMonth());
  const [fields,      setFields]     = useState<CreditField[]>([]);
  const [groupType,   setGroupType]  = useState<PayoutGroupType>('STANDARD');
  const [sepField,    setSepField]   = useState<string>('');
  const [generating,  setGenerating] = useState(false);
  const [openWarning, setOpenWarning] = useState<string | null>(null);

  // ── Batch list state ───────────────────────────────────────────────────────
  const [batches,  setBatches]  = useState<PayoutBatch[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  // ── UTR upload state ───────────────────────────────────────────────────────
  const [utrBatchId,  setUtrBatchId]  = useState<string | null>(null);
  const [utrFileName, setUtrFileName] = useState('');
  const [utrDragging, setUtrDragging] = useState(false);
  const [utrParsing,  setUtrParsing]  = useState(false);
  const [utrResult,   setUtrResult]   = useState<UtrParseResult | null>(null);
  const [utrApplied,  setUtrApplied]  = useState(false);

  // ── Reversal approval state ────────────────────────────────────────────────
  const [reversals,      setReversals]      = useState<ReversalRequest[]>([]);
  const [approvalId,     setApprovalId]     = useState<string | null>(null);
  const [approvalAmt,    setApprovalAmt]    = useState('');
  const [rejectionId,    setRejectionId]    = useState<string | null>(null);
  const [rejectionNote,  setRejectionNote]  = useState('');
  const [revMsg,         setRevMsg]         = useState<{ id: string; type: 'ok' | 'err'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadAll() {
    setFields(getActiveFields());
    setBatches(getAllPayoutBatches().sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt)));
    setReversals(getAllReversals().filter((r) => r.status === 'PENDING_GIFSY'));
  }

  useEffect(() => { loadAll(); }, []);

  const separateFields = fields.filter((f) => f.isSeparatePayout && f.isActive);

  // ── Generate payout file ───────────────────────────────────────────────────

  function handleGenerate() {
    setGenerating(true);
    setOpenWarning(null);
    try {
      const selectedField = fields.find((f) => f.id === sepField);
      const result = createPayoutBatch({
        period,
        groupType,
        fieldId:      groupType === 'SEPARATE' ? sepField   : undefined,
        fieldName:    groupType === 'SEPARATE' ? selectedField?.name : undefined,
        downloadedBy: session.name,
        fields,
      });
      if (result.openWarning) setOpenWarning(result.openWarning);
      if (result.batch.rows.length === 0) {
        alert('No pending payout entries found for this period and group. Upload credits first.');
        setGenerating(false);
        return;
      }
      downloadBuffer(result.buffer, `payout-${period}-${result.batch.id}.xlsx`);
      loadAll();
    } catch (err) {
      alert(String(err));
    }
    setGenerating(false);
  }

  function handleRedownload(batch: PayoutBatch) {
    downloadBuffer(generatePayoutFileBuffer(batch), `payout-${batch.period}-${batch.id}.xlsx`);
  }

  // ── UTR upload ─────────────────────────────────────────────────────────────

  function startUtrUpload(batchId: string) {
    setUtrBatchId(batchId);
    setUtrFileName('');
    setUtrResult(null);
    setUtrApplied(false);
  }

  async function processUtrFile(file: File) {
    setUtrFileName(file.name);
    setUtrParsing(true);
    setUtrResult(null);
    const buf    = await file.arrayBuffer();
    const result = parseUtrUpload(buf, { batchId: utrBatchId! });
    setUtrResult(result);
    setUtrParsing(false);
  }

  const handleUtrDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setUtrDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processUtrFile(file);
  }, [utrBatchId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleUtrApply() {
    if (!utrResult || !utrBatchId) return;

    // Snapshot batch rows BEFORE apply (need phone numbers for notifications)
    const batch = getAllPayoutBatches().find((b) => b.id === utrBatchId);

    applyUtrResult(utrResult, utrBatchId);
    setUtrApplied(true);
    loadAll();

    // Gap 1 fix: notify each successfully paid outlet via WhatsApp
    if (batch) {
      for (const row of utrResult.rows) {
        if (row.status === 'OK' && row.success && row.utr) {
          const batchRow = batch.rows.find((r) => r.outletId === row.outletId);
          if (batchRow?.phone) {
            void notifyPayoutConfirmed({
              phone:      batchRow.phone,
              outletName: batchRow.outletName,
              amountInr:  batchRow.amount,
              utr:        row.utr,
              period:     batch.period,
            });
          }
        }
      }
    }
  }

  // ── Reversal approval ──────────────────────────────────────────────────────

  function openApproval(rev: ReversalRequest) {
    setApprovalId(rev.id);
    setApprovalAmt(String(rev.requestedAmount));
    setRejectionId(null);
    setRevMsg(null);
  }

  function openRejection(rev: ReversalRequest) {
    setRejectionId(rev.id);
    setRejectionNote('');
    setApprovalId(null);
    setRevMsg(null);
  }

  function submitApproval() {
    if (!approvalId) return;
    try {
      const updated = approveReversal(approvalId, session.name, Number(approvalAmt));
      setRevMsg({ id: approvalId, type: 'ok', text: `Reversal ${updated.status === 'PARTIAL' ? 'partially' : 'fully'} approved — ₹${updated.approvedAmount} for ${updated.outletName}.` });
      setApprovalId(null);
      loadAll();
    } catch (err) {
      setRevMsg({ id: approvalId, type: 'err', text: String(err) });
    }
  }

  function submitRejection() {
    if (!rejectionId) return;
    try {
      const updated = rejectReversal(rejectionId, session.name, rejectionNote || 'Rejected by Gifsy');
      setRevMsg({ id: rejectionId, type: 'ok', text: `Reversal rejected for ${updated.outletName}.` });
      setRejectionId(null);
      loadAll();
    } catch (err) {
      setRevMsg({ id: rejectionId, type: 'err', text: String(err) });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Coins className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Payout Download</h2>
          <p className="text-xs text-gray-500">Download payout files, upload UTRs, and approve reversal requests</p>
        </div>
      </div>

      {/* ── Generate section ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm">Generate Payout File</h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Period */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Period</label>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              max={getPreviousMonth()}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--brand-primary)] focus:outline-none"
            />
          </div>

          {/* Gap 3 fix: clean STANDARD / SEPARATE toggle — not one-per-field */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Payout Group</label>
            <select
              value={groupType}
              onChange={(e) => {
                setGroupType(e.target.value as PayoutGroupType);
                setSepField(''); // reset when switching
              }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--brand-primary)] focus:outline-none"
            >
              <option value="STANDARD">STANDARD — all non-separate fields</option>
              {separateFields.length > 0 && (
                <option value="SEPARATE">SEPARATE — single field</option>
              )}
            </select>
          </div>

          {/* Field selector — only visible when SEPARATE chosen */}
          {groupType === 'SEPARATE' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Select Field</label>
              <select
                value={sepField}
                onChange={(e) => setSepField(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--brand-primary)] focus:outline-none"
              >
                <option value="">— select a field —</option>
                {separateFields.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {openWarning && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-2 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            {openWarning}
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={generating || (groupType === 'SEPARATE' && !sepField)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <Download className="w-4 h-4" />
          {generating ? 'Generating…' : 'Generate Payout File'}
        </button>
      </div>

      {/* ── Payout batch list ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 text-sm">Payout Batches</h3>
          <button onClick={loadAll} className="p-1.5 rounded-lg hover:bg-gray-100" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5 text-gray-500" />
          </button>
        </div>

        {batches.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            No payout batches yet. Generate one above.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {batches.map((batch) => (
              <div key={batch.id}>
                <div className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono text-gray-700">{batch.id}</code>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[batch.status] ?? 'bg-gray-100 text-gray-700'}`}>
                        {batch.status}
                      </span>
                      {batch.groupType === 'SEPARATE' && (
                        <span className="px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-800">
                          {batch.fieldName ?? 'Separate'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {monthLabel(batch.period)} · ₹{batch.totalAmount.toLocaleString('en-IN')} · {batch.rows.length} outlets
                      · Downloaded {new Date(batch.downloadedAt).toLocaleDateString('en-IN')}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleRedownload(batch)}
                      title="Re-download payout file"
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>

                    {(batch.status === 'OPEN' || batch.status === 'PARTIALLY_PAID') && (
                      <button
                        onClick={() => startUtrUpload(batch.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white text-xs font-medium hover:opacity-90"
                      >
                        <Upload className="w-3 h-3" />
                        Upload UTR
                      </button>
                    )}

                    <button
                      onClick={() => setExpanded(expanded === batch.id ? null : batch.id)}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
                    >
                      {expanded === batch.id
                        ? <ChevronUp className="w-3.5 h-3.5" />
                        : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Expanded rows */}
                {expanded === batch.id && (
                  <div className="border-t border-gray-100 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          {['Outlet ID', 'Outlet Name', 'Amount', 'Bank', 'KYC', 'UTR', 'Status'].map((h) => (
                            <th key={h} className="px-4 py-2 text-left font-medium text-gray-600 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {batch.rows.map((row) => (
                          <tr key={row.outletId} className={row.isDeactivated ? 'bg-amber-50' : ''}>
                            <td className="px-4 py-2 font-mono text-gray-700">{row.outletId}</td>
                            <td className="px-4 py-2 text-gray-700">{row.outletName}</td>
                            <td className="px-4 py-2 text-right text-gray-700">₹{row.amount.toLocaleString('en-IN')}</td>
                            <td className="px-4 py-2 text-gray-500">{row.bankName}</td>
                            <td className="px-4 py-2">
                              <span className={`px-1.5 py-0.5 rounded text-xs ${row.kycStatus === 'VERIFIED' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                                {row.kycStatus}
                              </span>
                            </td>
                            <td className="px-4 py-2 font-mono text-gray-600">{row.utr ?? '—'}</td>
                            <td className="px-4 py-2">
                              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                                row.utrStatus === 'PAID'   ? 'bg-emerald-100 text-emerald-700'
                                : row.utrStatus === 'FAILED' ? 'bg-red-100 text-red-700'
                                : 'bg-gray-100 text-gray-600'
                              }`}>
                                {row.utrStatus}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── UTR upload panel ──────────────────────────────────────────────── */}
      {utrBatchId && (
        <div className="bg-white rounded-xl border border-blue-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 text-sm">
              Upload UTR File —{' '}
              <code className="font-mono text-[var(--brand-primary)]">{utrBatchId}</code>
            </h3>
            <button
              onClick={() => { setUtrBatchId(null); setUtrResult(null); }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              ✕ Close
            </button>
          </div>

          {!utrApplied ? (
            <>
              <div
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
                  ${utrDragging ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5' : 'border-gray-300 hover:border-gray-400'}`}
                onDragOver={(e) => { e.preventDefault(); setUtrDragging(true); }}
                onDragLeave={() => setUtrDragging(false)}
                onDrop={handleUtrDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileSpreadsheet className="w-8 h-8 text-gray-400 mx-auto mb-3" />
                <p className="text-sm text-gray-600 font-medium">
                  {utrFileName || 'Drop filled payout file here or click to browse'}
                </p>
                <p className="text-xs text-gray-400 mt-1">.xlsx only — use the file downloaded from this page</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) processUtrFile(f); }}
                />
              </div>

              {utrParsing && (
                <p className="text-xs text-gray-500 text-center animate-pulse">Parsing file…</p>
              )}

              {utrResult && (
                <div className="space-y-3">
                  {utrResult.headerError ? (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2 text-xs text-red-700">
                      <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      {utrResult.headerError}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: 'OK',      value: utrResult.summary.ok,         color: 'text-emerald-600' },
                          { label: 'Errors',  value: utrResult.summary.errors,      color: 'text-red-600' },
                          { label: 'Skipped', value: utrResult.summary.skipped,     color: 'text-gray-500' },
                          { label: 'Paid',    value: utrResult.summary.paidCount,   color: 'text-blue-600' },
                        ].map((c) => (
                          <div key={c.label} className="bg-gray-50 rounded-lg p-2.5 text-center">
                            <p className={`text-lg font-bold ${c.color}`}>{c.value}</p>
                            <p className="text-xs text-gray-500">{c.label}</p>
                          </div>
                        ))}
                      </div>

                      {utrResult.hasErrors && (
                        <div className="bg-red-50 border border-red-200 rounded-lg overflow-hidden">
                          <div className="px-3 py-2 bg-red-100 text-xs font-semibold text-red-800">
                            <AlertTriangle className="w-3 h-3 inline mr-1" />
                            {utrResult.summary.errors} error(s) — fix and re-upload
                          </div>
                          <div className="max-h-48 overflow-y-auto divide-y divide-red-100">
                            {utrResult.rows.filter((r) => r.status === 'ERROR').map((r, i) => (
                              <div key={i} className="px-3 py-2">
                                <p className="text-xs font-medium text-gray-800">Row {r.rowNum} · {r.outletId}</p>
                                {r.errors.map((e, j) => <p key={j} className="text-xs text-red-600">• {e}</p>)}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {utrResult.canProceed && (
                        <button
                          onClick={handleUtrApply}
                          className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:opacity-90"
                        >
                          <BadgeCheck className="w-4 h-4" />
                          Apply UTR Results ({utrResult.summary.ok} rows)
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 text-center space-y-2">
              <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto" />
              <p className="font-semibold text-gray-900 text-sm">UTR Results Applied</p>
              <p className="text-xs text-gray-500">
                Paid: {utrResult?.summary.paidCount} · Failed: {utrResult?.summary.failedCount} · Skipped: {utrResult?.summary.skipped}
              </p>
              <p className="text-xs text-gray-400">Outlets notified via WhatsApp.</p>
              <button
                onClick={() => { setUtrBatchId(null); setUtrResult(null); setUtrApplied(false); }}
                className="text-xs text-[var(--brand-primary)] hover:underline"
              >
                Close
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Gap 2 fix: Pending reversal requests ─────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-amber-600" />
            Pending Reversal Requests
            {reversals.length > 0 && (
              <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800 font-bold">
                {reversals.length}
              </span>
            )}
          </h3>
          <button onClick={loadAll} className="p-1.5 rounded-lg hover:bg-gray-100" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5 text-gray-500" />
          </button>
        </div>

        {reversals.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-gray-400">
            No pending reversal requests.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {reversals.map((rev) => (
              <div key={rev.id} className="px-5 py-4 space-y-3">
                {/* Request summary */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {rev.outletName}
                      <span className="ml-2 text-xs font-normal text-gray-500">{rev.outletId}</span>
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {rev.fieldName} · {rev.awardType} · {monthLabel(rev.period)}
                    </p>
                    <p className="text-xs text-gray-500">
                      Requested by <strong>{rev.requestedBy}</strong> on {new Date(rev.requestedAt).toLocaleDateString('en-IN')}
                      {rev.remarks && <> · "{rev.remarks}"</>}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-semibold text-gray-900">
                      {rev.awardType === 'PAYOUT'
                        ? `₹${rev.requestedAmount.toLocaleString('en-IN')}`
                        : `${rev.requestedAmount.toLocaleString('en-IN')} pts`}
                    </p>
                    <p className="text-xs text-gray-400">
                      of {rev.awardType === 'PAYOUT'
                        ? `₹${rev.originalAmount.toLocaleString('en-IN')}`
                        : `${rev.originalAmount.toLocaleString('en-IN')} pts`} original
                    </p>
                  </div>
                </div>

                {/* Per-request message */}
                {revMsg?.id === rev.id && (
                  <div className={`rounded-lg p-2.5 text-xs ${revMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                    {revMsg.text}
                  </div>
                )}

                {/* Approve inline form */}
                {approvalId === rev.id && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2">
                    <p className="text-xs font-medium text-emerald-800">Approve — enter amount to approve</p>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={1}
                        max={rev.requestedAmount}
                        value={approvalAmt}
                        onChange={(e) => setApprovalAmt(e.target.value)}
                        className="flex-1 border border-emerald-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      />
                      <button
                        onClick={submitApproval}
                        className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:opacity-90"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setApprovalId(null)}
                        className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Reject inline form */}
                {rejectionId === rev.id && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
                    <p className="text-xs font-medium text-red-800">Reject — enter reason</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={rejectionNote}
                        onChange={(e) => setRejectionNote(e.target.value)}
                        placeholder="Reason for rejection"
                        className="flex-1 border border-red-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
                      />
                      <button
                        onClick={submitRejection}
                        className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setRejectionId(null)}
                        className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Approve / Reject buttons (hidden when inline forms are open) */}
                {approvalId !== rev.id && rejectionId !== rev.id && !revMsg?.id && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => openApproval(rev)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:opacity-90"
                    >
                      <ThumbsUp className="w-3 h-3" />
                      Approve
                    </button>
                    <button
                      onClick={() => openRejection(rev)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:opacity-90"
                    >
                      <ThumbsDown className="w-3 h-3" />
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
