'use client';

/**
 * /admin/gst-reimbursements — GIFSY_ADMIN only (Wave 2 Stream E, design D5)
 *
 * The GST-holdback release queue. When a SERVICE invoice is generated for a GST-registered
 * retailer, the retailer is paid the base immediately while the GST is HELD. Gifsy (TGSL, the
 * deductor) releases the held GST only on the retailer's proof of GST deposit + the reimbursement
 * payout reference — flipping HELD → RELEASED.
 *
 * Backend:
 *   GET  /api/admin/gst-reimbursements?status=HELD&clientId=&period=YYYY-MM
 *        → { status, clientId, period, count, totalGst:{paise,inr}, items:[…] }
 *   POST /api/admin/gst-reimbursements/:id/release  { proofUrl, releasePayoutRef, notes? }
 *        → 200 on HELD→RELEASED · 409 when already RELEASED (idempotent no-op) · 404 not found
 *
 * Money: every paise field arrives as { paise: string, inr: number }; rendered via formatINR
 * (which takes a paise number) so display is exact — no fabricated numbers on error.
 *
 * GIFSY-only: both the eventual nav item (added by the orchestrator, gifsyOnly:true) AND the
 * data fetch are gated on isGifsy — a CLIENT_ADMIN sees a not-permitted card and NO fetch fires.
 */

