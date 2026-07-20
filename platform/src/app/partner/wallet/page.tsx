'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Coins, Calendar, X, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import { jsonToSheetSafe } from '@/lib/xlsx-safe';
import { Spinner } from '@/components/ui/spinner';
import { BalanceCard } from '@/components/wallet/balance-card';
import { TransactionItem } from '@/components/wallet/transaction-item';
import { PayoutStatementRow } from '@/components/wallet/payout-statement-row';
import { TransactionType, WalletBucket, type WalletBalance, type WalletTransaction } from '@/types';
import type { PayoutLedgerEntry } from '@/types';
import { usePartnerIdentity } from '@/lib/partner-identity';
import { authHeader } from '@/lib/api-client';


/* ─── API types & mappers (wallet wiring) ────────────────────────────────────── */

/** Exact shape returned by GET /api/wallet (flat — no nesting under .balance) */
interface ApiWalletBalance {
  earnedPoints:     number;
  lockedPoints:     number;
  redeemablePoints: number;
  redeemedPoints:   number;
  expiredPoints:    number;
  lifetimeEarned:   number;
  lifetimeRedeemed: number;
  currency:         string;
  conversionRate:   number;
}

/** Exact shape returned by each item in GET /api/wallet/transactions */
interface ApiWalletTransaction {
  id:              string;
  transactionType: string;   // e.g. 'CREDIT_POINTS_EARNED', 'DEBIT_REDEMPTION'
  description:     string;
  points:          number;   // signed or unsigned — always positive for CREDIT, positive for DEBIT
  date:            string;   // ISO string
  balanceType:     string;   // 'EARNED' | 'REDEEMED' | 'EXPIRED' | 'LOCKED'
  balanceAfter:    number;
  referenceType:   string | null;
  referenceId:     string | null;
  /** Credit FIELD NAME resolved from the batch (credit rows only; null otherwise). */
  fieldName?:      string | null;
  /** RAW upload narration (credit rows) — null/empty when the upload carried no note. */
  narration?:      string | null;
}

function mapTransactionType(apiType: string): TransactionType {
  if (apiType.startsWith('CREDIT'))                            return TransactionType.CREDIT;
  if (apiType.startsWith('DEBIT'))                             return TransactionType.DEBIT;
  if (apiType.includes('EXPIRE') || apiType.includes('EXPIR')) return TransactionType.EXPIRE;
  if (apiType.includes('UNLOCK'))                              return TransactionType.UNLOCK;
  if (apiType.includes('LOCK'))                                return TransactionType.LOCK;
  return TransactionType.CREDIT;
}

function mapBucket(balanceType: string): WalletBucket {
  if (balanceType === 'REDEEMED') return WalletBucket.REDEEMED;
  if (balanceType === 'EXPIRED')  return WalletBucket.EXPIRED;
  if (balanceType === 'LOCKED')   return WalletBucket.LOCKED;
  return WalletBucket.EARNED;
}

function mapApiBalance(api: ApiWalletBalance): WalletBalance {
  return {
    earned:     api.earnedPoints,
    locked:     api.lockedPoints,
    redeemable: api.redeemablePoints,
    redeemed:   api.redeemedPoints,
    expired:    api.expiredPoints,
    available:  api.redeemablePoints,
  };
}

function mapApiTransaction(t: ApiWalletTransaction): WalletTransaction {
  // Credit rows lead with the resolved FIELD NAME as the header and show the raw
  // upload narration as a small gray sub-line below (only when non-empty) — the
  // same treatment as the sales outlet ledger. Non-credit rows keep their own
  // description as the header and carry no field-name sub-line.
  const hasFieldName = !!t.fieldName;
  const header    = hasFieldName ? (t.fieldName as string) : t.description;
  const narration = hasFieldName && t.narration ? t.narration : undefined;

  return {
    id:             t.id,
    walletId:       'w1',
    userId:         'u1',
    type:           mapTransactionType(t.transactionType),
    bucket:         mapBucket(t.balanceType),
    amount:         t.points,
    balanceAfter:   t.balanceAfter,
    description:    header,
    schemeId:       t.referenceId,
    invoiceId:      null,
    // The KPI filter keys on the field name (the backend never populated kpiLabel).
    kpiLabel:       t.fieldName ?? undefined,
    narration,
    reversedById:   null,
    reversalReason: null,
    createdAt:      new Date(t.date),
  };
}

