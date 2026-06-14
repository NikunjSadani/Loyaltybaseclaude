'use client';

/**
 * Gifsy Payout Download, UTR Upload & Reversal Approval
 *
 * GIFSY_ADMIN only.
 *
 * Workflow:
 *  1. Select period + group type (STANDARD or SEPARATE field)
 *  2. Click "Generate Payout File" → POST /api/admin/credits/payout-downloads
 *     returns binary xlsx + creates CreditPayoutDownload record
 *  3. Gifsy fills UTR numbers in the downloaded file
 *  4. Upload filled file → preview UTR rows → confirm to apply
 *  5. Pending reversal requests shown for approval/rejection
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
import { useAdminSession } from '@/lib/admin-session';
import type { UtrParseResult } from '@/types';

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

const STATUS_COLOR: Record<string, string> = {
  OPEN:          'bg-blue-100 text-blue-800',
  PAID:          'bg-emerald-100 text-emerald-800',
  PARTIALLY_PAID:'bg-amber-100 text-amber-800',
  FAILED:        'bg-red-100 text-red-800',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreditField {
  id:              string;
  name:            string;
  isActive:        boolean;
  isSeparatePayout: boolean;
}

interface PayoutDownload {
  id:            string;
  downloadCode:  string;
  period:        string;
  groupType:     string;
  fieldId?:      string;
  fieldName?:    string;
  status:        string;
  downloadedAt:  string;
  totalAmountInr: string | number;
  _count?: { entries: number };
}

interface Reversal {
  id:             string;
  outletId:       string;
  outletName:     string;
  fieldName:      string;
  period:         string;
  awardType:      string;
  originalAmount: string | number;
  requestedAmount: string | number;
  approvedAmount?: string | number;
  requestedAt:    string;
  status:         string;
  remarks?:       string;
}

// ─── Gate wrapper ─────────────────────────────────────────────────────────────

export default function PayoutDownloadPage() {
  const session = useAdminSession();

  if (session.role !== 'GIFSY_ADMIN') {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-500">
        <Lock className="w-8 h-8 text-gray-300" />
        <p className="text-sm font-medium">Gifsy Admin Access Only</p>
        <p className="text-xs text-gray-400">This page is restricted to Gifsy administrators.</p>
      </div>
    );
  }

  return <PayoutPageInner />;
}

// ─── Inner component ──────────────────────────────────────────────────────────

function PayoutPageInner() {
  const session = useAdminSession();
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [period,    setPeriod]    = useState(getPreviousMonth());
  const [groupType, setGroupType] = useState<'STANDARD' | 'SEPARATE'>('STANDARD');
  const [fields,    setFields]    = useState<CreditField[]>([]);
  const [fieldId,   setFieldId]   = useState('');
  const [downloads, setDownloads] = useState<PayoutDownload[]>([]);
  const [reversals, setReversals] = useState<Reversal[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genError,   setGenError]   = useState('');

  // UTR upload state
  const [utrDownloadId,  setUtrDownloadId]  = useState('');
  const [utrFile,        setUtrFile]        = useState<File | null>(null);
  const [utrParsing,     setUtrParsing]     = useState(false);
  const [utrResult,      setUtrResult]      = useState<UtrParseResult | null>(null);
  const [utrApplying,    setUtrApplying]    = useState(false);
  const [utrApplied,     setUtrApplied]     = useState(false);
  const [utrMsg,         setUtrMsg]         = useState('');
  const [expandedUtr,    setExpandedUtr]    = useState(false);

  // Reversal state
  const [revAction,  setRevAction]  = useState<{ id: string; action: 'approve' | 'reject' } | null>(null);
  const [revAmount,  setRevAmount]  = useState('');
  const [revRemarks, setRevRemarks] = useState('');
  const [revMsg,     setRevMsg]     = useState('');
  const [revLoading, setRevLoading] = useState(false);

  const utrFileRef = useRef<HTMLInputElement>(null);

  // ─── Load data ───────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    const [fieldsRes, downloadsRes, reversalsRes] = await Promise.all([
      fetch('/api/admin/credits/fields?active=true', { headers: authHeaders }).then((r) => r.json()),
      fetch(`/api/admin/credits/payout-downloads?period=${period}`, { headers: authHeaders }).then((r) => r.json()),
      fetch('/api/admin/credits/reversals?status=PENDING_GIFSY', { headers: authHeaders }).then((r) => r.json()),
    ]);
    if (fieldsRes.success)    setFields(fieldsRes.data);
    if (downloadsRes.success) setDownloads(downloadsRes.data);
    if (reversalsRes.success) setReversals(reversalsRes.data);
  }, [period, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadAll(); }, [loadAll]);

  const separateFields = fields.filter((f) => f.isSeparatePayout);

  // ─── Generate payout file ─────────────────────────────────────────────────

  async function handleGeneratePayoutFile() {
    setGenerating(true);
    setGenError('');
    try {
      const body: Record<string, unknown> = { period, groupType };
      if (groupType === 'SEPARATE' && fieldId) {
        const field = fields.find((f) => f.id === fieldId);
        body.fieldId   = fieldId;
        body.fieldName = field?.name;
      }

      const res = await fetch('/api/admin/credits/payout-downloads', {
        method:  'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: 'Request failed' }));
        setGenError(json.error ?? `HTTP ${res.status}`);
        return;
      }

      // Binary response — trigger download
      const blob     = await res.blob();
      const url      = URL.createObjectURL(blob);
      const a        = document.createElement('a');
      a.href         = url;
      a.download     = `payout-${period}-${groupType.toLowerCase()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);

      loadAll();
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  // ─── UTR Upload ───────────────────────────────────────────────────────────

  async function handleUtrFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !utrDownloadId) return;
    setUtrFile(file);
    setUtrParsing(true);
    setUtrResult(null);
    setUtrApplied(false);
    setUtrMsg('');

    const fd = new FormData();
    fd.append('file', file);

    const res = await fetch(
      `/api/admin/credits/payout-downloads/${utrDownloadId}/utr`,
      { method: 'POST', headers: authHeaders, body: fd },
    );
    const json = await res.json();
    setUtrParsing(false);

    if (!json.success) {
      setUtrMsg(json.error ?? 'Failed to parse UTR file');
    } else {
      setUtrResult(json.data.parseResult);
    }
  }

  async function handleApplyUtr() {
    if (!utrResult?.canProceed || !utrDownloadId || !utrFile) return;
    setUtrApplying(true);

    const fd = new FormData();
    fd.append('file', utrFile);
    fd.append('apply', 'true');

    const res  = await fetch(
      `/api/admin/credits/payout-downloads/${utrDownloadId}/utr`,
      { method: 'POST', headers: authHeaders, body: fd },
    );
    const json = await res.json();
    setUtrApplying(false);

    if (!json.success) {
      setUtrMsg(json.error ?? 'Failed to apply UTR results');
    } else {
      setUtrApplied(true);
      setUtrMsg(`Applied: ${json.data.paidCount} paid, ${json.data.failedCount} failed, ${json.data.skippedCount} skipped.`);
      loadAll();
    }
  }

  function resetUtrForm() {
    setUtrDownloadId('');
    setUtrFile(null);
    setUtrResult(null);
    setUtrApplied(false);
    setUtrMsg('');
    setExpandedUtr(false);
    if (utrFileRef.current) utrFileRef.current.value = '';
  }

  // ─── Reversals ────────────────────────────────────────────────────────────

  async function handleReversalAction() {
    if (!revAction) return;
    setRevLoading(true);
    setRevMsg('');

    const body: Record<string, unknown> = { action: revAction.action };
    if (revAction.action === 'approve' && revAmount) body.approvedAmount = Number(revAmount);
    if (revRemarks) body.remarks = revRemarks;

    const res  = await fetch(`/api/admin/credits/reversals/${revAction.id}`, {
      method:  'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const json = await res.json();
    setRevLoading(false);

    if (!json.success) {
      setRevMsg(json.error ?? 'Failed to process reversal');
    } else {
      setRevAction(null);
      setRevAmount('');
      setRevRemarks('');
      loadAll();
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Coins className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Payout Management</h2>
          <p className="text-xs text-gray-500">Generate payout files, upload UTR results, approve reversals.</p>
        </div>
      </div>

      {/* ── Section 1: Generate Payout File ─────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
          <Download className="w-4 h-4 text-gray-400" />
          Generate Payout File
        </h3>

        <div className="flex flex-wrap gap-4 items-end">
          {/* Period */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Period</label>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
            />
          </div>

          {/* Group type */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Group Type</label>
            <div className="flex gap-2">
              {(['STANDARD', 'SEPARATE'] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => { setGroupType(g); setFieldId(''); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                    ${groupType === g
                      ? 'bg-[var(--brand-primary)] text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          {/* Separate field picker */}
          {groupType === 'SEPARATE' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Field</label>
              <select
                value={fieldId}
                onChange={(e) => setFieldId(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
              >
                <option value="">Select field…</option>
                {separateFields.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={handleGeneratePayoutFile}
            disabled={generating || (groupType === 'SEPARATE' && !fieldId)}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            {generating ? 'Generating…' : 'Generate & Download'}
          </button>
        </div>

        {genError && (
          <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded-xl px-4 py-3">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {genError}
          </div>
        )}

        {/* Download history */}
        {downloads.length > 0 && (
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
              <p className="text-xs font-semibold text-gray-600">Download History — {monthLabel(period)}</p>
            </div>
            <div className="divide-y divide-gray-50">
              {downloads.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-4 py-3 text-xs">
                  <div>
                    <p className="font-mono font-medium text-gray-800">{d.downloadCode}</p>
                    <p className="text-gray-500">{d.groupType}{d.fieldName ? ` · ${d.fieldName}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-gray-600">₹{Number(d.totalAmountInr).toLocaleString('en-IN')}</span>
                    <span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[d.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {d.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: UTR Upload ────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
          <Upload className="w-4 h-4 text-gray-400" />
          Upload UTR Results
        </h3>

        {/* Select download */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">Select Payout Download</label>
          <select
            value={utrDownloadId}
            onChange={(e) => { setUtrDownloadId(e.target.value); resetUtrForm(); setUtrDownloadId(e.target.value); }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 w-full max-w-sm"
          >
            <option value="">Select a download batch…</option>
            {downloads
              .filter((d) => d.status !== 'PAID')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.downloadCode} · {d.groupType}{d.fieldName ? ` / ${d.fieldName}` : ''} · {d.status}
                </option>
              ))}
          </select>
        </div>

        {utrDownloadId && (
          <>
            <div
              className="border-2 border-dashed border-gray-300 hover:border-gray-400 rounded-xl p-6 text-center cursor-pointer transition-colors"
              onClick={() => utrFileRef.current?.click()}
            >
              <FileSpreadsheet className="w-7 h-7 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-600">
                {utrFile ? utrFile.name : 'Click to upload UTR result file (.xlsx)'}
              </p>
              <input
                ref={utrFileRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={handleUtrFileChange}
              />
            </div>

            {utrParsing && (
              <p className="text-xs text-gray-500 animate-pulse">Parsing file…</p>
            )}

            {utrMsg && !utrResult && (
              <div className={`text-xs px-4 py-3 rounded-xl ${utrApplied ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {utrMsg}
              </div>
            )}

            {utrResult && !utrApplied && (
              <div className="space-y-3">
                {utrResult.headerError && (
                  <div className="bg-red-50 text-red-700 text-xs px-4 py-3 rounded-xl">
                    {utrResult.headerError}
                  </div>
                )}

                {/* Summary */}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'OK',      value: utrResult.summary.ok,          color: 'text-emerald-600' },
                    { label: 'Errors',  value: utrResult.summary.errors,       color: 'text-red-600' },
                    { label: 'Skipped', value: utrResult.summary.skipped,      color: 'text-gray-500' },
                    { label: 'Paid',    value: utrResult.summary.paidCount,    color: 'text-blue-600' },
                  ].map((c) => (
                    <div key={c.label} className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className={`text-lg font-bold ${c.color}`}>{c.value}</p>
                      <p className="text-xs text-gray-500">{c.label}</p>
                    </div>
                  ))}
                </div>

                {/* Row details toggle */}
                {utrResult.rows.length > 0 && (
                  <button
                    onClick={() => setExpandedUtr((v) => !v)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800"
                  >
                    {expandedUtr ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {expandedUtr ? 'Hide' : 'Show'} row details
                  </button>
                )}

                {expandedUtr && (
                  <div className="max-h-52 overflow-y-auto border border-gray-100 rounded-xl divide-y divide-gray-50">
                    {utrResult.rows.map((r, i) => (
                      <div key={i} className={`flex items-center justify-between px-4 py-2.5 text-xs
                        ${r.status === 'ERROR' ? 'bg-red-50' : r.status === 'SKIP' ? 'bg-gray-50' : ''}`}
                      >
                        <div>
                          <span className="font-mono text-gray-700">{r.outletId}</span>
                          {r.utr && <span className="ml-2 text-gray-500">UTR: {r.utr}</span>}
                          {r.errors.length > 0 && (
                            <p className="text-red-600 mt-0.5">{r.errors.join(' · ')}</p>
                          )}
                        </div>
                        <span className={`px-2 py-0.5 rounded-full font-medium
                          ${r.status === 'OK' ? 'bg-emerald-100 text-emerald-700'
                           : r.status === 'ERROR' ? 'bg-red-100 text-red-700'
                           : 'bg-gray-100 text-gray-500'}`}>
                          {r.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Apply / Reset */}
                <div className="flex gap-3">
                  {utrResult.canProceed && (
                    <button
                      onClick={handleApplyUtr}
                      disabled={utrApplying}
                      className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40"
                    >
                      <BadgeCheck className="w-4 h-4" />
                      {utrApplying ? 'Applying…' : 'Apply UTR Results'}
                    </button>
                  )}
                  <button
                    onClick={resetUtrForm}
                    className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Reset
                  </button>
                </div>
              </div>
            )}

            {utrApplied && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-600" />
                <div>
                  <p className="text-sm font-semibold text-emerald-800">UTR results applied</p>
                  <p className="text-xs text-emerald-700 mt-0.5">{utrMsg}</p>
                </div>
                <button onClick={resetUtrForm} className="ml-auto text-xs text-emerald-700 hover:underline">
                  Upload another
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Section 3: Pending Reversals ────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-gray-400" />
          Pending Reversal Requests
          {reversals.length > 0 && (
            <span className="ml-auto bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium">
              {reversals.length}
            </span>
          )}
        </h3>

        {reversals.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">No pending reversal requests.</p>
        ) : (
          <div className="space-y-3">
            {reversals.map((rev) => (
              <div key={rev.id} className="border border-amber-200 bg-amber-50 rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap gap-4 text-xs">
                  <div>
                    <p className="text-gray-500">Outlet</p>
                    <p className="font-medium text-gray-800">{rev.outletName}</p>
                    <p className="text-gray-400 font-mono">{rev.outletId}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Field</p>
                    <p className="font-medium text-gray-800">{rev.fieldName}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Period</p>
                    <p className="font-medium text-gray-800">{monthLabel(rev.period)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Award</p>
                    <p className="font-medium text-gray-800">{rev.awardType}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Requested Amount</p>
                    <p className="font-medium text-gray-800">
                      {rev.awardType === 'PAYOUT'
                        ? `₹${Number(rev.requestedAmount).toLocaleString('en-IN')}`
                        : `${Number(rev.requestedAmount).toLocaleString('en-IN')} pts`}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Requested At</p>
                    <p className="font-medium text-gray-800">{new Date(rev.requestedAt).toLocaleDateString('en-IN')}</p>
                  </div>
                </div>

                {revAction?.id === rev.id ? (
                  <div className="bg-white rounded-xl p-3 space-y-3 border border-gray-200">
                    <p className="text-xs font-semibold text-gray-800 capitalize">{revAction.action} Reversal</p>
                    {revAction.action === 'approve' && (
                      <div className="space-y-1">
                        <label className="text-xs text-gray-600">Approved Amount (leave blank for full amount)</label>
                        <input
                          type="number"
                          value={revAmount}
                          onChange={(e) => setRevAmount(e.target.value)}
                          placeholder={String(Number(rev.requestedAmount))}
                          max={Number(rev.requestedAmount)}
                          min={1}
                          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                        />
                      </div>
                    )}
                    <div className="space-y-1">
                      <label className="text-xs text-gray-600">Remarks (optional)</label>
                      <input
                        type="text"
                        value={revRemarks}
                        onChange={(e) => setRevRemarks(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                      />
                    </div>
                    {revMsg && <p className="text-xs text-red-600">{revMsg}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={handleReversalAction}
                        disabled={revLoading}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50
                          ${revAction.action === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}
                      >
                        {revLoading ? 'Processing…' : revAction.action === 'approve' ? 'Confirm Approve' : 'Confirm Reject'}
                      </button>
                      <button
                        onClick={() => { setRevAction(null); setRevMsg(''); }}
                        className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setRevAction({ id: rev.id, action: 'approve' }); setRevAmount(''); setRevRemarks(''); setRevMsg(''); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700"
                    >
                      <ThumbsUp className="w-3.5 h-3.5" />
                      Approve
                    </button>
                    <button
                      onClick={() => { setRevAction({ id: rev.id, action: 'reject' }); setRevAmount(''); setRevRemarks(''); setRevMsg(''); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-100 text-red-700 text-xs font-medium rounded-lg hover:bg-red-200"
                    >
                      <ThumbsDown className="w-3.5 h-3.5" />
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
