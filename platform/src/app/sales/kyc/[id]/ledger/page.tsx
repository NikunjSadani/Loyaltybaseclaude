'use client';

import React, { useState, useEffect, useMemo, use } from 'react';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Calendar, X, Download, Coins } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Spinner } from '@/components/ui/spinner';
import { TransactionItem } from '@/components/wallet/transaction-item';
import { TransactionType, WalletBucket, type WalletTransaction } from '@/types';

/* ─── Types ─────────────────────────────────────────────────────────────────── */

type TxType = 'earn' | 'redeem' | 'hold' | 'expire' | 'credit';

interface LedgerEntry {
  id: string;
  date: string;        // YYYY-MM-DD
  description: string;
  type: TxType;
  points: number;      // positive = credit, negative = debit
  balance: number;
  ref?: string;
  /** KPI that generated this earn entry; undefined for redemptions, holds, credits */
  kpiLabel?: string;
}

interface OutletMeta {
  name: string;
  outletCode: string;
  mobile: string;
  balance: number;
  lifetime: number;
  redeemed: number;
}

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const OUTLET_MAP: Record<string, string> = { o1: 'k1', o2: 'k2', o3: 'k3', o4: 'k4', o5: 'k5' };

const OUTLET_META: Record<string, OutletMeta> = {
  k1: { name: 'Kumar General Store', outletCode: 'OUT-MH-2841', mobile: '9876543210', balance: 3_240, lifetime: 8_550, redeemed: 5_310 },
  k2: { name: 'Sharma Kirana',       outletCode: 'OUT-MH-2842', mobile: '9765432109', balance:   820, lifetime: 1_200, redeemed:   380 },
  k3: { name: 'Patel Grocery',       outletCode: 'OUT-MH-2843', mobile: '9654321098', balance:   145, lifetime:   600, redeemed:   455 },
  k4: { name: 'Singh Supermart',     outletCode: 'OUT-MH-2844', mobile: '9543210987', balance: 5_900, lifetime: 12_100,redeemed: 6_200 },
  k5: { name: 'Mehta Provisions',    outletCode: 'OUT-MH-2845', mobile: '9432109876', balance: 1_060, lifetime: 1_060, redeemed:     0 },
};