import { useState, useEffect, useCallback, Fragment } from 'react';
import {
  BadgePercent,
  Download,
  Filter,
  AlertTriangle,
  CheckCircle,
  XCircle,
  X,
  Loader2,
  Receipt,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { api } from '@/lib/api-client';
import { formatINR } from '@/lib/money';

// ─── Backend shapes ─────────────────────────────────────────────────────────────

interface Money {
  paise: string;
  inr: number;
}

type ReimbursementStatus = 'HELD' | 'RELEASED';

interface ReimbursementItem {
  id: string;
  clientId: string;
  autoInvoiceId: string | null;
  invoiceNumber: string | null;
  period: string | null;
  gstType: 'CGST_SGST' | 'IGST' | null;
  partnerId: string | null;
  outletCode: string | null;
  status: ReimbursementStatus;
  gst: Money;
  proofUrl: string | null;
  releasePayoutRef: string | null;
  releasedAt: string | null;
  releasedById: string | null;
  notes: string | null;
  createdAt: string;
}

interface ReimbursementListResponse {
  status: ReimbursementStatus;
  clientId: string | null;
  period: string | null;
  count: number;
  totalGst: Money;
  items: ReimbursementItem[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** paise ({ paise, inr }) → ₹ display via formatINR (which takes a paise number). */
function money(m: Money): string {
  return formatINR(Number(m.paise));
}

// ─── Release form (inline, per row) ───────────────────────────────────────────────

function ReleaseForm({
  item,
  onReleased,
  onCancel,
}: {
  item: ReimbursementItem;
  onReleased: () => void;
  onCancel: () => void;
}) {
  const [proofUrl, setProofUrl] = useState('');
  const [releasePayoutRef, setReleasePayoutRef] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!proofUrl.trim() || !releasePayoutRef.trim()) {
      setError('Both the GST-deposit proof URL and the reimbursement payout reference are required.');
      return;
    }
    setSubmitting(true);
    setError('');
    const res = await api.post(`/api/admin/gst-reimbursements/${item.id}/release`, {
      proofUrl: proofUrl.trim(),
      releasePayoutRef: releasePayoutRef.trim(),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    setSubmitting(false);
    if (res.success) {
      onReleased();
      return;
    }
    // 409 → already released (idempotent no-op signal): surface it and refresh the queue so the
    // now-stale row drops out. Any other error is shown inline without mutating the list.
    const msg = res.error ?? 'Release failed';
    if (/already released/i.test(msg)) {
      setError('This reimbursement was already released — refreshing the queue.');
      onReleased();
      return;
    }
    setError(msg);
  }

  return (
    <div className="bg-gray-50 border-t border-gray-100 px-4 py-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            GST-deposit proof URL <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={proofUrl}
            onChange={(e) => { setProofUrl(e.target.value); setError(''); }}
            placeholder="https://… (ticket attachment)"
            className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Reimbursement payout ref <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={releasePayoutRef}
            onChange={(e) => { setReleasePayoutRef(e.target.value); setError(''); }}
            placeholder="UTR / voucher no."
            className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Note (optional)</label>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Operator note"
          className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white rounded-lg text-xs font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
          {submitting ? 'Releasing…' : 'Confirm Release'}
        </button>
        <button
          onClick={onCancel}
          disabled={submitting}
          className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────────

export default function GstReimbursementsPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const [statusFilter, setStatusFilter] = useState<ReimbursementStatus>('HELD');
  const [clientId, setClientId] = useState('');
  const [period, setPeriod] = useState('');

  const [data, setData] = useState<ReimbursementListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [releasingId, setReleasingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // GIFSY-only surface: never fetch for a non-Gifsy session.
    if (!isGifsy) return;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ status: statusFilter });
    if (clientId.trim()) params.set('clientId', clientId.trim());
    if (period.trim()) params.set('period', period.trim());
    const res = await api.get<ReimbursementListResponse>(
      `/api/admin/gst-reimbursements?${params.toString()}`,
    );
    if (res.success) {
      setData(res.data);
    } else {
      setError(res.error ?? 'Failed to load GST reimbursements');
      setData(null);
    }
    setLoading(false);
  }, [isGifsy, statusFilter, clientId, period]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Not-permitted card for non-Gifsy sessions (belt-and-suspenders: nav is gifsyOnly too).
  if (!isGifsy) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
        <p className="text-sm text-amber-800">
          GST-reimbursement release is only available to Gifsy Platform Admins.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
          <BadgePercent className="w-5 h-5 text-[var(--brand-primary)]" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900">GST Reimbursements</h2>
          <p className="text-sm text-gray-500">
            Release held-back GST to registered retailers on their proof of GST deposit (D5).
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Filter className="w-3.5 h-3.5" />
        </div>
        <select
          aria-label="Status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ReimbursementStatus)}
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        >
          <option value="HELD">Held (release queue)</option>
          <option value="RELEASED">Released</option>
        </select>
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID (optional)"
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        />
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          aria-label="Period"
        />
      </div>

      {/* Summary strip */}
      {data && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Rows</p>
            <p className="text-base font-bold text-gray-900 mt-1">{data.count}</p>
            <p className="text-[10px] text-gray-400">{statusFilter === 'HELD' ? 'awaiting release' : 'released'}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Total GST</p>
            <p className="text-base font-bold text-gray-900 mt-1">{money(data.totalGst)}</p>
            <p className="text-[10px] text-gray-400">held-back GST value</p>
          </div>
        </div>
      )}

      {/* Error card */}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
          <XCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12" aria-label="Loading">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 text-gray-400" data-testid="gst-reimb-empty">
            <Receipt className="w-8 h-8" />
            <p className="text-sm">
              {statusFilter === 'HELD' ? 'No GST reimbursements awaiting release' : 'No released GST reimbursements'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                  <th className="text-left px-4 py-3">Invoice #</th>
                  <th className="text-left px-4 py-3">Client</th>
                  <th className="text-left px-4 py-3">Outlet</th>
                  <th className="text-left px-4 py-3">Period</th>
                  <th className="text-right px-4 py-3">GST (held)</th>
                  <th className="text-center px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.items.map((it) => (
                  <Fragment key={it.id}>
                    <tr className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-gray-700 text-[11px]">{it.invoiceNumber ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{it.clientId}</td>
                      <td className="px-4 py-3 text-gray-600">{it.outletCode ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{it.period ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{money(it.gst)}</td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            it.status === 'RELEASED'
                              ? 'bg-green-50 text-green-700 border border-green-200'
                              : 'bg-amber-50 text-amber-700 border border-amber-200'
                          }`}
                        >
                          {it.status === 'RELEASED' ? <CheckCircle className="w-3 h-3" /> : <Download className="w-3 h-3" />}
                          {it.status === 'RELEASED' ? 'Released' : 'Held'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {it.status === 'HELD' ? (
                          <button
                            onClick={() => setReleasingId(releasingId === it.id ? null : it.id)}
                            className="text-[10px] px-2 py-1 rounded bg-[var(--brand-primary)] text-white font-semibold hover:opacity-90 whitespace-nowrap"
                          >
                            Release GST
                          </button>
                        ) : (
                          <span className="text-[10px] text-gray-400 font-mono">{it.releasePayoutRef ?? '—'}</span>
                        )}
                      </td>
                    </tr>
                    {releasingId === it.id && it.status === 'HELD' && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <ReleaseForm
                            item={it}
                            onReleased={() => { setReleasingId(null); void load(); }}
                            onCancel={() => setReleasingId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
