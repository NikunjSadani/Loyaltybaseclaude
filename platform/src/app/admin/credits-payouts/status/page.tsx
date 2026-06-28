'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Clock,
  CheckCircle,
  XCircle,
  Download,
  BarChart2,
  ChevronDown,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { jsonToSheetSafe } from '@/lib/xlsx-safe';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

const STATUS_STYLES: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  PENDING_CONFIRM: {
    bg: 'bg-amber-50',  text: 'text-amber-700',
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  CONFIRMED: {
    bg: 'bg-emerald-50', text: 'text-emerald-700',
    icon: <CheckCircle className="w-3.5 h-3.5" />,
  },
  PARTIALLY_REVERSED: {
    bg: 'bg-orange-50',  text: 'text-orange-700',
    icon: <XCircle className="w-3.5 h-3.5" />,
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface BatchSummary {
  id:               string;
  batchCode:        string;
  period:           string;
  status:           string;
  uploadedBy:       string;
  uploadedAt:       string;
  confirmedBy?:     string;
  confirmedAt?:     string;
  totalOutlets:     number;
  totalPoints:      string | number;
  /** totalPayoutPaise from the API — integer paise (BigInt serialised to number). */
  totalPayoutPaise: string | number;
}

interface BatchRow {
  rowNum:    number;
  outletId:  string;
  outletName: string;
  fieldId:   string;
  fieldName: string;
  amount:    number;
  narration: string;
  awardType: 'POINTS' | 'PAYOUT';
  status:    'OK' | 'ERROR' | 'SKIP';
  errors:    string[];
}

interface BatchDetail extends BatchSummary {
  rows: BatchRow[];
}

interface ReversalTarget {
  batchId:      string;
  outletId:     string;
  outletName:   string;
  fieldId:      string;
  fieldName:    string;
  period:       string;
  awardType:    'POINTS' | 'PAYOUT';
  /** Original amount in integer paise (PAYOUT) or whole points (POINTS). */
  originalPaise: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PayoutStatusPage() {
  const session = useAdminSession();

  const [batches,      setBatches]      = useState<BatchSummary[]>([]);
  const [batchDetails, setBatchDetails] = useState<Record<string, BatchDetail>>({});
  const [expanded,     setExpanded]     = useState<string | null>(null);
  const [filterPeriod, setFilterPeriod] = useState('');
  const [loading,      setLoading]      = useState(true);

  // Reversal state
  const [revTarget,  setRevTarget]  = useState<ReversalTarget | null>(null);
  const [revAmount,  setRevAmount]  = useState('');
  const [revRemarks, setRevRemarks] = useState('');
  const [revMsg,     setRevMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [revLoading, setRevLoading] = useState(false);

  const fetchBatches = useCallback(async () => {
    try {
      const res  = await fetch('/api/admin/credits/batches');
      const json = await res.json();
      if (json.success) setBatches(json.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBatches(); }, [fetchBatches]);

  async function expandBatch(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (batchDetails[id]) return;
    const res  = await fetch(`/api/admin/credits/batches/${id}`);
    const json = await res.json();
    if (json.success) {
      setBatchDetails((prev) => ({ ...prev, [id]: json.data as BatchDetail }));
    }
  }

  const periods = [...new Set(batches.map((b) => b.period))].sort().reverse();
  const visible  = filterPeriod ? batches.filter((b) => b.period === filterPeriod) : batches;

  // ─── Report download ────────────────────────────────────────────────────────

  function downloadReport(batch: BatchSummary, detail?: BatchDetail) {
    if (!detail) return;
    import('xlsx').then((XLSX) => {
      const rows = detail.rows
        .filter((r) => r.status === 'OK')
        .map((r) => ({
          'Outlet ID':    r.outletId,
          'Outlet Name':  r.outletName,
          'Field':        r.fieldName,
          'Award Type':   r.awardType,
          'Amount':       r.amount,
          'Narration':    r.narration,
          'Batch Code':   batch.batchCode,
          'Period':       batch.period,
          'Status':       batch.status,
          'Confirmed At': batch.confirmedAt ?? '',
        }));
      const ws  = jsonToSheetSafe(rows);
      const wb  = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout Status');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `payout-status-${batch.period}-${batch.batchCode}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ─── Reversal ───────────────────────────────────────────────────────────────

  function openReversal(batch: BatchSummary, row: BatchRow) {
    setRevTarget({
      batchId:       batch.id,
      outletId:      row.outletId,
      outletName:    row.outletName,
      fieldId:       row.fieldId,
      fieldName:     row.fieldName,
      period:        batch.period,
      awardType:     row.awardType,
      // row.amount is paise for PAYOUT rows; whole points for POINTS rows
      originalPaise: row.amount,
    });
    // Pre-fill in human units: rupees for PAYOUT, points for POINTS
    setRevAmount(row.awardType === 'PAYOUT' ? String(row.amount / 100) : String(row.amount));
    setRevRemarks('');
    setRevMsg(null);
  }

  function closeReversal() {
    setRevTarget(null);
    setRevAmount('');
    setRevRemarks('');
    setRevMsg(null);
  }

  async function submitReversal() {
    if (!revTarget) return;
    const inputAmt = Number(revAmount);
    if (!inputAmt || inputAmt <= 0) {
      setRevMsg({ type: 'err', text: 'Please enter a valid amount.' });
      return;
    }
    // Convert user input back to paise (for PAYOUT rows); POINTS rows already whole numbers.
    const requestedPaise = revTarget.awardType === 'PAYOUT'
      ? Math.round(inputAmt * 100)
      : inputAmt;
    if (requestedPaise > revTarget.originalPaise) {
      const origDisplay = revTarget.awardType === 'PAYOUT'
        ? `₹${(revTarget.originalPaise / 100).toLocaleString('en-IN')}`
        : `${revTarget.originalPaise.toLocaleString('en-IN')} pts`;
      setRevMsg({ type: 'err', text: `Amount cannot exceed ${origDisplay}.` });
      return;
    }
    setRevLoading(true);
    try {
      const res = await fetch(`/api/admin/credits/batches/${revTarget.batchId}/reversals`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outletId:       revTarget.outletId,
          outletName:     revTarget.outletName,
          fieldId:        revTarget.fieldId,
          fieldName:      revTarget.fieldName,
          awardType:      revTarget.awardType,
          // DTO now expects paise field names
          originalPaise:  revTarget.originalPaise,
          requestedPaise,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setRevMsg({ type: 'err', text: json.error ?? 'Failed to submit reversal' });
      } else {
        setRevMsg({ type: 'ok', text: `Reversal request submitted — awaiting Gifsy approval.` });
        fetchBatches();
      }
    } catch (e) {
      setRevMsg({ type: 'err', text: String(e) });
    }
    setRevLoading(false);
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <BarChart2 className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Payout Status</h2>
          <p className="text-xs text-gray-500">
            View upload batch status. PENDING = awaiting Gifsy UTR; CONFIRMED = credited/paid.
          </p>
        </div>
      </div>

      {/* Filter */}
      {periods.length > 1 && (
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-gray-600">Filter by period:</label>
          <select
            value={filterPeriod}
            onChange={(e) => setFilterPeriod(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          >
            <option value="">All periods</option>
            {periods.map((p) => (
              <option key={p} value={p}>{monthLabel(p)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-10 text-center">
          <p className="text-sm text-gray-500 animate-pulse">Loading batches…</p>
        </div>
      )}

      {/* No batches */}
      {!loading && visible.length === 0 && (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-10 text-center">
          <BarChart2 className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No upload batches found.</p>
          <p className="text-xs text-gray-400 mt-1">Upload data via "Upload Credits" to see batches here.</p>
        </div>
      )}

      {/* Batch list */}
      {!loading && visible.length > 0 && (
        <div className="space-y-3">
          {visible.map((batch) => {
            const style      = STATUS_STYLES[batch.status] ?? STATUS_STYLES['PENDING_CONFIRM'];
            const isOpen     = expanded === batch.id;
            const isConfirmed = batch.status === 'CONFIRMED' || batch.status === 'PARTIALLY_REVERSED';
            const detail     = batchDetails[batch.id];

            return (
              <div key={batch.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div
                  className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => expandBatch(batch.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{monthLabel(batch.period)}</span>
                      <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.text}`}>
                        {style.icon}
                        {batch.status === 'PENDING_CONFIRM' ? 'Pending Approval'
                         : batch.status === 'CONFIRMED'     ? 'Confirmed'
                         :                                    'Partially Reversed'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 font-mono">{batch.batchCode}</p>
                  </div>

                  <div className="flex items-center gap-6 text-xs text-gray-600">
                    {Number(batch.totalPoints) > 0 && (
                      <span>{Number(batch.totalPoints).toLocaleString('en-IN')} pts</span>
                    )}
                    {Number(batch.totalPayoutPaise) > 0 && (
                      // totalPayoutPaise is integer paise; divide by 100 for human display
                      <span>₹{(Number(batch.totalPayoutPaise) / 100).toLocaleString('en-IN')}</span>
                    )}
                    <span>{batch.totalOutlets} outlets</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {detail && (
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadReport(batch, detail); }}
                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
                        title="Download report"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                    <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-gray-100">
                    <div className="px-5 py-3 bg-gray-50 flex flex-wrap gap-6 text-xs text-gray-500">
                      <span>Uploaded by: <strong className="text-gray-700">{batch.uploadedBy}</strong></span>
                      <span>At: <strong className="text-gray-700">{new Date(batch.uploadedAt).toLocaleString('en-IN')}</strong></span>
                      {batch.confirmedAt && (
                        <span>Confirmed: <strong className="text-gray-700">{new Date(batch.confirmedAt).toLocaleString('en-IN')}</strong></span>
                      )}
                    </div>

                    {!detail ? (
                      <p className="px-5 py-4 text-xs text-gray-400 animate-pulse">Loading rows…</p>
                    ) : (
                      <div className="overflow-x-auto max-h-72">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
                            <tr>
                              {['Outlet ID', 'Outlet Name', 'Field', 'Award', 'Amount', 'Narration', ...(isConfirmed ? [''] : [])].map((h, i) => (
                                <th key={i} className="px-4 py-2 text-left font-semibold text-gray-600">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {detail.rows
                              .filter((r) => r.status === 'OK')
                              .slice(0, 20)
                              .map((r, i) => (
                                <tr key={i} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 font-mono text-gray-700">{r.outletId}</td>
                                  <td className="px-4 py-2 text-gray-700">{r.outletName}</td>
                                  <td className="px-4 py-2 text-gray-700">{r.fieldName}</td>
                                  <td className="px-4 py-2">
                                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium
                                      ${r.awardType === 'POINTS' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                      {r.awardType}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2 text-gray-700">
                                    {r.awardType === 'PAYOUT'
                                      // amount is integer paise for PAYOUT rows; divide by 100 for display
                                      ? `₹${(r.amount / 100).toLocaleString('en-IN')}`
                                      : r.amount.toLocaleString('en-IN')}
                                  </td>
                                  <td className="px-4 py-2 text-gray-500">{r.narration || '—'}</td>
                                  {isConfirmed && (
                                    <td className="px-4 py-2">
                                      <button
                                        onClick={() => openReversal(batch, r)}
                                        className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg"
                                      >
                                        <RotateCcw className="w-3 h-3" />
                                        Reverse
                                      </button>
                                    </td>
                                  )}
                                </tr>
                              ))}
                          </tbody>
                        </table>
                        {detail.rows.filter((r) => r.status === 'OK').length > 20 && (
                          <p className="px-4 py-2 text-xs text-gray-400 text-center">
                            Showing first 20 rows. Download report for full list.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Reversal modal */}
      {revTarget && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900">Request Reversal</h3>
              <button onClick={closeReversal} className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
            </div>

            <div className="bg-gray-50 rounded-xl p-4 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Outlet</span>
                <span className="font-medium text-gray-800">{revTarget.outletName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Field</span>
                <span className="font-medium text-gray-800">{revTarget.fieldName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Award Type</span>
                <span className="font-medium text-gray-800">{revTarget.awardType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Original Amount</span>
                <span className="font-medium text-gray-800">
                  {revTarget.awardType === 'PAYOUT'
                    // originalPaise is integer paise; divide by 100 for human display
                    ? `₹${(revTarget.originalPaise / 100).toLocaleString('en-IN')}`
                    : `${revTarget.originalPaise.toLocaleString('en-IN')} pts`}
                </span>
              </div>
            </div>

            {revMsg && (
              <div className={`rounded-xl px-4 py-3 text-xs ${revMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                {revMsg.text}
              </div>
            )}

            {!revMsg && (
              <>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-700">
                    Reversal Amount {revTarget.awardType === 'PAYOUT' ? '(₹)' : '(pts)'}
                  </label>
                  <input
                    type="number"
                    value={revAmount}
                    onChange={(e) => setRevAmount(e.target.value)}
                    max={revTarget.awardType === 'PAYOUT' ? revTarget.originalPaise / 100 : revTarget.originalPaise}
                    min={revTarget.awardType === 'PAYOUT' ? 0.01 : 1}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-700">Remarks (optional)</label>
                  <textarea
                    value={revRemarks}
                    onChange={(e) => setRevRemarks(e.target.value)}
                    rows={2}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 resize-none"
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={submitReversal}
                    disabled={revLoading}
                    className="flex-1 py-2.5 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 disabled:opacity-50"
                  >
                    {revLoading ? 'Submitting…' : 'Submit Reversal Request'}
                  </button>
                  <button
                    onClick={closeReversal}
                    className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
