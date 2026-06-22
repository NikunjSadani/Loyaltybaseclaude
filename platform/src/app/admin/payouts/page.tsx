'use client';

import { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  CheckCircle,
  Download,
  RefreshCw,
  Search,
  Wallet,
  AlertCircle,
  Plus,
  Upload,
  FileSpreadsheet,
  Loader2,
  X,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { authHeader } from '@/lib/api-client';

/* ─── Batch status types (REAL schema from payouts.service.ts) ──────────────── */

type PayoutBatchStatus =
  | 'DRAFT'
  | 'PROCESSING'
  | 'SUBMITTED'
  | 'FAILED'
  | 'CANCELLED';

const BATCH_STATUS_LABELS: Record<PayoutBatchStatus, string> = {
  DRAFT:      'Draft',
  PROCESSING: 'Processing',
  SUBMITTED:  'Submitted',
  FAILED:     'Failed',
  CANCELLED:  'Cancelled',
};

const TXN_STATUS_STYLES: Record<string, string> = {
  SUCCESS:  'bg-green-100 text-green-700',
  PENDING:  'bg-amber-100 text-amber-700',
  INITIATED:'bg-blue-100 text-blue-700',
  FAILED:   'bg-red-100 text-red-700',
  REVERSED: 'bg-gray-100 text-gray-600',
  HOLD:     'bg-gray-100 text-gray-600',
};

const PAYOUT_MODE_LABELS: Record<string, string> = {
  UPI:           'UPI',
  BANK_TRANSFER: 'Bank Transfer',
  VOUCHER:       'Voucher',
  GIFT:          'Gift',
  CATALOGUE:     'Catalogue',
};

/* ─── API types ─────────────────────────────────────────────────────────────── */

interface ApiBatch {
  id:               string;
  batchCode:        string;
  status:           PayoutBatchStatus;
  payoutMode:       string;
  totalAmountPaise: number;
  transactionCount: number;
  processedAt?:     string | null;
  createdAt:        string;
  notes?:           string | null;
  _count?:          { transactions: number };
}

interface ApiTransaction {
  id:               string;
  payoutMode:       string;
  status:           string;
  amountPaise:      number;
  netAmountPaise:   number;
  beneficiaryName?: string | null;
  partner:          { id: string; businessName: string };
  batch?:           { id: string; batchCode: string } | null;
  providerRefId?:   string | null;
}

interface FundSummary {
  totalReceivedPaise:    number;
  totalUtilisedPaise:    number;
  closingBalancePaise:   number;
  pendingLiabilityPaise: number;
  availablePaise:        number;
}

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function formatPaise(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(2)}Cr`;
  if (rupees >= 100_000)    return `₹${(rupees / 100_000).toFixed(1)}L`;
  if (rupees >= 1_000)      return `₹${(rupees / 1_000).toFixed(1)}K`;
  return `₹${rupees.toLocaleString('en-IN')}`;
}

/** Trigger a binary download from a fetch Response. */
async function downloadBlob(url: string, headers: Record<string, string>, defaultFilename: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      return json?.error ?? `HTTP ${res.status}`;
    }
    const blob = await res.blob();
    const cd   = res.headers.get('Content-Disposition') ?? '';
    const match = cd.match(/filename="?([^";\s]+)"?/i);
    const filename = match?.[1] ?? defaultFilename;
    const objectUrl = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: objectUrl, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Download failed';
  }
}

/* ─── Main component ─────────────────────────────────────────────────────────── */

export default function PayoutsPage() {
  /* ── Data state ──────────────────────────────────────────────────────────── */
  const [batches,      setBatches]      = useState<ApiBatch[]>([]);
  const [transactions, setTransactions] = useState<ApiTransaction[]>([]);
  const [fund,         setFund]         = useState<FundSummary | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<ApiBatch | null>(null);

  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [search,   setSearch]   = useState('');

  /* ── Action states ───────────────────────────────────────────────────────── */
  const [processing,     setProcessing]     = useState(false);
  const [processError,   setProcessError]   = useState<string | null>(null);
  const [assigningPending, setAssigningPending] = useState(false);
  const [assignError,    setAssignError]    = useState<string | null>(null);
  const [assignResult,   setAssignResult]   = useState<{ assigned: number } | null>(null);

  /* ── Create Batch dialog ─────────────────────────────────────────────────── */
  const [showCreateBatch, setShowCreateBatch] = useState(false);
  const [createMode,      setCreateMode]      = useState('BANK_TRANSFER');
  const [createNotes,     setCreateNotes]     = useState('');
  const [creating,        setCreating]        = useState(false);
  const [createError,     setCreateError]     = useState<string | null>(null);

  /* ── UTR download/upload state ───────────────────────────────────────────── */
  const [utrDownloading, setUtrDownloading] = useState(false);
  const [utrDownloadErr, setUtrDownloadErr] = useState<string | null>(null);
  const [utrUploading,   setUtrUploading]   = useState(false);
  const [utrUploadErr,   setUtrUploadErr]   = useState<string | null>(null);
  const [utrUploadResult, setUtrUploadResult] = useState<{ paidCount: number; failedCount: number } | null>(null);
  const [recoDownloading, setRecoDownloading] = useState(false);
  const [recoDownloadErr, setRecoDownloadErr] = useState<string | null>(null);
  const utrFileRef = useRef<HTMLInputElement>(null);

  /* ─── Initial load ───────────────────────────────────────────────────────── */

  function load() {
    setLoading(true);
    setError(null);
    const headers = { ...authHeader() };
    Promise.all([
      fetch('/api/payouts/batches', { headers }).then(r => r.json()),
      fetch('/api/payouts/fund',    { headers }).then(r => r.json()),
    ])
      .then(([batchJson, fundJson]) => {
        if (batchJson.success && batchJson.data) {
          const list: ApiBatch[] = batchJson.data.batches;
          setBatches(list);
          // Preserve the currently selected batch (by id) after a reload so the
          // detail panel doesn't jump to the first batch on every process/assign.
          setSelectedBatch(prev => {
            if (prev) {
              const refreshed = list.find(b => b.id === prev.id);
              return refreshed ?? list[0] ?? null;
            }
            return list[0] ?? null;
          });
        } else {
          setError(batchJson.error ?? 'Failed to load payout batches');
        }
        if (fundJson.success && fundJson.data) {
          setFund(fundJson.data);
        }
      })
      .catch(() => setError('Failed to load payouts'))
      .finally(() => setLoading(false));
  }

  /* ─── Fetch transactions for the selected batch ──────────────────────────── */
  // SETTLE-P-3: always fetch with batchId filter so batches whose transactions
  // fall outside the default limit-20 still show correctly.
  useEffect(() => {
    if (!selectedBatch) {
      setTransactions([]);
      return;
    }
    const headers = { ...authHeader() };
    fetch(`/api/payouts/transactions?batchId=${selectedBatch.id}`, { headers })
      .then(r => r.json())
      .then((json) => {
        if (json.success && json.data) {
          setTransactions(json.data.transactions);
        }
      })
      .catch(() => {/* non-fatal — table stays empty */});
  }, [selectedBatch?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Create Batch ───────────────────────────────────────────────────────── */

  const handleCreateBatch = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res  = await fetch('/api/payouts/batches', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body:    JSON.stringify({ payoutMode: createMode, notes: createNotes || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setCreateError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setShowCreateBatch(false);
      setCreateNotes('');
      // Prepend the new batch and select it.
      const newBatch: ApiBatch = json.data.batch;
      setBatches(prev => [newBatch, ...prev]);
      setSelectedBatch(newBatch);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create batch');
    } finally {
      setCreating(false);
    }
  };

  /* ─── Assign Pending ─────────────────────────────────────────────────────── */

  const handleAssignPending = async () => {
    if (!selectedBatch) return;
    setAssigningPending(true);
    setAssignError(null);
    setAssignResult(null);
    try {
      const res  = await fetch(`/api/payouts/batches/${selectedBatch.id}/assign-pending`, {
        method:  'POST',
        headers: { ...authHeader() },
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setAssignError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setAssignResult({ assigned: json.data.assigned });
      // Refresh to pick up updated transaction counts.
      load();
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : 'Failed to assign pending transactions');
    } finally {
      setAssigningPending(false);
    }
  };

  /* ─── Process Batch ──────────────────────────────────────────────────────── */

  const handleProcessBatch = async () => {
    if (!selectedBatch) return;
    if (!window.confirm(
      `Process batch ${selectedBatch.batchCode}?\n\nThis will validate transactions and flag them for disbursement (SUBMITTED). This cannot be undone.`
    )) return;

    setProcessing(true);
    setProcessError(null);
    try {
      const res  = await fetch(`/api/payouts/batches/${selectedBatch.id}/process`, {
        method:  'POST',
        headers: { ...authHeader() },
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setProcessError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      // Update selected batch status optimistically then reload for full data
      // (so header counts/totals are current after processing).
      setSelectedBatch(prev => prev ? { ...prev, status: json.data.status } : prev);
      setBatches(prev => prev.map(b => b.id === selectedBatch.id ? { ...b, status: json.data.status } : b));
      load();
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : 'Failed to process batch');
    } finally {
      setProcessing(false);
    }
  };

  /* ─── UTR Template Download ──────────────────────────────────────────────── */

  const handleDownloadUtrTemplate = async () => {
    if (!selectedBatch) return;
    setUtrDownloading(true);
    setUtrDownloadErr(null);
    const err = await downloadBlob(
      `/api/payouts/batches/${selectedBatch.id}/utr-template`,
      { ...authHeader() },
      `payout-utr-${selectedBatch.batchCode}.xlsx`,
    );
    if (err) setUtrDownloadErr(err);
    setUtrDownloading(false);
  };

  /* ─── UTR Upload ─────────────────────────────────────────────────────────── */

  const handleUtrFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedBatch) return;

    // Preview first (?apply omitted = false), then confirm and apply.
    const confirmed = window.confirm(
      `Upload "${file.name}" as the UTR report for batch ${selectedBatch.batchCode}?\n\nThis will mark matched transactions as SUCCESS or FAILED and cannot be undone.`
    );
    if (!confirmed) {
      if (utrFileRef.current) utrFileRef.current.value = '';
      return;
    }

    setUtrUploading(true);
    setUtrUploadErr(null);
    setUtrUploadResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res  = await fetch(`/api/payouts/batches/${selectedBatch.id}/utr?apply=true`, {
        method:  'POST',
        headers: { ...authHeader() },
        body:    form,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setUtrUploadErr(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setUtrUploadResult({ paidCount: json.data.paidCount, failedCount: json.data.failedCount });
      // Reload to reflect updated transaction statuses.
      load();
    } catch (err) {
      setUtrUploadErr(err instanceof Error ? err.message : 'UTR upload failed');
    } finally {
      setUtrUploading(false);
      if (utrFileRef.current) utrFileRef.current.value = '';
    }
  };

  /* ─── Reconciliation Download ────────────────────────────────────────────── */

  const handleDownloadReconciliation = async () => {
    if (!selectedBatch) return;
    setRecoDownloading(true);
    setRecoDownloadErr(null);
    const err = await downloadBlob(
      `/api/payouts/reconciliation?batchId=${selectedBatch.id}`,
      { ...authHeader() },
      `reconciliation-${selectedBatch.batchCode}.xlsx`,
    );
    if (err) setRecoDownloadErr(err);
    setRecoDownloading(false);
  };

  /* ─── Derived ────────────────────────────────────────────────────────────── */

  // Transactions are already filtered by batchId from the API; apply local search only.
  const visibleTxns = transactions.filter(t => {
    if (!search) return true;
    return (
      t.partner.businessName.toLowerCase().includes(search.toLowerCase()) ||
      (t.providerRefId ?? '').includes(search)
    );
  });

  /* ─── Render ─────────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">

      {/* ── Fund Ledger Summary card (real data from GET /api/payouts/fund) ── */}
      {fund && (
        <div className="bg-gradient-to-r from-[#1A1A2E] to-[#16213E] rounded-2xl p-6 text-white">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-white/10 rounded-xl">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">Fund Ledger Summary</p>
              <p className="text-xs text-slate-400">Live totals from the fund ledger</p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-slate-400">Total Received</p>
              <p className="text-lg font-bold text-white mt-0.5">{formatPaise(fund.totalReceivedPaise)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Total Utilised</p>
              <p className="text-lg font-bold text-white mt-0.5">{formatPaise(fund.totalUtilisedPaise)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Closing Balance</p>
              <p className="text-lg font-bold text-white mt-0.5">{formatPaise(fund.closingBalancePaise)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Available (after pending)</p>
              <p className={`text-lg font-bold mt-0.5 ${fund.availablePaise <= 0 ? 'text-red-400' : fund.availablePaise < fund.pendingLiabilityPaise ? 'text-amber-400' : 'text-white'}`}>
                {formatPaise(fund.availablePaise)}
              </p>
              {fund.availablePaise < fund.pendingLiabilityPaise && fund.availablePaise > 0 && (
                <p className="text-xs text-amber-400 flex items-center gap-1 mt-0.5">
                  <AlertCircle className="w-3 h-3" /> Below pending liability
                </p>
              )}
              {fund.availablePaise <= 0 && (
                <p className="text-xs text-red-400 flex items-center gap-1 mt-0.5">
                  <AlertCircle className="w-3 h-3" /> Insufficient funds
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Create Batch modal ─────────────────────────────────────────────── */}
      {showCreateBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Create Payout Batch</h3>
              <button onClick={() => { setShowCreateBatch(false); setCreateError(null); }} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">Payout Mode</label>
                <select
                  value={createMode}
                  onChange={e => setCreateMode(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                >
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                  <option value="UPI">UPI</option>
                  <option value="VOUCHER">Voucher</option>
                  <option value="GIFT">Gift</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={createNotes}
                  onChange={e => setCreateNotes(e.target.value)}
                  placeholder="e.g. May 2025 bank run"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
              </div>
            </div>

            {createError && (
              <p className="text-xs text-red-600 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {createError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setShowCreateBatch(false); setCreateError(null); }}
                className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateBatch}
                disabled={creating}
                className="px-4 py-2 text-sm bg-[var(--brand-primary)] text-white rounded-lg font-medium hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60 flex items-center gap-2"
              >
                {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {creating ? 'Creating…' : 'Create Batch'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">

        {/* ── Batch list ────────────────────────────────────────────────────── */}
        <div className="lg:col-span-1 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">Payout Batches</h2>
            <button
              onClick={() => { setShowCreateBatch(true); setCreateError(null); }}
              className="flex items-center gap-1 text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] font-medium"
            >
              <Plus className="w-3.5 h-3.5" /> New
            </button>
          </div>

          <div className="space-y-2">
            {batches.length === 0 && (
              <p className="text-xs text-gray-400 py-4 text-center">No batches yet</p>
            )}
            {batches.map((batch) => (
              <button
                key={batch.id}
                onClick={() => {
                  setSelectedBatch(batch);
                  setProcessError(null);
                  setAssignError(null);
                  setAssignResult(null);
                  setUtrUploadErr(null);
                  setUtrUploadResult(null);
                  setUtrDownloadErr(null);
                  setRecoDownloadErr(null);
                }}
                className={`w-full text-left p-3 rounded-xl border transition-all ${
                  selectedBatch?.id === batch.id
                    ? 'border-[var(--brand-primary)] bg-red-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-gray-900">{batch.batchCode}</p>
                  <ChevronRight className={`w-4 h-4 ${selectedBatch?.id === batch.id ? 'text-[var(--brand-primary)]' : 'text-gray-400'}`} />
                </div>
                <p className="text-xs text-gray-500 mb-1">
                  {(batch._count?.transactions ?? batch.transactionCount ?? 0).toLocaleString()} txns
                  {' · '}{PAYOUT_MODE_LABELS[batch.payoutMode] ?? batch.payoutMode}
                </p>
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${
                    batch.status === 'SUBMITTED' ? 'text-blue-600' :
                    batch.status === 'DRAFT'     ? 'text-amber-600' :
                    batch.status === 'FAILED'    ? 'text-red-600' : 'text-gray-600'
                  }`}>
                    {BATCH_STATUS_LABELS[batch.status]}
                  </span>
                  {batch.totalAmountPaise > 0 && (
                    <span className="text-xs font-bold text-gray-800">{formatPaise(batch.totalAmountPaise)}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Batch detail ──────────────────────────────────────────────────── */}
        <div className="lg:col-span-3 space-y-4">
          {selectedBatch && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">
                    {selectedBatch.batchCode}
                    <span className={`ml-2 text-xs font-medium px-2 py-0.5 rounded-full ${
                      selectedBatch.status === 'SUBMITTED' ? 'bg-blue-100 text-blue-700' :
                      selectedBatch.status === 'DRAFT'     ? 'bg-amber-100 text-amber-700' :
                      selectedBatch.status === 'FAILED'    ? 'bg-red-100 text-red-700' :
                      selectedBatch.status === 'PROCESSING'? 'bg-purple-100 text-purple-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {BATCH_STATUS_LABELS[selectedBatch.status]}
                    </span>
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Batch ID: {selectedBatch.id}
                    {' · '}Mode: {PAYOUT_MODE_LABELS[selectedBatch.payoutMode] ?? selectedBatch.payoutMode}
                    {selectedBatch.processedAt && ` · Processed: ${selectedBatch.processedAt.slice(0, 10)}`}
                  </p>
                  {selectedBatch.notes && (
                    <p className="text-xs text-gray-400 mt-0.5 italic">{selectedBatch.notes}</p>
                  )}
                </div>

                {/* Action buttons — contextual on batch status */}
                <div className="flex flex-col gap-2 items-end">
                  {/* DRAFT: assign pending */}
                  {selectedBatch.status === 'DRAFT' && (
                    <button
                      onClick={handleAssignPending}
                      disabled={assigningPending}
                      className="flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-700 text-xs rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
                    >
                      {assigningPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      Assign Pending Txns
                    </button>
                  )}

                  {/* DRAFT or FAILED: process batch */}
                  {(selectedBatch.status === 'DRAFT' || selectedBatch.status === 'FAILED') && (
                    <button
                      onClick={handleProcessBatch}
                      disabled={processing}
                      className="flex items-center gap-2 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60"
                    >
                      {processing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      {processing ? 'Processing…' : 'Process Batch'}
                    </button>
                  )}

                  {/* SUBMITTED: download UTR template + upload UTR */}
                  {selectedBatch.status === 'SUBMITTED' && (
                    <>
                      <button
                        onClick={handleDownloadUtrTemplate}
                        disabled={utrDownloading}
                        className="flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-700 text-xs rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
                      >
                        {utrDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        {utrDownloading ? 'Downloading…' : 'UTR Template'}
                      </button>
                      <label className={`flex items-center gap-2 px-3 py-2 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer ${utrUploading ? 'bg-gray-400 pointer-events-none' : 'bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-dark)]'}`}>
                        {utrUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                        {utrUploading ? 'Uploading…' : 'Upload Filled UTR'}
                        <input
                          ref={utrFileRef}
                          type="file"
                          accept=".xlsx,.xls"
                          className="hidden"
                          disabled={utrUploading}
                          onChange={handleUtrFileChange}
                        />
                      </label>
                    </>
                  )}

                  {/* Always available: reconciliation download */}
                  <button
                    onClick={handleDownloadReconciliation}
                    disabled={recoDownloading}
                    className="flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-700 text-xs rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
                  >
                    {recoDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
                    Reconciliation
                  </button>
                </div>
              </div>

              {/* Inline error / info banners */}
              {processError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {processError}
                </div>
              )}
              {assignError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {assignError}
                </div>
              )}
              {assignResult && (
                <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700 flex items-start gap-2">
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  {assignResult.assigned > 0
                    ? `${assignResult.assigned} pending transaction(s) assigned to this batch.`
                    : 'No eligible pending transactions found to assign.'}
                </div>
              )}
              {utrUploadErr && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {utrUploadErr}
                </div>
              )}
              {utrUploadResult && (
                <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700 flex items-start gap-2">
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  UTR applied: {utrUploadResult.paidCount} paid, {utrUploadResult.failedCount} failed.
                </div>
              )}
              {utrDownloadErr && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {utrDownloadErr}
                </div>
              )}
              {recoDownloadErr && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {recoDownloadErr}
                </div>
              )}
            </div>
          )}

          {/* ── Transaction table ──────────────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">
                Transactions
                {selectedBatch ? ` — ${selectedBatch.batchCode}` : ' (all)'}
              </h3>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search partner or UTR…"
                  className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] w-48"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Partner</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Amount</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Mode</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">UTR</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {visibleTxns.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-xs text-gray-400">
                        {search ? 'No transactions match your search' : 'No transactions in this batch'}
                      </td>
                    </tr>
                  ) : (
                    visibleTxns.map((txn) => (
                      <tr key={txn.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-2.5">
                          <p className="text-xs font-medium text-gray-900">{txn.partner.businessName}</p>
                          <p className="text-xs text-gray-400 font-mono">{txn.partner.id.slice(0, 8)}…</p>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-700 text-right">
                          {formatPaise(Number(txn.amountPaise))}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-600">
                          {PAYOUT_MODE_LABELS[txn.payoutMode] ?? txn.payoutMode}
                        </td>
                        <td className="px-4 py-2.5 text-xs font-mono text-gray-500">
                          {txn.providerRefId ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TXN_STATUS_STYLES[txn.status] ?? 'bg-gray-100 text-gray-600'}`}>
                            {txn.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs text-gray-500">
                Showing {visibleTxns.length} transaction{visibleTxns.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
