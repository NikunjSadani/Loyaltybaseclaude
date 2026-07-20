import React from 'react';
import type { PayoutLedgerEntry } from '@/types';

/* ─── Payout statement row (INR entry inside a combined statement) ──────────────
   Shared by the partner's own wallet (partner/wallet) AND the sales outlet ledger
   (sales/kyc/[id]/ledger) so the two payout views can never drift. Presentational
   only — the row data comes from the shared backend builder (buildPayoutStatement).
─────────────────────────────────────────────────────────────────────────────── */

const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtInr(n: number) {
  return `₹${n.toLocaleString('en-IN')}`;
}

function monthLabel(period: string) {
  const [yr, mo] = period.split('-');
  return new Date(+yr, +mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export function PayoutStatementRow({ entry: p }: { entry: PayoutLedgerEntry }) {
  const isPaid = p.status === 'PAID';
  // Date the chip by when money hit (paidAt); before payment, by when the payout was
  // added (uploadedAt) so a pending row isn't a blank "—".
  const dateSrc = p.paidAt ?? p.uploadedAt;
  const d = dateSrc ? new Date(dateSrc) : null;
  const day = d ? String(d.getDate()).padStart(2, '0') : '—';
  const mon = d ? MONTH_SHORT[d.getMonth() + 1] : '';

  return (
    <div className="flex items-center gap-3 py-3.5">
      {/* Date chip */}
      <div className="w-10 h-10 rounded-xl bg-gray-50 border border-gray-100 flex flex-col items-center justify-center shrink-0">
        <span className="text-sm font-bold text-gray-800 leading-none">{day}</span>
        <span className="text-[9px] text-gray-400 font-semibold uppercase mt-0.5">{mon}</span>
      </div>

      {/* Description */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{p.kpiLabel} · {monthLabel(p.period)}</p>
        {p.utr && <p className="text-[10px] text-gray-400 font-mono">UTR {p.utr}</p>}
        {!isPaid && (
          <span
            data-testid="payout-pending-badge"
            className="inline-block mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-100 rounded px-1.5 py-0.5"
          >
            Payout pending
          </span>
        )}
        {p.narration && (
          <p data-testid="payout-narration" className="text-[10px] text-gray-500 mt-0.5 leading-snug">{p.narration}</p>
        )}
      </div>

      {/* Amount — muted until the payout is actually paid. payoutAmountPaise is integer paise. */}
      <p className={`text-sm font-bold shrink-0 ${isPaid ? 'text-emerald-700' : 'text-gray-400'}`}>{fmtInr(p.payoutAmountPaise / 100)}</p>
    </div>
  );
}