const LEDGER_DATA: Record<string, LedgerEntry[]> = {
  k1: [
    { id: 'l1',  date: '2026-05-14', description: 'Invoice #INV-2026-0183 — Volume bonus',    type: 'earn',   points:  +400, balance: 3_240, ref: 'INV-2026-0183', kpiLabel: 'Secondary Sales Target' },
    { id: 'l2',  date: '2026-05-10', description: 'Visibility display — Andheri outlet',       type: 'earn',   points:  +200, balance: 2_840, ref: 'VIS-0092',       kpiLabel: 'Visibility'             },
    { id: 'l3',  date: '2026-05-01', description: 'Redeemed — Bluetooth Speaker (2500 pts)',   type: 'redeem', points: -2_500, balance: 2_640, ref: 'RDM-0041' },
    { id: 'l4',  date: '2026-04-28', description: 'Invoice #INV-2026-0149 — Purchase earn',    type: 'earn',   points: +1_800, balance: 5_140, ref: 'INV-2026-0149', kpiLabel: 'Secondary Sales Target' },
    { id: 'l5',  date: '2026-04-15', description: 'KYC verification bonus',                    type: 'credit', points:  +500, balance: 3_340 },
    { id: 'l6',  date: '2026-04-10', description: 'Invoice #INV-2026-0112 — Purchase earn',    type: 'earn',   points:  +900, balance: 2_840, ref: 'INV-2026-0112', kpiLabel: 'Secondary Sales Target' },
    { id: 'l7',  date: '2026-03-30', description: 'Points on hold — scheme audit',              type: 'hold',   points:  -300, balance: 1_940 },
    { id: 'l8',  date: '2026-03-28', description: 'Invoice #INV-2026-0098 — Purchase earn',    type: 'earn',   points: +1_200, balance: 2_240, ref: 'INV-2026-0098', kpiLabel: 'Secondary Sales Target' },
    { id: 'l9',  date: '2026-03-15', description: 'Redeemed — Amazon Voucher ₹500 (500 pts)',  type: 'redeem', points:  -500, balance: 1_040, ref: 'RDM-0029' },
    { id: 'l10', date: '2026-03-01', description: 'Invoice #INV-2026-0072 — Volume bonus',     type: 'earn',   points:  +600, balance: 1_540, ref: 'INV-2026-0072', kpiLabel: 'Secondary Sales Target' },
  ],
  k2: [
    { id: 'l1', date: '2026-05-10', description: 'Invoice #INV-2026-0177 — Purchase earn',     type: 'earn',   points:  +400, balance:   820, ref: 'INV-2026-0177' },
    { id: 'l2', date: '2026-04-22', description: 'Invoice #INV-2026-0130 — Purchase earn',     type: 'earn',   points:  +420, balance:   420, ref: 'INV-2026-0130' },
  ],
  k3: [
    { id: 'l1', date: '2026-04-20', description: 'Invoice #INV-2026-0118 — Purchase earn',     type: 'earn',   points:  +300, balance:   145 },
    { id: 'l2', date: '2026-04-05', description: 'Redeemed — Shopping voucher (150 pts)',       type: 'redeem', points:  -155, balance:  -155, ref: 'RDM-0018' },
  ],
  k4: [
    { id: 'l1', date: '2026-05-12', description: 'Invoice #INV-2026-0180 — Platinum volume',  type: 'earn',   points: +1_500, balance: 5_900, ref: 'INV-2026-0180' },
    { id: 'l2', date: '2026-05-05', description: 'Redeemed — Smart Watch (3000 pts)',          type: 'redeem', points: -3_000, balance: 4_400, ref: 'RDM-0055' },
    { id: 'l3', date: '2026-04-30', description: 'Invoice #INV-2026-0162 — Purchase earn',    type: 'earn',   points: +2_200, balance: 7_400, ref: 'INV-2026-0162' },
    { id: 'l4', date: '2026-04-15', description: 'Invoice #INV-2026-0141 — Quarterly bonus',  type: 'earn',   points: +1_800, balance: 5_200, ref: 'INV-2026-0141' },
    { id: 'l5', date: '2026-04-01', description: 'Redeemed — Dinner Voucher (500 pts)',        type: 'redeem', points:  -500, balance: 3_400, ref: 'RDM-0044' },
    { id: 'l6', date: '2026-03-15', description: 'Invoice #INV-2026-0099 — Purchase earn',    type: 'earn',   points: +1_000, balance: 3_900, ref: 'INV-2026-0099' },
  ],
  k5: [
    { id: 'l1', date: '2026-05-14', description: 'Invoice #INV-2026-0185 — Purchase earn',    type: 'earn',   points:  +600, balance: 1_060, ref: 'INV-2026-0185' },
    { id: 'l2', date: '2026-05-08', description: 'KYC onboarding bonus',                       type: 'credit', points:  +200, balance:   460 },
    { id: 'l3', date: '2026-05-03', description: 'Invoice #INV-2026-0170 — Purchase earn',    type: 'earn',   points:  +260, balance:   260, ref: 'INV-2026-0170' },
  ],
};

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

/** Map the ledger's local TxType to TransactionType so we can reuse TransactionItem */
function toWalletTx(entry: LedgerEntry): WalletTransaction & { _ref?: string } {
  let type: TransactionType;
  if      (entry.type === 'earn' || entry.type === 'credit') type = TransactionType.CREDIT;
  else if (entry.type === 'redeem')                          type = TransactionType.DEBIT;
  else if (entry.type === 'expire')                          type = TransactionType.EXPIRE;
  else /* hold */                                            type = TransactionType.LOCK;

  return {
    id:             entry.id,
    walletId:       '',
    userId:         '',
    type,
    bucket:         WalletBucket.EARNED,
    amount:         Math.abs(entry.points),
    balanceAfter:   entry.balance,
    description:    entry.description,
    schemeId:       null,
    invoiceId:      null,
    reversedById:   null,
    reversalReason: null,
    createdAt:      new Date(entry.date),
    _ref:           entry.ref,
  };
}

type EarnBurnFilter = 'all' | 'earn' | 'burn';
const EARN_TYPES = new Set<TxType>(['earn', 'credit']);
const BURN_TYPES = new Set<TxType>(['redeem', 'expire', 'hold']);

