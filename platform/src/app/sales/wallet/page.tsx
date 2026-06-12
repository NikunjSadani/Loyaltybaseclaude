'use client';

import React, { useState, useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Coins, Gift,
  Calendar, X, Download, AlertTriangle,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type TxType      = 'earn' | 'bonus' | 'redeem' | 'expire';
type EarnBurnFilter = 'all' | 'earn' | 'burn';

interface EarningEntry {
  id:          string;
  date:        string;   // YYYY-MM-DD
  description: string;
  type:        TxType;
  points:      number;   // positive = credit, negative = debit
  balance:     number;
  ref?:        string;
}

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const SUMMARY = {
  available: 2_840,
  lifetime:  6_350,
  redeemed:  3_010,
  pending:     500,
};

const MOCK_TXS: EarningEntry[] = [
  { id: 'e1',  date: '2026-05-14', description: 'KYC approved — Kumar General Store',     type: 'earn',   points:  +200, balance: 2_840, ref: 'KYC-0183' },
  { id: 'e2',  date: '2026-05-12', description: 'Outlet visit incentive — Singh Supermart',type: 'earn',   points:  +100, balance: 2_640, ref: 'VST-0072' },
  { id: 'e3',  date: '2026-05-10', description: 'Visibility submission approved',           type: 'earn',   points:   +50, balance: 2_540, ref: 'VIS-0092' },
  { id: 'e4',  date: '2026-05-05', description: 'Monthly target bonus — 80% achieved',     type: 'bonus',  points:  +300, balance: 2_490, ref: 'TGT-0041' },
  { id: 'e5',  date: '2026-05-01', description: 'Redeemed — UPI transfer ₹1,000',          type: 'redeem', points: -1_000, balance: 2_190, ref: 'RDM-0058' },
  { id: 'e6',  date: '2026-04-28', description: 'KYC approved — Mehta Provisions',         type: 'earn',   points:  +200, balance: 3_190, ref: 'KYC-0162' },
  { id: 'e7',  date: '2026-04-22', description: 'Visibility submission approved',           type: 'earn',   points:   +50, balance: 2_990, ref: 'VIS-0088' },
  { id: 'e8',  date: '2026-04-15', description: 'Q2 scheme launch bonus',                  type: 'bonus',  points:  +500, balance: 2_940, ref: 'SCH-0012' },
  { id: 'e9',  date: '2026-04-10', description: 'Outlet visit incentive — Sharma Kirana',  type: 'earn',   points:  +100, balance: 2_440, ref: 'VST-0065' },
  { id: 'e10', date: '2026-04-05', description: 'Redeemed — Amazon voucher ₹500',          type: 'redeem', points:  -500, balance: 2_340, ref: 'RDM-0049' },
  { id: 'e11', date: '2026-03-31', description: 'Quarterly performance bonus',             type: 'bonus',  points:  +750, balance: 2_840, ref: 'TGT-0032' },
  { id: 'e12', date: '2026-03-20', description: 'KYC approved — Patel Grocery',            type: 'earn',   points:  +200, balance: 2_090, ref: 'KYC-0141' },
  { id: 'e13', date: '2026-03-15', description: 'Redeemed — Movie voucher ₹250',           type: 'redeem', points:  -250, balance: 1_890, ref: 'RDM-0038' },
  { id: 'e14', date: '2026-03-01', description: 'Points expired — H2 FY25 scheme',         type: 'expire', points:  -200, balance: 2_140, ref: undefined  },
];

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

const TYPE_CONFIG: Record<TxType, { label: string; icon: React.ReactNode; textColor: string; dotColor: string }> = {
  earn:   { label: 'Earned',    icon: <TrendingUp    className="h-3.5 w-3.5" />, textColor: 'text-emerald-600', dotColor: 'bg-emerald-400' },
  bonus:  { label: 'Bonus',     icon: <Coins         className="h-3.5 w-3.5" />, textColor: 'text-blue-600',    dotColor: 'bg-blue-400'    },
  redeem: { label: 'Redeemed',  icon: <Gift          className="h-3.5 w-3.5" />, textColor: 'text-purple-600',  dotColor: 'bg-purple-400'  },
  expire: { label: 'Expired',   icon: <AlertTriangle className="h-3.5 w-3.5" />, textColor: 'text-red-500',     dotColor: 'bg-red-400'     },
};

// Earn = points added (earn + bonus); Burn = points subtracted (redeem + expire)
const EARN_TYPES = new Set<TxType>(['earn', 'bonus']);
const BURN_TYPES = new Set<TxType>(['redeem', 'expire']);

const MONTH_SHORT = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function txDateToKey(date: string): number {
  const [yr, mo] = date.split('-');
  return parseInt(yr) * 100 + parseInt(mo);
}
function inputToKey(val: string): number {
  const [yr, mo] = val.split('-');
  return parseInt(yr) * 100 + parseInt(mo);
}
function keyToInput(key: number): string {
  return `${Math.floor(key / 100)}-${String(key % 100).padStart(2, '0')}`;
}
function monthLabel(key: number): string {
  return `${MONTH_SHORT[key % 100]} ${Math.floor(key / 100)}`;
}
function rangeLabel(from: string, to: string): string {
  const fk = inputToKey(from), tk = inputToKey(to);
  return fk === tk ? monthLabel(fk) : `${monthLabel(fk)} – ${monthLabel(tk)}`;
}
function formatDay(date: string): [string, string] {
  const d = new Date(date);
  return [String(d.getDate()).padStart(2, '0'), MONTH_SHORT[d.getMonth() + 1]];
}

const DEFAULT_FROM = '2026-05';
const DEFAULT_TO   = '2026-05';

/* ─── Excel download ─────────────────────────────────────────────────────────── */

function downloadStatement(txs: EarningEntry[], period: string) {
  const TYPE_LABEL: Record<TxType, string> = {
    earn:   'Earned',
    bonus:  'Bonus',
    redeem: 'Redeemed',
    expire: 'Expired',
  };

  const rows = txs.map((tx) => ({
    Date:          tx.date,
    Description:   tx.description,
    Type:          TYPE_LABEL[tx.type],
    Points:        tx.points > 0 ? `+${tx.points}` : String(tx.points),
    'Balance After': tx.balance,
    Reference:     tx.ref ?? '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 13 },
    { wch: 48 },
    { wch: 12 },
    { wch: 10 },
    { wch: 14 },
    { wch: 16 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Points Statement');
  XLSX.writeFile(wb, `sales-points-statement-${period}.xlsx`);
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function SalesWalletPage() {
  const [earnBurnFilter, setEarnBurnFilter] = useState<EarnBurnFilter>('all');
  const [fromMonth,   setFromMonth]   = useState(DEFAULT_FROM);
  const [toMonth,     setToMonth]     = useState(DEFAULT_TO);
  const [pendingFrom, setPendingFrom] = useState(DEFAULT_FROM);
  const [pendingTo,   setPendingTo]   = useState(DEFAULT_TO);
  const [calOpen,     setCalOpen]     = useState(false);

  const [minMonth, maxMonth] = useMemo(() => {
    const keys = MOCK_TXS.map((tx) => txDateToKey(tx.date));
    return [keyToInput(Math.min(...keys)), keyToInput(Math.max(...keys))];
  }, []);

  const txns = useMemo(() => {
    const fromKey = inputToKey(fromMonth);
    const toKey   = inputToKey(toMonth);
    return MOCK_TXS
      .filter((tx) => { const k = txDateToKey(tx.date); return k >= fromKey && k <= toKey; })
      .filter((tx) => {
        if (earnBurnFilter === 'earn') return EARN_TYPES.has(tx.type);
        if (earnBurnFilter === 'burn') return BURN_TYPES.has(tx.type);
        return true;
      });
  }, [fromMonth, toMonth, earnBurnFilter]);

  const periodDisp = rangeLabel(fromMonth, toMonth);

  function applyRange() { setFromMonth(pendingFrom); setToMonth(pendingTo); setCalOpen(false); }
  function clearRange()  {
    setPendingFrom(DEFAULT_FROM); setPendingTo(DEFAULT_TO);
    setFromMonth(DEFAULT_FROM);  setToMonth(DEFAULT_TO);
    setCalOpen(false);
  }

  return (
    <div className="space-y-5 fade-in">
      <h1 className="text-xl font-bold text-gray-900">My Earnings</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Available',     value: SUMMARY.available, color: 'text-[var(--brand-primary)]', bg: 'bg-[var(--brand-primary)]/5', border: 'border-[var(--brand-primary)]/20' },
          { label: 'Pending',       value: SUMMARY.pending,   color: 'text-amber-600', bg: 'bg-amber-50',     border: 'border-amber-200'    },
          { label: 'Lifetime Earned',value: SUMMARY.lifetime, color: 'text-gray-700',  bg: 'bg-gray-50',      border: 'border-gray-200'     },
          { label: 'Redeemed',      value: SUMMARY.redeemed,  color: 'text-purple-600',bg: 'bg-purple-50',    border: 'border-purple-100'   },
        ].map((s) => (
          <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} px-4 py-3`}>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value.toLocaleString('en-IN')}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label} pts</p>
          </div>
        ))}
      </div>

      {/* Transactions card */}
      <Card>
        <CardHeader>
          {/* Title row */}
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">
              Statement
              <span className="ml-2 text-[10px] font-normal text-gray-400">· {periodDisp}</span>
            </CardTitle>

            <div className="flex items-center gap-2">
              {/* Download */}
              {txns.length > 0 && (
                <button
                  onClick={() => downloadStatement(txns, `${fromMonth}_${toMonth}`)}
                  title="Download as Excel"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 bg-white text-gray-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-all"
                >
                  <Download className="h-3.5 w-3.5" />
                  Excel
                </button>
              )}

              {/* Date range picker */}
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
                  Period
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
                          className="flex-1 py-2 border border-gray-200 text-gray-500 rounded-xl text-xs font-semibold hover:bg-gray-50 transition-colors">
                          Reset
                        </button>
                        <button onClick={applyRange}
                          className="flex-1 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-xs font-semibold hover:bg-[var(--brand-primary-dark)] transition-colors">
                          Apply
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Earn / Burn filter chips */}
          <div className="flex gap-1.5 flex-wrap mt-1 items-center">
            {([
              { value: 'all',  label: 'All'  },
              { value: 'earn', label: 'Earn' },
              { value: 'burn', label: 'Burn' },
            ] as const).map((f) => (
              <button key={f.value} onClick={() => setEarnBurnFilter(f.value)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-all ${
                  earnBurnFilter === f.value
                    ? f.value === 'earn'
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : f.value === 'burn'
                      ? 'bg-red-500 text-white border-red-500'
                      : 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}>
                {f.label}
              </button>
            ))}
            <span className="ml-auto text-[10px] text-gray-400 self-center">{txns.length} entries</span>
          </div>
        </CardHeader>

        <CardContent>
          {txns.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No transactions for this period.</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {txns.map((tx) => {
                const cfg       = TYPE_CONFIG[tx.type];
                const isDebit   = tx.points < 0;
                const [day, mo] = formatDay(tx.date);
                return (
                  <div key={tx.id} className="flex items-start gap-3 py-3.5">
                    {/* Date */}
                    <div className="w-10 shrink-0 text-center mt-0.5">
                      <p className="text-[11px] font-bold text-gray-700 leading-none">{day}</p>
                      <p className="text-[9px] text-gray-400 uppercase leading-none mt-0.5">{mo}</p>
                    </div>

                    <div className="w-px self-stretch bg-gray-100 shrink-0" />

                    {/* Type dot */}
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${cfg.dotColor}`} />

                    {/* Description */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-gray-800 leading-snug">{tx.description}</p>
                      {tx.ref && <p className="text-[10px] text-gray-400 font-mono mt-0.5">#{tx.ref}</p>}
                    </div>

                    {/* Points + balance */}
                    <div className="text-right shrink-0 pl-2">
                      <p className={`text-[13px] font-bold ${isDebit ? 'text-red-500' : cfg.textColor} whitespace-nowrap`}>
                        {isDebit ? '−' : '+'}{Math.abs(tx.points).toLocaleString()}
                        <span className="text-[10px] font-normal ml-0.5">pts</span>
                      </p>
                      <p className="text-[10px] text-gray-400 mt-0.5">Bal {tx.balance.toLocaleString()}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