function fmtInr(n: number) { return `₹${n.toLocaleString('en-IN')}`; }
function monthLabel(period: string) {
  const [yr, mo] = period.split('-');
  return new Date(+yr, +mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/* ─── Helpers ─────────────────────────────────────────────────────────────────── */

function toMonthKey(d: Date): number  { return d.getFullYear() * 100 + (d.getMonth() + 1); }
function monthKeyToInput(key: number) { const yr = Math.floor(key/100); const mo = key%100; return `${yr}-${String(mo).padStart(2,'0')}`; }
function monthInputToKey(val: string) { const [yr,mo] = val.split('-'); return parseInt(yr,10)*100+parseInt(mo,10); }
const MONTH_SHORT = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function mkLabel(key: number) { return `${MONTH_SHORT[key%100]} ${Math.floor(key/100)}`; }
function rangeLabel(from: string, to: string) { const fk=monthInputToKey(from); const tk=monthInputToKey(to); return fk===tk?mkLabel(fk):`${mkLabel(fk)} – ${mkLabel(tk)}`; }
function isMainEntry(tx: WalletTransaction) { return tx.type===TransactionType.CREDIT||tx.type===TransactionType.DEBIT||tx.type===TransactionType.EXPIRE; }

/* ─── Combined statement row model ────────────────────────────────────────────
   The statement below the summary cards ALWAYS shows the FULL combined history —
   every points transaction AND every payout entry, newest first — regardless of
   which summary cards are shown. Each source row is normalised to a common shape
   for period filtering / KPI filtering / chronological sort, then rendered by its
   own presentational component (TransactionItem for points, a payout row for INR).
─────────────────────────────────────────────────────────────────────────────── */

// Points rows filter/label on the resolved credit FIELD NAME; payout rows keep
// their own kpiLabel. `label` is the unified filter key across both kinds.
type PointsRow = { kind: 'points'; date: Date; label?: string; tx: WalletTransaction };
type PayoutRow = { kind: 'payout'; date: Date; label?: string; entry: PayoutLedgerEntry };
type LedgerRow = PointsRow | PayoutRow;

function downloadCombinedStatement(rows: LedgerRow[], period: string) {
  const TYPE_LABEL: Record<string,string> = { CREDIT:'Credited', DEBIT:'Redeemed', EXPIRE:'Expired', LOCK:'On Hold', UNLOCK:'Released' };
  const sheetRows = rows.map((r) => {
    if (r.kind === 'points') {
      const tx = r.tx;
      return {
        Date: r.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
        Description: tx.description,
        Type: TYPE_LABEL[tx.type] ?? tx.type,
        Points: tx.type === TransactionType.CREDIT ? `+${tx.amount}` : `-${tx.amount}`,
        'Amount (₹)': '',
        UTR: '',
      };
    }
    const p = r.entry;
    return {
      Date: r.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      Description: `${p.kpiLabel} · ${monthLabel(p.period)}`,
      Type: p.status === 'PAID' ? 'Payout' : 'Payout (Pending)',
      Points: '',
      // payoutAmountPaise is integer paise; divide by 100 for the Excel sheet
      'Amount (₹)': p.payoutAmountPaise / 100,
      UTR: p.utr ?? '—',
    };
  });
  const ws = jsonToSheetSafe(sheetRows);
  ws['!cols'] = [{ wch: 16 }, { wch: 42 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Wallet Statement');
  XLSX.writeFile(wb, `wallet-statement-${period}.xlsx`);
}

const DEFAULT_FROM = '2026-05';
const DEFAULT_TO   = '2026-05';

/* ─── Points summary card ─────────────────────────────────────────────────────── */

function PointsSummary({ balance }: { balance: WalletBalance | null }) {
  if (!balance) return null;
  return <BalanceCard balance={balance} />;
}

/* ─── Payout (INR) summary card ───────────────────────────────────────────────── */

function PayoutSummary({ payouts }: { payouts: PayoutLedgerEntry[] }) {
  // Only confirmed PAID entries feed the lifetime/last-month figures.
  const paidEntries = useMemo(() => payouts.filter((p) => p.status === 'PAID'), [payouts]);
  // payoutAmountPaise is integer paise; accumulate in paise then divide for display
  const lifetimePaid = useMemo(() => paidEntries.reduce((s, p) => s + p.payoutAmountPaise, 0) / 100, [paidEntries]);
  const lastPaid = useMemo(() =>
    paidEntries.length > 0
      ? [...paidEntries].sort((a, b) => b.period.localeCompare(a.period))[0]
      : null,
  [paidEntries]);
  const lastMonthAmt   = (lastPaid?.payoutAmountPaise ?? 0) / 100;
  const lastMonthLabel = lastPaid ? monthLabel(lastPaid.period) : '—';

  return (
    <div data-testid="payout-summary" className="rounded-2xl p-5 text-white" style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)' }}>
      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Lifetime Payout Received</p>
      <p className="text-3xl font-extrabold mt-1 mb-4 tracking-tight">{fmtInr(lifetimePaid)}</p>
      <div className="bg-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] text-slate-400 font-medium">Last Month Payout</p>
          <p className="text-[10px] text-slate-500 mt-0.5">{lastMonthLabel}</p>
        </div>
        <p className="text-xl font-bold text-white">{fmtInr(lastMonthAmt)}</p>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function WalletPage() {
  const identity = usePartnerIdentity(); // REAL firm name + presence signals (replaces demo persona/track)

  const [balance,      setBalance]      = useState<WalletBalance | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [payouts,      setPayouts]      = useState<PayoutLedgerEntry[]>([]);
  const [loading,      setLoading]      = useState(true);

  /* Earn / Burn filter (points rows only) */
  const [earnBurnFilter, setEarnBurnFilter] = useState<'all' | 'earn' | 'burn'>('all');

  /* KPI filter */
  const [kpiFilter, setKpiFilter] = useState('');

  /* Date-range state */
  const [fromMonth,   setFromMonth]   = useState(DEFAULT_FROM);
  const [toMonth,     setToMonth]     = useState(DEFAULT_TO);
  const [pendingFrom, setPendingFrom] = useState(DEFAULT_FROM);
  const [pendingTo,   setPendingTo]   = useState(DEFAULT_TO);
  const [calOpen,     setCalOpen]     = useState(false);

  useEffect(() => {
    // Live data only — wallet summary + passbook + payouts from the backend (via the
    // Next proxy). No localStorage merge: the ledger is the single source of truth.
    // We fetch ALL three sources unconditionally so the combined statement below always
    // shows the full history (points AND payouts), independent of which cards are shown.
    Promise.all([
      fetch('/api/wallet', { headers: { ...authHeader() } }).then(r => r.json()).catch(() => null),
      fetch('/api/wallet/transactions', { headers: { ...authHeader() } }).then(r => r.json()).catch(() => null),
      fetch('/api/partner/payouts', { headers: { ...authHeader() } }).then(r => r.json()).catch(() => null),
    ]).then(([walletJson, txJson, payoutJson]) => {
      // Balance — API returns the flat {success,data} envelope; data is the
      // balance summary itself (earnedPoints, not nested under .balance).
      const hasApiBalance = walletJson?.success && walletJson.data?.earnedPoints !== undefined;
      if (hasApiBalance) {
        setBalance(mapApiBalance(walletJson.data as ApiWalletBalance));
      }

      // Transactions — straight from the passbook endpoint.
      const apiTxs =
        txJson?.success && Array.isArray(txJson.data?.transactions)
          ? (txJson.data.transactions as ApiWalletTransaction[]).map(mapApiTransaction)
          : [];
      if (apiTxs.length > 0) {
        setTransactions(apiTxs);
      }

      // Payouts — INR credit-payout ledger for the combined statement + payout card.
      const apiPayouts =
        payoutJson?.success && Array.isArray(payoutJson.data?.payouts)
          ? (payoutJson.data.payouts as PayoutLedgerEntry[])
          : [];
      if (apiPayouts.length > 0) {
        setPayouts(apiPayouts);
      }
    }).finally(() => setLoading(false));
  }, []);

  /* ── Normalise both sources into a single chronological ledger ── */

  // Points rows: only the "main" passbook entries (credit/debit/expire), matching
  // the prior points-track statement; lock/unlock housekeeping rows stay excluded.
  const pointsRows = useMemo<PointsRow[]>(
    () => transactions
      .filter(isMainEntry)
      // `tx.kpiLabel` now carries the resolved credit field name (see mapApiTransaction).
      .map((tx) => ({ kind: 'points', date: new Date(tx.createdAt), label: tx.kpiLabel, tx })),
    [transactions],
  );

  // Payout rows: every in-flight-or-paid payout entry (pending → paid, mirroring the
  // credit-payout lifecycle; FAILED/REVERSED are excluded by the backend). Dated by
  // paidAt once money has hit, else by uploadedAt (when the payout was added), else
  // the period's first day — so a pending row carries its real added-date.
  const payoutRows = useMemo<PayoutRow[]>(
    () => payouts
      .filter((p) => p.status !== 'FAILED')
      .map((p) => {
        const [yr, mo] = p.period.split('-');
        const date = p.paidAt ? new Date(p.paidAt)
          : p.uploadedAt ? new Date(p.uploadedAt)
          : new Date(+yr, +mo - 1, 1);
        return { kind: 'payout', date, label: p.kpiLabel, entry: p };
      }),
    [payouts],
  );

  const allRows = useMemo<LedgerRow[]>(() => [...pointsRows, ...payoutRows], [pointsRows, payoutRows]);

  /* Earliest and latest month across the COMBINED history */
  const [minMonth, maxMonth] = useMemo(() => {
    if (!allRows.length) return [DEFAULT_FROM, DEFAULT_TO];
    const keys = allRows.map((r) => toMonthKey(r.date));
    return [monthKeyToInput(Math.min(...keys)), monthKeyToInput(Math.max(...keys))];
  }, [allRows]);

  /* Period- + earn/burn-filtered rows (before the KPI filter) */
  const periodRows = useMemo(() => {
    const fromKey = monthInputToKey(fromMonth);
    const toKey   = monthInputToKey(toMonth);
    return allRows
      .filter((r) => { const k = toMonthKey(r.date); return k >= fromKey && k <= toKey; })
      .filter((r) => {
        // Earn/Burn applies to points rows; payout rows are inbound value → treated as "earn".
        if (earnBurnFilter === 'all') return true;
        if (r.kind === 'payout') return earnBurnFilter === 'earn';
        if (earnBurnFilter === 'earn') return r.tx.type === TransactionType.CREDIT;
        return r.tx.type === TransactionType.DEBIT || r.tx.type === TransactionType.EXPIRE;
      });
  }, [allRows, fromMonth, toMonth, earnBurnFilter]);

  /* KPI options — derived from the period rows; Visibility only for RETAILER/MT */
  const kpiOptions = useMemo(() => {
    const isVisibility = identity.outletType === 'SSS' || identity.outletType === 'SSS_TOT';
    return [...new Set(
      periodRows
        .map((r) => r.label)
        .filter((l): l is string => !!l && (isVisibility || l !== 'Visibility')),
    )];
  }, [periodRows, identity.outletType]);

  /* Rows to actually display — periodRows further filtered by kpiFilter, newest first */
  const displayedRows = useMemo(() => {
    const filtered = kpiFilter ? periodRows.filter((r) => r.label === kpiFilter) : periodRows;
    return [...filtered].sort((a, b) => +b.date - +a.date);
  }, [periodRows, kpiFilter]);

  const periodDisp = rangeLabel(fromMonth, toMonth);

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="text-lg font-bold text-gray-900">My Wallet</h1>
        <p className="text-xs text-gray-500 mt-0.5">{identity.businessName}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {/* ── Summary cards — presence-based (points, payout, or both) ── */}
          {identity.hasPointsActivity && <PointsSummary balance={balance} />}
          {identity.hasPayoutActivity && <PayoutSummary payouts={payouts} />}

          {/* ── Combined statement — ALWAYS the full history (points + payouts) ── */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-4 pt-3 pb-2 border-b border-gray-50 space-y-2">
              {/* Row 1: label + Excel + date picker */}
              <div data-testid="statement-controls-row" className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                  Statement · {periodDisp}
                </p>

              <div className="flex items-center gap-2">
                {/* Excel download — always present; disabled when nothing to export */}
                <button
                  data-testid="excel-btn"
                  onClick={() => { if (displayedRows.length > 0) downloadCombinedStatement(displayedRows, `${fromMonth}_${toMonth}`); }}
                  disabled={displayedRows.length === 0}
                  title="Download as Excel"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 bg-white text-gray-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-200 disabled:hover:text-gray-600"
                >
                  <Download className="h-3.5 w-3.5" />
                  Excel
                </button>

                <div className="relative">
                  <button
                    data-testid="period-picker-btn"
                    onClick={() => { setPendingFrom(fromMonth); setPendingTo(toMonth); setCalOpen(o => !o); }}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                      calOpen
                        ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <Calendar className="h-3.5 w-3.5" />
                    {periodDisp}
                  </button>

                  {calOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setCalOpen(false)} />
                      <div className="absolute top-full right-0 mt-2 bg-white rounded-2xl border border-gray-100 shadow-xl p-4 z-20 w-64">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-xs font-bold text-gray-800">Select Period</p>
                          <button onClick={() => setCalOpen(false)} className="p-1 rounded-full hover:bg-gray-100 text-gray-400">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="space-y-3">
                          <div>
                            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide block mb-1">From</label>
                            <input type="month" value={pendingFrom} min={minMonth} max={pendingTo}
                              onChange={e => setPendingFrom(e.target.value)}
                              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide block mb-1">To</label>
                            <input type="month" value={pendingTo} min={pendingFrom} max={maxMonth}
                              onChange={e => setPendingTo(e.target.value)}
                              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2 mt-4">
                          <button
                            onClick={() => { setPendingFrom(DEFAULT_FROM); setPendingTo(DEFAULT_TO); setFromMonth(DEFAULT_FROM); setToMonth(DEFAULT_TO); setCalOpen(false); }}
                            className="flex-1 py-2 border border-gray-200 text-gray-500 rounded-xl text-xs font-semibold hover:bg-gray-50 transition-colors"
                          >
                            Reset
                          </button>
                          <button
                            onClick={() => { setFromMonth(pendingFrom); setToMonth(pendingTo); setCalOpen(false); }}
                            className="flex-1 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-xs font-semibold hover:bg-[var(--brand-primary-dark)] transition-colors"
                          >
                            Apply
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
              </div>

              {/* Earn / Burn filter chips + KPI filter */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {([
                  { value: 'all',  label: 'All'  },
                  { value: 'earn', label: 'Earn' },
                  { value: 'burn', label: 'Burn' },
                ] as const).map((f) => (
                  <button
                    key={f.value}
                    onClick={() => setEarnBurnFilter(f.value)}
                    className={`px-3 py-1 rounded-full text-[10px] font-semibold border transition-all ${
                      earnBurnFilter === f.value
                        ? f.value === 'earn'
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : f.value === 'burn'
                          ? 'bg-red-500 text-white border-red-500'
                          : 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
                {/* KPI filter */}
                <select
                  data-testid="wallet-kpi-filter"
                  value={kpiFilter}
                  onChange={(e) => setKpiFilter(e.target.value)}
                  className="px-2 py-1 rounded-lg text-[10px] border border-gray-200 bg-white text-gray-600 focus:outline-none focus:border-[var(--brand-primary)]"
                >
                  <option value="">All Parameters</option>
                  {kpiOptions.map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </select>
                <span className="ml-auto text-[10px] text-gray-400">{displayedRows.length} entries</span>
              </div>
            </div>

            {displayedRows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12">
                <Coins className="h-8 w-8 text-gray-200" />
                <p className="text-sm text-gray-400">No transactions for this period</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50 px-4">
                {displayedRows.map((r) =>
                  r.kind === 'points' ? (
                    <TransactionItem key={`pts-${r.tx.id}`} transaction={r.tx} />
                  ) : (
                    <PayoutStatementRow key={`pay-${r.entry.id}`} entry={r.entry} />
                  ),
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