function txDateToMonthKey(dateStr: string): number {
  const [yr, mo] = dateStr.split('-');
  return parseInt(yr, 10) * 100 + parseInt(mo, 10);
}
function inputToKey(val: string): number {
  const [yr, mo] = val.split('-');
  return parseInt(yr, 10) * 100 + parseInt(mo, 10);
}
function keyToInput(key: number): string {
  const yr = Math.floor(key / 100);
  const mo = key % 100;
  return `${yr}-${String(mo).padStart(2, '0')}`;
}
const MONTH_SHORT = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(key: number): string { return `${MONTH_SHORT[key % 100]} ${Math.floor(key / 100)}`; }
function rangeLabel(from: string, to: string): string {
  const fk = inputToKey(from); const tk = inputToKey(to);
  return fk === tk ? monthLabel(fk) : `${monthLabel(fk)} – ${monthLabel(tk)}`;
}

const DEFAULT_FROM = '2026-05';
const DEFAULT_TO   = '2026-05';

/* ─── Excel download ─────────────────────────────────────────────────────────── */

function downloadLedger(entries: LedgerEntry[], outletName: string, period: string) {
  const TYPE_LABEL: Record<TxType, string> = {
    earn: 'Earned', credit: 'Credited', redeem: 'Redeemed', hold: 'On Hold', expire: 'Expired',
  };
  const rows = entries.map((e) => ({
    Date:        e.date,
    Description: e.description,
    Type:        TYPE_LABEL[e.type],
    Points:      e.points > 0 ? `+${e.points}` : String(e.points),
    Balance:     e.balance,
    Reference:   e.ref ?? '',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 13 }, { wch: 48 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Points Ledger');
  XLSX.writeFile(wb, `${outletName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-ledger-${period}.xlsx`);
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function OutletLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id }     = use(params);
  const resolvedId = OUTLET_MAP[id] ?? id;
  const outlet     = OUTLET_META[resolvedId];
  const rawEntries = LEDGER_DATA[resolvedId] ?? [];

  const [loading,         setLoading]         = useState(true);
  const [earnBurnFilter,  setEarnBurnFilter]  = useState<EarnBurnFilter>('all');
  const [kpiFilter,       setKpiFilter]       = useState('');

  /* Date-range state */
  const [fromMonth,   setFromMonth]   = useState(DEFAULT_FROM);
  const [toMonth,     setToMonth]     = useState(DEFAULT_TO);
  const [pendingFrom, setPendingFrom] = useState(DEFAULT_FROM);
  const [pendingTo,   setPendingTo]   = useState(DEFAULT_TO);
  const [calOpen,     setCalOpen]     = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 350);
    return () => clearTimeout(t);
  }, []);

  /* Bounds for <input type="month"> */
  const [minMonth, maxMonth] = useMemo(() => {
    if (!rawEntries.length) return [DEFAULT_FROM, DEFAULT_TO];
    const keys = rawEntries.map((e) => txDateToMonthKey(e.date));
    return [keyToInput(Math.min(...keys)), keyToInput(Math.max(...keys))];
  }, [rawEntries]);

  /* KPI options — distinct kpiLabels from ALL raw entries */
  const kpiOptions = useMemo(() => [
    ...new Set(rawEntries.map((e) => e.kpiLabel).filter((l): l is string => !!l)),
  ], [rawEntries]);

  /* Apply date-range + earn/burn + KPI filter */
  const filtered = useMemo(() => {
    const fromKey = inputToKey(fromMonth);
    const toKey   = inputToKey(toMonth);
    return rawEntries
      .filter((e) => { const k = txDateToMonthKey(e.date); return k >= fromKey && k <= toKey; })
      .filter((e) => {
        if (earnBurnFilter === 'earn') return EARN_TYPES.has(e.type);
        if (earnBurnFilter === 'burn') return BURN_TYPES.has(e.type);
        return true;
      })
      .filter((e) => !kpiFilter || e.kpiLabel === kpiFilter);
  }, [rawEntries, fromMonth, toMonth, earnBurnFilter, kpiFilter]);

  const periodDisp = rangeLabel(fromMonth, toMonth);

  function applyRange()  { setFromMonth(pendingFrom); setToMonth(pendingTo); setCalOpen(false); }
  function clearRange()  {
    setPendingFrom(DEFAULT_FROM); setPendingTo(DEFAULT_TO);
    setFromMonth(DEFAULT_FROM);   setToMonth(DEFAULT_TO);
    setCalOpen(false);
  }

  if (!outlet) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <AlertTriangle className="h-10 w-10 text-amber-400" />
        <p className="text-sm text-gray-500">Outlet not found</p>
        <Link href="/sales/kyc" className="text-sm text-[var(--brand-primary)] font-medium">← Back</Link>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">

      {/* Back + title */}
      <div className="flex items-center gap-2">
        <Link href={`/sales/kyc/${id}`} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div>
          <h1 className="text-base font-bold text-gray-900">{outlet.name}</h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-xs text-gray-500">Points Ledger</p>
            <span className="text-[10px] font-mono font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
              {outlet.outletCode}
            </span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48"><Spinner size="lg" /></div>
      ) : (
        <>
          {/* ── Balance card — dark gradient, same style as partner wallet ── */}
          <div
            className="rounded-2xl px-5 py-4 text-white shadow-xl"
            style={{ background: 'linear-gradient(135deg, #1A1A2E 0%, #16213E 100%)' }}
          >
            <p className="text-white/50 text-[11px] font-medium uppercase tracking-widest">
              Lifetime Earned
            </p>
            <p className="text-3xl font-extrabold tracking-tight leading-none mt-1 mb-4">
              {outlet.lifetime.toLocaleString()}
              <span className="text-base font-normal text-white/40 ml-1.5">pts</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white/10 rounded-xl px-3 py-2.5">
                <p className="text-[10px] text-white/40 font-medium uppercase tracking-wide">Available</p>
                <p className="text-lg font-bold text-white mt-0.5">
                  {outlet.balance.toLocaleString()}
                  <span className="text-xs font-normal text-white/50 ml-1">pts</span>
                </p>
              </div>
              <div className="bg-white/10 rounded-xl px-3 py-2.5">
                <p className="text-[10px] text-white/40 font-medium uppercase tracking-wide">Redeemed</p>
                <p className="text-lg font-bold text-white mt-0.5">
                  {outlet.redeemed.toLocaleString()}
                  <span className="text-xs font-normal text-white/50 ml-1">pts</span>
                </p>
              </div>
            </div>
          </div>

          {/* ── Statement — same container as partner wallet ── */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">

            {/* Header */}
            <div className="px-4 pt-3 pb-2 border-b border-gray-50 space-y-2">

              {/* Title + controls */}
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                  Statement · {periodDisp}
                </p>

                <div className="flex items-center gap-2">
                  {/* Excel download */}
                  {filtered.length > 0 && (
                    <button
                      onClick={() => downloadLedger(filtered, outlet.name, `${fromMonth}_${toMonth}`)}
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
                      onClick={() => { setPendingFrom(fromMonth); setPendingTo(toMonth); setCalOpen((o) => !o); }}
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
                                onChange={(e) => setPendingFrom(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide block mb-1">To</label>
                              <input type="month" value={pendingTo} min={pendingFrom} max={maxMonth}
                                onChange={(e) => setPendingTo(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                              />
                            </div>
                          </div>
                          <div className="flex gap-2 mt-4">
                            <button onClick={clearRange}
                              className="flex-1 py-2 border border-gray-200 text-gray-500 rounded-xl text-xs font-semibold hover:bg-gray-50 transition-colors"
                            >Reset</button>
                            <button onClick={applyRange}
                              className="flex-1 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-xs font-semibold hover:bg-[var(--brand-primary-dark)] transition-colors"
                            >Apply</button>
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
                  <option value="">All KPIs</option>
                  {kpiOptions.map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </select>
                <span className="ml-auto text-[10px] text-gray-400">{filtered.length} entries</span>
              </div>
            </div>

            {/* Transaction list */}
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12">
                <Coins className="h-8 w-8 text-gray-200" />
                <p className="text-sm text-gray-400">No transactions for this period</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50 px-4">
                {filtered.map((entry) => {
                  const walletTx = toWalletTx(entry);
                  return (
                    <div key={entry.id}>
                      <TransactionItem transaction={walletTx} />
                      {entry.ref && (
                        <p className="text-[10px] text-gray-400 font-mono pb-2 -mt-2 pl-11">#{entry.ref}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
