'use client';

import { useState, useEffect } from 'react';
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
import { useAdminSession }        from '@/lib/admin-session';
import { getAllBatches }           from '@/lib/credits-payouts-store';
import {
  checkReversalEligibility,
  initiateReversal,
  getAllReversals,
  type ReversalEligibility,
} from '@/lib/credits-payouts-reversal';
import type { CreditBatch, CreditUploadRow } from '@/types';

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

interface ReversalTarget {
  batchId:    string;
  outletId:   string;
  outletName: string;
  fieldId:    string;
  fieldName:  string;
  period:     string;
  awardType:  'POINTS' | 'PAYOUT';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PayoutStatusPage() {
  const session = useAdminSession();

  const [batches,      setBatches]      = useState<CreditBatch[]>([]);
  const [expanded,     setExpanded]     = useState<string | null>(null);
  const [filterPeriod, setFilterPeriod] = useState('');

  // Reversal initiation state
  const [revTarget,  setRevTarget]  = useState<ReversalTarget | null>(null);
  const [revAmount,  setRevAmount]  = useState('');
  const [revRemarks, setRevRemarks] = useState('');
  const [revElig,    setRevElig]    = useState<ReversalEligibility | null>(null);
  const [revMsg,     setRevMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [revLoading, setRevLoading] = useState(false);

  useEffect(() => {
    setBatches(getAllBatches());
  }, []);

  const periods = [...new Set(batches.map((b) => b.period))].sort().reverse();

  const visible = filterPeriod
    ? batches.filter((b) => b.period === filterPeriod)
    : batches;

  // ─── Report download ────────────────────────────────────────────────────────

  function downloadReport(batch: CreditBatch) {
    import('xlsx').then((XLSX) => {
      const rows = batch.rows
        .filter((r) => r.status === 'OK')
        .map((r) => ({
          'Outlet ID':    r.outletId,
          'Outlet Name':  r.outletName,
          'Field':        r.fieldName,
          'Award Type':   r.awardType,
          'Amount':       r.amount,
          'Narration':    r.narration,
          'Batch ID':     batch.id,
          'Period':       batch.period,
          'Status':       batch.status,
          'Confirmed At': batch.confirmedAt ?? '',
        }));

      const ws  = XLSX.utils.json_to_sheet(rows);
      const wb  = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout Status');
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `payout-status-${batch.period}-${batch.id}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ─── Open reversal form ─────────────────────────────────────────────────────

  function openReversal(batch: CreditBatch, row: CreditUploadRow) {
    const elig = checkReversalEligibility({
      batchId:  batch.id,
      outletId: row.outletId,
      fieldId:  row.fieldId,
    });
    const target: ReversalTarget = {
      batchId:    batch.id,
      outletId:   row.outletId,
      outletName: row.outletName,
      fieldId:    row.fieldId,
      fieldName:  row.fieldName,
      period:     batch.period,
      awardType:  row.awardType,
    };
    setRevTarget(target);
    setRevElig(elig);
    setRevAmount(elig.eligible ? String(elig.maxReversibleAmount) : '');
    setRevRemarks('');
    setRevMsg(null);
  }

  function closeReversal() {
    setRevTarget(null);
    setRevElig(null);
    setRevAmount('');
    setRevRemarks('');
    setRevMsg(null);
  }

  function submitReversal() {
    if (!revTarget || !revElig?.eligible) return;
    const amt = Number(revAmount);
    if (!amt || amt <= 0) {
      setRevMsg({ type: 'err', text: 'Please enter a valid amount.' });
      return;
    }
    setRevLoading(true);
    try {
      const req = initiateReversal({
        batchId:         revTarget.batchId,
        outletId:        revTarget.outletId,
        outletName:      revTarget.outletName,
        fieldId:         revTarget.fieldId,
        fieldName:       revTarget.fieldName,
        period:          revTarget.period,
        requestedAmount: amt,
        requestedBy:     session.name,
        remarks:         revRemarks || undefined,
      });
      setRevMsg({ type: 'ok', text: `Reversal request ${req.id} submitted — awaiting Gifsy approval.` });
      setBatches(getAllBatches()); // refresh
    } catch (err) {
      setRevMsg({ type: 'err', text: String(err) });
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

      {/* No batches */}
      {visible.length === 0 && (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-10 text-center">
          <BarChart2 className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No upload batches found.</p>
          <p className="text-xs text-gray-400 mt-1">
            Upload data via "Upload Credits" to see batches here.
          </p>
        </div>
      )}

      {/* Batch list */}
      {visible.length > 0 && (
        <div className="space-y-3">
          {visible.map((batch) => {
            const style  = STATUS_STYLES[batch.status] ?? STATUS_STYLES['PENDING_CONFIRM'];
            const isOpen = expanded === batch.id;
            const isConfirmed = batch.status === 'CONFIRMED' || batch.status === 'PARTIALLY_REVERSED';

            return (
              <div key={batch.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* Batch header */}
                <div
                  className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => setExpanded(isOpen ? null : batch.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">
                        {monthLabel(batch.period)}
                      </span>
                      <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.text}`}>
                        {style.icon}
                        {batch.status === 'PENDING_CONFIRM'   ? 'Pending Approval'
                         : batch.status === 'CONFIRMED'        ? 'Confirmed'
                         :                                       'Partially Reversed'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 font-mono">{batch.id}</p>
                  </div>

                  <div className="flex items-center gap-6 text-xs text-gray-600">
                    {batch.totalPoints > 0 && (
                      <span>{batch.totalPoints.toLocaleString('en-IN')} pts</span>
                    )}
                    {batch.totalPayoutInr > 0 && (
                      <span>₹{batch.totalPayoutInr.toLocaleString('en-IN')}</span>
                    )}
                    <span>{batch.totalOutlets} outlets</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); downloadReport(batch); }}
                      className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
                      title="Download report"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </div>
                </div>

                {/* Expanded rows */}
                {isOpen && (
                  <div className="border-t border-gray-100">
                    {/* Meta row */}
                    <div className="px-5 py-3 bg-gray-50 flex flex-wrap gap-6 text-xs text-gray-500">
                      <span>Uploaded by: <strong className="text-gray-700">{batch.uploadedBy}</strong></span>
                      <span>At: <strong className="text-gray-700">{new Date(batch.uploadedAt).toLocaleString('en-IN')}</strong></span>
                      {batch.confirmedAt && (
                        <span>Confirmed: <strong className="text-gray-700">{new Date(batch.confirmedAt).toLocaleString('en-IN')}</strong></span>
                      )}
                    </div>

                    {/* OK rows table */}
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
                          {batch.rows
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
                                  {r.awardType === 'PAYOUT' ? `₹${r.amount.toLocaleString('en-IN')}` : r.amount.toLocaleString('en-IN')}
                                </td>
                                <td className="px-4 py-2 text-gray-500">{r.narration || '—'}</td>
                                {isConfirmed && (
                                  <td className="px-4 py-2">
                                    <button
                                      onClick={() => openReversal(batch, r)}
                                      className="flex items-center gap-1 px-2 py-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg transition-colors"
                                      title="Request reversal"
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
                      {batch.rows.filter((r) => r.status === 'OK').length > 20 && (
                        <p className="px-4 py-2 text-xs text-gray-400 text-center">
                          Showing first 20 rows. Download the report for the full list.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Reversal request panel ─────────────────────────────────────────── */}
      {revTarget && (
        <div className="bg-white rounded-xl border border-amber-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-amber-600" />
                Request Reversal
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {revTarget.outletName} · {revTarget.fieldName} · {revTarget.awardType} · {monthLabel(revTarget.period)}
              </p>
            </div>
            <button
              onClick={closeReversal}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              ✕ Close
            </button>
          </div>

          {/* Eligibility check */}
          {revElig && !revElig.eligible && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex gap-2 text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{revElig.reason}</span>
            </div>
          )}

          {revElig?.eligible && (
            <div className="space-y-3">
              <div className="bg-amber-50 rounded-lg px-4 py-2 text-xs text-amber-800">
                Maximum reversible: <strong>
                  {revTarget.awardType === 'PAYOUT'
                    ? `₹${revElig.maxReversibleAmount.toLocaleString('en-IN')}`
                    : `${revElig.maxReversibleAmount.toLocaleString('en-IN')} pts`
                  }
                </strong>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Amount to reverse{' '}
                    <span className="text-gray-400 font-normal">
                      (max {revElig.maxReversibleAmount.toLocaleString('en-IN')})
                    </span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={revElig.maxReversibleAmount}
                    step={1}
                    value={revAmount}
                    onChange={(e) => setRevAmount(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Remarks (optional)</label>
                  <input
                    type="text"
                    value={revRemarks}
                    onChange={(e) => setRevRemarks(e.target.value)}
                    placeholder="Reason for reversal"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-amber-400 focus:outline-none"
                  />
                </div>
              </div>

              {revMsg && (
                <div className={`rounded-lg p-3 text-xs ${revMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                  {revMsg.text}
                </div>
              )}

              {revMsg?.type !== 'ok' && (
                <button
                  onClick={submitReversal}
                  disabled={revLoading || !revAmount}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {revLoading ? 'Submitting…' : 'Submit Reversal Request'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
