'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Coins, Calendar, X, Download, Banknote } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Spinner } from '@/components/ui/spinner';
import { BalanceCard } from '@/components/wallet/balance-card';
import { TransactionItem } from '@/components/wallet/transaction-item';
import { formatPoints } from '@/lib/utils';
import { TransactionType, WalletBucket, type WalletBalance, type WalletTransaction } from '@/types';
import type { PayoutLedgerEntry } from '@/types';
import { usePartnerSession } from '@/lib/partner-session';
import { loadRedemptions } from '@/lib/redemption-store';

/* ─── Mock data — POINTS track ───────────────────────────────────────────────── */

const MOCK_BALANCE: WalletBalance = {
  earned:     8_550,
  locked:     0,
  redeemable: 4_250,
  redeemed:   3_100,
  expired:      500,
  available:  4_250,
};

const MOCK_TRANSACTIONS: WalletTransaction[] = [
  { id: 't1',  walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   200, balanceAfter: 4_250, description: 'Monthly Target — May 2026',      schemeId: '1',  kpiLabel: 'Monthly Target',    invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-14'), narration: 'May secondary billing verified against submitted invoices.' },
  { id: 't1b', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:    80, balanceAfter: 4_330, description: 'Consistency — May 2026',         schemeId: '1',  kpiLabel: 'Consistency',       invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-14') },
  { id: 't2',  walletId: 'w1', userId: 'u1', type: TransactionType.DEBIT,  bucket: WalletBucket.REDEEMED, amount:   500, balanceAfter: 4_050, description: 'Redemption – Amazon voucher ₹500', schemeId: null, invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-10') },
  { id: 't3',  walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   350, balanceAfter: 4_550, description: 'Monthly Target — Apr 2026',      schemeId: '1',  kpiLabel: 'Monthly Target',    invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-08'), narration: 'Apr billing confirmed. Full payout released.' },
  { id: 't3b', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   120, balanceAfter: 4_670, description: 'Focus Product 1 — Apr 2026',     schemeId: '1',  kpiLabel: 'Focus Product 1',   invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-08') },
  { id: 't3c', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:    90, balanceAfter: 4_760, description: 'Focus Product 2 — Apr 2026',     schemeId: '1',  kpiLabel: 'Focus Product 2',   invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-08'), narration: 'New SKU push target met for April.' },
  { id: 't5',  walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   100, balanceAfter: 4_500, description: 'Visibility — Apr 2026',          schemeId: '2',  kpiLabel: 'Visibility',        invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-05') },
  { id: 't7',  walletId: 'w1', userId: 'u1', type: TransactionType.DEBIT,  bucket: WalletBucket.REDEEMED, amount: 1_000, balanceAfter: 3_950, description: 'Redemption – bank transfer',       schemeId: null, invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-04-20') },
  { id: 't9',  walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   600, balanceAfter: 4_950, description: 'Monthly Target — Mar 2026',      schemeId: '1',  kpiLabel: 'Monthly Target',    invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-04-15') },
  { id: 't9b', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   150, balanceAfter: 5_100, description: 'Promo Pack — Mar 2026',          schemeId: '1',  kpiLabel: 'Promo Pack',        invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-04-15'), narration: 'Q1 promo pack offtake target achieved.' },
  { id: 't9c', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:    60, balanceAfter: 5_160, description: 'Lines — Mar 2026',               schemeId: '1',  kpiLabel: 'Lines',             invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-04-15'), narration: 'Minimum 8 SKU lines stocked and invoiced.' },
  { id: 't10', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   250, balanceAfter: 4_350, description: 'Differential Margin — Apr 2026', schemeId: '1',  kpiLabel: 'Differential Margin', invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-04-10') },
  { id: 't8',  walletId: 'w1', userId: 'u1', type: TransactionType.EXPIRE, bucket: WalletBucket.EXPIRED,  amount:   500, balanceAfter: 4_950, description: 'Points expired – Q4 FY25 scheme', schemeId: null, invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-03-31') },
  { id: 't11', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   450, balanceAfter: 5_450, description: 'Monthly Target — Feb 2026',      schemeId: '1',  kpiLabel: 'Monthly Target',    invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-03-25') },
  { id: 't11b',walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:    75, balanceAfter: 5_525, description: 'Others — Feb 2026',              schemeId: '1',  kpiLabel: 'Others',            invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-03-25'), narration: 'One-time incentive for participation in brand event.' },
  { id: 't12', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED,   amount:   320, balanceAfter: 5_000, description: 'Monthly Target — Jan 2026',      schemeId: '1',  kpiLabel: 'Monthly Target',    invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-03-15') },
];

/* ─── Mock data — INR track ──────────────────────────────────────────────────── */

const MOCK_INR_PAYOUTS: Record<string, PayoutLedgerEntry[]> = {
  o2: [
    { id: 'p1',    period: '2026-04', kpiLabel: 'Monthly Target',  achievedPct: 102, payoutAmountInr: 8_000, uploadedAt: '2026-05-03', utr: '506210001234', paidAt: '2026-05-05', status: 'PAID',       narration: 'Apr secondary billing verified against submitted invoices.' },
    { id: 'p2',    period: '2026-05', kpiLabel: 'Monthly Target',  achievedPct: 100, payoutAmountInr: 4_500, uploadedAt: '2026-05-28', status: 'PROCESSING' },
    { id: 'p3',    period: '2026-03', kpiLabel: 'Monthly Target',  achievedPct: 100, payoutAmountInr: 7_500, uploadedAt: '2026-04-04', utr: '506210000987', paidAt: '2026-04-06', status: 'PAID',       narration: 'Mar billing confirmed. Full payout released.' },
    { id: 'p4',    period: '2026-02', kpiLabel: 'Monthly Target',  achievedPct: 98,  payoutAmountInr: 0,     uploadedAt: '2026-03-03', status: 'FAILED',     narration: 'Target achievement fell below 100% threshold — payout not applicable.' },
    { id: 'p_vis', period: '2026-04', kpiLabel: 'Visibility',      achievedPct: 100, payoutAmountInr: 1_500, uploadedAt: '2026-05-03', utr: '506210009999', paidAt: '2026-05-04', status: 'PAID'       },
    { id: 'p_con', period: '2026-04', kpiLabel: 'Consistency',     achievedPct: 100, payoutAmountInr: 2_000, uploadedAt: '2026-05-03', utr: '506210008888', paidAt: '2026-05-05', status: 'PAID',       narration: 'Consistent ordering across all 4 weeks of April.' },
    { id: 'p_fp1', period: '2026-03', kpiLabel: 'Focus Product 1', achievedPct: 100, payoutAmountInr: 1_200, uploadedAt: '2026-04-04', utr: '506210007777', paidAt: '2026-04-06', status: 'PAID'       },
    { id: 'p_fp2', period: '2026-03', kpiLabel: 'Focus Product 2', achievedPct: 100, payoutAmountInr:   800, uploadedAt: '2026-04-04', utr: '506210006666', paidAt: '2026-04-06', status: 'PAID'       },
    { id: 'p_promo', period: '2026-03', kpiLabel: 'Promo Pack',    achievedPct: 100, payoutAmountInr: 3_000, uploadedAt: '2026-04-04', utr: '506210005555', paidAt: '2026-04-06', status: 'PAID',       narration: 'Q1 promo pack offtake target achieved.' },
  ],
  o3: [
    { id: 'p5',    period: '2026-05', kpiLabel: 'Monthly Target',       achievedPct: 100, payoutAmountInr: 7_200, uploadedAt: '2026-05-25', status: 'PROCESSING' },
    { id: 'p6',    period: '2026-04', kpiLabel: 'Monthly Target',       achievedPct: 100, payoutAmountInr: 6_800, uploadedAt: '2026-05-02', utr: '506210002345', paidAt: '2026-05-04', status: 'PAID' },
    { id: 'p6b',   period: '2026-04', kpiLabel: 'Lines',                achievedPct: 100, payoutAmountInr: 1_000, uploadedAt: '2026-05-02', utr: '506210002346', paidAt: '2026-05-04', status: 'PAID',   narration: 'Minimum 8 SKU lines stocked and invoiced.' },
    { id: 'p6c',   period: '2026-04', kpiLabel: 'Differential Margin',  achievedPct: 100, payoutAmountInr: 1_500, uploadedAt: '2026-05-02', utr: '506210002347', paidAt: '2026-05-04', status: 'PAID' },
  ],
  o4: [
    { id: 'p7',    period: '2026-05', kpiLabel: 'Monthly Target',       achievedPct: 100, payoutAmountInr: 25_000, uploadedAt: '2026-05-28', status: 'PENDING'    },
    { id: 'p8',    period: '2026-04', kpiLabel: 'Monthly Target',       achievedPct: 105, payoutAmountInr: 20_000, uploadedAt: '2026-05-02', utr: '506210005678', paidAt: '2026-05-04', status: 'PAID', narration: 'Overachievement bonus applied at 105% slab.'  },
    { id: 'p8b',   period: '2026-04', kpiLabel: 'Focus Product 3',      achievedPct: 100, payoutAmountInr:  5_000, uploadedAt: '2026-05-02', utr: '506210005679', paidAt: '2026-05-04', status: 'PAID' },
    { id: 'p8c',   period: '2026-04', kpiLabel: 'Liquidation',          achievedPct: 100, payoutAmountInr:  2_500, uploadedAt: '2026-05-02', utr: '506210005680', paidAt: '2026-05-04', status: 'PAID', narration: 'Old batch liquidated before expiry cutoff.' },
    { id: 'p9',    period: '2026-03', kpiLabel: 'Monthly Target',       achievedPct: 100, payoutAmountInr: 20_000, uploadedAt: '2026-04-03', utr: '506210004321', paidAt: '2026-04-05', status: 'PAID' },
    { id: 'p9b',   period: '2026-03', kpiLabel: 'Others',               achievedPct: 100, payoutAmountInr:  1_000, uploadedAt: '2026-04-03', utr: '506210004322', paidAt: '2026-04-05', status: 'PAID', narration: 'One-time incentive for participation in brand event.' },
  ],
};

function fmtInr(n: number) { return `₹${n.toLocaleString('en-IN')}`; }
function monthLabel(period: string) {
  const [yr, mo] = period.split('-');
  return new Date(+yr, +mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function downloadInrStatement(entries: PayoutLedgerEntry[], period: string) {
  const rows = entries.map(p => ({
    Date:          p.paidAt ? new Date(p.paidAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
    Description:   `${p.kpiLabel} · ${monthLabel(p.period)}`,
    'Amount (₹)':  p.payoutAmountInr,
    UTR:           p.utr ?? '—',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 16 }, { wch: 38 }, { wch: 14 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payout Statement');
  XLSX.writeFile(wb, `inr-payouts-${period}.xlsx`);
}

/* ─── Helpers — POINTS track ─────────────────────────────────────────────────── */

function toMonthKey(d: Date): number  { return d.getFullYear() * 100 + (d.getMonth() + 1); }
function monthKeyToInput(key: number) { const yr = Math.floor(key/100); const mo = key%100; return `${yr}-${String(mo).padStart(2,'0')}`; }
function monthInputToKey(val: string) { const [yr,mo] = val.split('-'); return parseInt(yr,10)*100+parseInt(mo,10); }
const MONTH_SHORT = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function mkLabel(key: number) { return `${MONTH_SHORT[key%100]} ${Math.floor(key/100)}`; }
function rangeLabel(from: string, to: string) { const fk=monthInputToKey(from); const tk=monthInputToKey(to); return fk===tk?mkLabel(fk):`${mkLabel(fk)} – ${mkLabel(tk)}`; }
function isMainEntry(tx: WalletTransaction) { return tx.type===TransactionType.CREDIT||tx.type===TransactionType.DEBIT||tx.type===TransactionType.EXPIRE; }

function downloadStatement(txs: WalletTransaction[], period: string) {
  const TYPE_LABEL: Record<string,string> = { CREDIT:'Credited', DEBIT:'Redeemed', EXPIRE:'Expired', LOCK:'On Hold', UNLOCK:'Released' };
  const rows = txs.map(tx => ({
    Date: new Date(tx.createdAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}),
    Description: tx.description,
    Type: TYPE_LABEL[tx.type] ?? tx.type,
    Points: tx.type===TransactionType.CREDIT ? `+${tx.amount}` : `-${tx.amount}`,
    'Balance After': tx.balanceAfter,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:16},{wch:45},{wch:12},{wch:10},{wch:14}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Points Statement');
  XLSX.writeFile(wb, `points-statement-${period}.xlsx`);
}

const DEFAULT_FROM = '2026-05';
const DEFAULT_TO   = '2026-05';

/* ─── INR Wallet View ────────────────────────────────────────────────────────── */

function InrWalletView({ outletId }: { outletId: string }) {
  const allPayouts = useMemo(() => MOCK_INR_PAYOUTS[outletId] ?? [], [outletId]);

  // Only confirmed PAID entries are relevant
  const paidEntries = useMemo(() => allPayouts.filter(p => p.status === 'PAID'), [allPayouts]);

  // Period bounds derived from PAID entries
  const [minPeriod, maxPeriod] = useMemo(() => {
    const ps = paidEntries.map(p => p.period).sort();
    return ps.length ? [ps[0], ps[ps.length - 1]] : ['2026-01', '2026-05'];
  }, [paidEntries]);

  // Period filter state — default to full range
  const [fromPeriod,  setFromPeriod]  = useState(minPeriod);
  const [toPeriod,    setToPeriod]    = useState(maxPeriod);
  const [pendingFrom, setPendingFrom] = useState(minPeriod);
  const [pendingTo,   setPendingTo]   = useState(maxPeriod);
  const [calOpen,     setCalOpen]     = useState(false);

  // Summary card figures — always unfiltered (lifetime = all time)
  const lifetimePaid = useMemo(() => paidEntries.reduce((s, p) => s + p.payoutAmountInr, 0), [paidEntries]);
  const lastPaid     = useMemo(() =>
    paidEntries.length > 0
      ? [...paidEntries].sort((a, b) => b.period.localeCompare(a.period))[0]
      : null,
  [paidEntries]);
  const lastMonthAmt   = lastPaid?.payoutAmountInr ?? 0;
  const lastMonthLabel = lastPaid ? monthLabel(lastPaid.period) : '—';

  // KPI filter
  const [kpiFilter, setKpiFilter] = useState('');

  // Distinct KPI labels from all PAID entries (for the dropdown options)
  const kpiOptions = useMemo(() => [...new Set(paidEntries.map(p => p.kpiLabel))], [paidEntries]);

  // Statement — period-filtered, KPI-filtered, newest first
  const ledgerEntries = useMemo(() => {
    const periodFiltered = paidEntries
      .filter(p => p.period >= fromPeriod && p.period <= toPeriod)
      .sort((a, b) => b.period.localeCompare(a.period));
    if (!kpiFilter) return periodFiltered;
    return periodFiltered.filter(p => p.kpiLabel === kpiFilter);
  }, [paidEntries, fromPeriod, toPeriod, kpiFilter]);

  const periodDisp = rangeLabel(fromPeriod, toPeriod);

  return (
    <div className="space-y-5">

      {/* Summary card — dark, matching wholesale style */}
      <div className="rounded-2xl p-5 text-white" style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)' }}>
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

      {/* Payout statement */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 pt-3 pb-2 border-b border-gray-50 space-y-2">
          {/* Row 1: label + Excel + date picker */}
          <div data-testid="statement-controls-row" className="flex items-center justify-between">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
              Statement · {periodDisp}
            </p>

          <div className="flex items-center gap-2">
            {/* Excel download */}
            {ledgerEntries.length > 0 && (
              <button
                data-testid="excel-btn"
                onClick={() => downloadInrStatement(ledgerEntries, `${fromPeriod}_${toPeriod}`)}
                title="Download as Excel"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 bg-white text-gray-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-all"
              >
                <Download className="h-3.5 w-3.5" />
                Excel
              </button>
            )}

            {/* Period picker */}
            <div className="relative">
              <button
                data-testid="period-picker-btn"
                onClick={() => { setPendingFrom(fromPeriod); setPendingTo(toPeriod); setCalOpen(o => !o); }}
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
                        <input type="month" value={pendingFrom} min={minPeriod} max={pendingTo}
                          onChange={e => setPendingFrom(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide block mb-1">To</label>
                        <input type="month" value={pendingTo} min={pendingFrom} max={maxPeriod}
                          onChange={e => setPendingTo(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <button
                        onClick={() => {
                          setPendingFrom(minPeriod); setPendingTo(maxPeriod);
                          setFromPeriod(minPeriod);  setToPeriod(maxPeriod);
                          setCalOpen(false);
                        }}
                        className="flex-1 py-2 border border-gray-200 text-gray-500 rounded-xl text-xs font-semibold hover:bg-gray-50 transition-colors"
                      >
                        Reset
                      </button>
                      <button
                        onClick={() => { setFromPeriod(pendingFrom); setToPeriod(pendingTo); setCalOpen(false); }}
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
          </div>{/* /statement-controls-row */}

          {/* Row 2: KPI filter */}
          <div className="flex items-center gap-1.5">
            <select
              data-testid="wallet-kpi-filter"
              value={kpiFilter}
              onChange={(e) => setKpiFilter(e.target.value)}
              className="px-2 py-1.5 rounded-xl text-xs border border-gray-200 bg-white text-gray-600 focus:outline-none focus:border-[var(--brand-primary)]"
            >
              <option value="">All Parameters</option>
              {kpiOptions.map((label) => (
                <option key={label} value={label}>{label}</option>
              ))}
            </select>
          </div>
        </div>{/* /space-y-2 outer wrapper */}

        {ledgerEntries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12">
            <Banknote className="h-8 w-8 text-gray-200" />
            <p className="text-sm text-gray-400">No payouts for this period</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {ledgerEntries.map(p => {
              // Date block data
              const d     = p.paidAt ? new Date(p.paidAt) : null;
              const day   = d ? String(d.getDate()).padStart(2, '0') : '—';
              const mon   = d ? MONTH_SHORT[d.getMonth() + 1] : '';

              return (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3.5">

                  {/* Date chip — replaces icon */}
                  <div className="w-10 h-10 rounded-xl bg-gray-50 border border-gray-100 flex flex-col items-center justify-center shrink-0">
                    <span className="text-sm font-bold text-gray-800 leading-none">{day}</span>
                    <span className="text-[9px] text-gray-400 font-semibold uppercase mt-0.5">{mon}</span>
                  </div>

                  {/* Description */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{p.kpiLabel} · {monthLabel(p.period)}</p>
                    {p.utr && <p className="text-[10px] text-gray-400 font-mono">UTR {p.utr}</p>}
                    {p.narration && (
                      <p data-testid="payout-narration" className="text-[10px] text-gray-500 mt-0.5 leading-snug">{p.narration}</p>
                    )}
                  </div>

                  {/* Amount */}
                  <p className="text-sm font-bold text-emerald-700 shrink-0">{fmtInr(p.payoutAmountInr)}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function WalletPage() {
  const session = usePartnerSession();

  const [balance,      setBalance]      = useState<WalletBalance | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [loading,      setLoading]      = useState(true);

  /* Earn / Burn filter */
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
    const t = setTimeout(() => {
      const stored = loadRedemptions();
      const storedTotal = stored.reduce((s, r) => s + r.points, 0);

      setBalance({
        ...MOCK_BALANCE,
        redeemable: Math.max(0, MOCK_BALANCE.redeemable - storedTotal),
        available:  Math.max(0, MOCK_BALANCE.available  - storedTotal),
        redeemed:   MOCK_BALANCE.redeemed + storedTotal,
      });

      // Sort oldest-first so we can compute a correct running balance for each entry
      const sortedStored = [...stored].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      // Running balance starts at MOCK_BALANCE.redeemable (pre-session baseline)
      // and is decremented for each stored redemption in chronological order.
      let runningBal = MOCK_BALANCE.redeemable;
      const storedTxs: WalletTransaction[] = sortedStored.map((r) => {
        runningBal = Math.max(0, runningBal - r.points);
        return {
          id:             r.id,
          walletId:       'w1',
          userId:         'u1',
          type:           TransactionType.DEBIT,
          bucket:         WalletBucket.REDEEMED,
          amount:         r.points,
          balanceAfter:   runningBal,   // ← correct balance after this redemption
          description:    r.description,
          schemeId:       null,
          invoiceId:      null,
          reversedById:   null,
          reversalReason: null,
          createdAt:      new Date(r.createdAt),
        };
      });

      setTransactions([...storedTxs, ...MOCK_TRANSACTIONS]);
      setLoading(false);
    }, 450);
    return () => clearTimeout(t);
  }, []);

  /* Earliest and latest month in data */
  const [minMonth, maxMonth] = useMemo(() => {
    if (!transactions.length) return [DEFAULT_FROM, DEFAULT_TO];
    const keys = transactions.map(tx => toMonthKey(new Date(tx.createdAt)));
    return [monthKeyToInput(Math.min(...keys)), monthKeyToInput(Math.max(...keys))];
  }, [transactions]);

  /* Filtered main statement */
  const mainTxs = useMemo(() => {
    const fromKey = monthInputToKey(fromMonth);
    const toKey   = monthInputToKey(toMonth);
    return transactions
      .filter(isMainEntry)
      .filter(tx => { const k = toMonthKey(new Date(tx.createdAt)); return k >= fromKey && k <= toKey; })
      .filter(tx => {
        if (earnBurnFilter === 'earn') return tx.type === TransactionType.CREDIT;
        if (earnBurnFilter === 'burn') return tx.type === TransactionType.DEBIT || tx.type === TransactionType.EXPIRE;
        return true;
      })
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [transactions, fromMonth, toMonth, earnBurnFilter]);

  /* KPI options — derived from period transactions; Visibility only for RETAILER/MT */
  const kpiOptions = useMemo(() => {
    const isVisibility = session.outletType === 'SSS' || session.outletType === 'SSS_TOT';
    return [...new Set(
      mainTxs
        .map((tx) => tx.kpiLabel)
        .filter((l): l is string => !!l && (isVisibility || l !== 'Visibility')),
    )];
  }, [mainTxs, session.outletType]);

  /* Transactions to actually display — mainTxs further filtered by kpiFilter */
  const displayedTxs = useMemo(() => {
    if (!kpiFilter) return mainTxs;
    return mainTxs.filter((tx) => tx.kpiLabel === kpiFilter);
  }, [mainTxs, kpiFilter]);

  const periodDisp = rangeLabel(fromMonth, toMonth);

  /* ── INR outlets get the INR wallet view ── */
  if (session.track === 'INR') {
    return (
      <div className="space-y-5 fade-in">
        <div>
          <h1 className="text-lg font-bold text-gray-900">My Wallet</h1>
          <p className="text-xs text-gray-500 mt-0.5">Incentive payouts for {session.firmName}</p>
        </div>
        <InrWalletView outletId={session.outletId} />
      </div>
    );
  }

  /* ── POINTS track ── */
  return (
    <div className="space-y-5 fade-in">
      <h1 className="text-xl font-bold text-gray-900">My Wallet</h1>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {balance && <BalanceCard balance={balance} />}


          {/* Main statement */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-4 pt-3 pb-2 border-b border-gray-50 space-y-2">
              {/* Row 1: label + Excel + date picker */}
              <div data-testid="statement-controls-row" className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                  Statement · {periodDisp}
                </p>

              <div className="flex items-center gap-2">
                {mainTxs.length > 0 && (
                  <button
                    data-testid="excel-btn"
                    onClick={() => downloadStatement(mainTxs, `${fromMonth}_${toMonth}`)}
                    title="Download as Excel"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 bg-white text-gray-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-all"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Excel
                  </button>
                )}

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
                <span className="ml-auto text-[10px] text-gray-400">{displayedTxs.length} entries</span>
              </div>
            </div>

            {displayedTxs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12">
                <Coins className="h-8 w-8 text-gray-200" />
                <p className="text-sm text-gray-400">No transactions for this period</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50 px-4">
                {displayedTxs.map(tx => (
                  <TransactionItem key={tx.id} transaction={tx} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
