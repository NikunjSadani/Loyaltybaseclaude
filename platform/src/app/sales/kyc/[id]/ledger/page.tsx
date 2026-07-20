'use client';

import React, { useState, useEffect, useMemo, use } from 'react';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Calendar, X, Download, Coins } from 'lucide-react';
import * as XLSX from 'xlsx';
import { jsonToSheetSafe } from '@/lib/xlsx-safe';
import { Spinner } from '@/components/ui/spinner';
import { TransactionItem } from '@/components/wallet/transaction-item';
import { PayoutStatementRow } from '@/components/wallet/payout-statement-row';
import { TransactionType, WalletBucket, type WalletTransaction, type PayoutLedgerEntry } from '@/types';

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
  /** Credit FIELD NAME resolved from the batch (credit rows only; null otherwise). */
  fieldName?: string | null;
}

interface OutletMeta {
  name: string;
  outletCode: string;
  mobile: string;
  balance: number;
  lifetime: number;
  redeemed: number;
}

/* Combined statement rows — points transactions AND ₹ payout entries, interleaved
   by date (mirrors the partner wallet). Payout rows carry no points/running-balance
   (balance stays points-only); points rows carry no ₹/UTR. */
type SalesPointsRow = { kind: 'points'; date: Date; label?: string; entry: LedgerEntry };
type SalesPayoutRow = { kind: 'payout'; date: Date; label?: string; payout: PayoutLedgerEntry };
type SalesLedgerRow = SalesPointsRow | SalesPayoutRow;

/* ─── (mock data removed — wired to /api/kyc/[id]/ledger) ─────────────────── */

/* (ledger data wired to /api/kyc/[id]/ledger) */

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

/** Map the ledger's local TxType to TransactionType so we can reuse TransactionItem */
function toWalletTx(entry: LedgerEntry): WalletTransaction & { _ref?: string } {
  let type: TransactionType;
  if      (entry.type === 'earn' || entry.type === 'credit') type = TransactionType.CREDIT;
  else if (entry.type === 'redeem')                          type = TransactionType.DEBIT;
  else if (entry.type === 'expire')                          type = TransactionType.EXPIRE;
  else /* hold */                                            type = TransactionType.LOCK;

  // Credit rows lead with the FIELD NAME as the header and show the upload
  // narration (the original `description`) as a small gray sub-line below (only
  // when non-empty). Non-credit rows keep their own description as the header.
  const hasFieldName = !!entry.fieldName;
  const header    = hasFieldName ? (entry.fieldName as string) : entry.description;
  const narration = hasFieldName && entry.description ? entry.description : undefined;

  return {
    id:             entry.id,
    walletId:       '',
    userId:         '',
    type,
    bucket:         WalletBucket.EARNED,
    amount:         Math.abs(entry.points),
    balanceAfter:   entry.balance,
    description:    header,
    narration,
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

// TZ-safe month key: points dates are UTC-midnight ('YYYY-MM-DD') and payout dates are
// UTC ISO / a UTC-constructed period day, so read UTC getters — matches the string-based
// auto-range (.slice) and never rolls a month-boundary row into the wrong month.
function dateMonthKey(d: Date): number { return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1); }
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

const CURRENT_MONTH = new Date().toISOString().slice(0, 7);
const DEFAULT_FROM  = CURRENT_MONTH;
const DEFAULT_TO    = CURRENT_MONTH;

/* period 'YYYY-MM' → 'May 2026' (matches the payout row's on-screen label). */
function periodLabel(period: string): string {
  const [yr, mo] = period.split('-');
  return new Date(+yr, +mo - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}
/** A JS Date → the YYYY-MM-DD the points rows carry, for the Excel Date column. */
function dateToYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ─── Excel download — unified points + payout statement ──────────────────────── */

function downloadLedger(rows: SalesLedgerRow[], outletName: string, period: string) {
  const TYPE_LABEL: Record<TxType, string> = {
    earn: 'Earned', credit: 'Credited', redeem: 'Redeemed', hold: 'On Hold', expire: 'Expired',
  };
  const sheetRows = rows.map((r) => {
    if (r.kind === 'points') {
      const e = r.entry;
      return {
        Date:         e.date,
        Description:  e.description,
        Type:         TYPE_LABEL[e.type],
        Points:       e.points > 0 ? `+${e.points}` : String(e.points),
        Balance:      e.balance,
        'Amount (₹)': '' as string | number,
        UTR:          '',
        Reference:    e.ref ?? '',
      };
    }
    // Payout row: ₹ + UTR; points/running-balance stay blank (balance is points-only).
    const p = r.payout;
    return {
      Date:         dateToYmd(r.date),
      Description:  `${p.kpiLabel} · ${periodLabel(p.period)}`,
      Type:         p.status === 'PAID' ? 'Payout' : 'Payout (Pending)',
      Points:       '',
      Balance:      '' as string | number,
      'Amount (₹)': p.payoutAmountPaise / 100,
      UTR:          p.utr ?? '—',
      Reference:    p.narration ?? '',
    };
  });
  const ws = jsonToSheetSafe(sheetRows);
  ws['!cols'] = [{ wch: 13 }, { wch: 48 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Wallet Statement');
  XLSX.writeFile(wb, `${outletName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-ledger-${period}.xlsx`);
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function OutletLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [outlet,        setOutlet]        = useState<OutletMeta | null>(null);
  const [rawEntries,    setRawEntries]    = useState<LedgerEntry[]>([]);
  const [rawPayouts,    setRawPayouts]    = useState<PayoutLedgerEntry[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [fetchError,    setFetchError]    = useState('');
  const [earnBurnFilter, setEarnBurnFilter] = useState<EarnBurnFilter>('all');
  const [kpiFilter,     setKpiFilter]     = useState('');

  /* Date-range state */
  const [fromMonth,   setFromMonth]   = useState(DEFAULT_FROM);
  const [toMonth,     setToMonth]     = useState(DEFAULT_TO);
  const [pendingFrom, setPendingFrom] = useState(DEFAULT_FROM);
  const [pendingTo,   setPendingTo]   = useState(DEFAULT_TO);
  const [calOpen,     setCalOpen]     = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/kyc/${id}/ledger`)
      .then((r) => r.json())
      .then((body) => {
        if (!body.success) { setFetchError(body.error ?? 'Failed to load'); return; }
        const { meta, transactions, payouts } = body.data;
        setOutlet(meta);
        setRawEntries(transactions ?? []);
        setRawPayouts(payouts ?? []);
        // Auto-range from the COMBINED history (points + payouts) so a payout-only
        // (wholesaler) outlet — which has no points rows — still gets a sensible window.
        const dates: string[] = [
          ...((transactions ?? []) as LedgerEntry[]).map((t) => t.date),
          ...((payouts ?? []) as PayoutLedgerEntry[]).map(
            (p) => (p.paidAt ?? p.uploadedAt ?? `${p.period}-01`).slice(0, 10),
          ),
        ];
        if (dates.length) {
          const min   = dates.reduce((a, b) => (a < b ? a : b));
          const max   = dates.reduce((a, b) => (a > b ? a : b));
          const toKey = (d: string) => d.slice(0, 7);
          setFromMonth(toKey(min));
          setToMonth(toKey(max));
          setPendingFrom(toKey(min));
          setPendingTo(toKey(max));
        }
      })
      .catch(() => setFetchError('Network error'))
      .finally(() => setLoading(false));
  }, [id]);

  /* ── Combined rows: points transactions + ₹ payout entries (interleaved) ── */
  const allRows = useMemo<SalesLedgerRow[]>(() => {
    const pointsRows: SalesLedgerRow[] = rawEntries.map((e) => ({
      kind: 'points', date: new Date(e.date), label: e.fieldName ?? undefined, entry: e,
    }));
    const payoutRows: SalesLedgerRow[] = rawPayouts
      .filter((p) => p.status !== 'FAILED')
      .map((p) => {
        const [yr, mo] = p.period.split('-');
        const date = p.paidAt ? new Date(p.paidAt)
          : p.uploadedAt ? new Date(p.uploadedAt)
          : new Date(Date.UTC(+yr, +mo - 1, 1)); // UTC so dateMonthKey's UTC getters key it right
        return { kind: 'payout', date, label: p.kpiLabel, payout: p };
      });
    return [...pointsRows, ...payoutRows];
  }, [rawEntries, rawPayouts]);

  /* Bounds for <input type="month"> — across the COMBINED history */
  const [minMonth, maxMonth] = useMemo(() => {
    if (!allRows.length) return [DEFAULT_FROM, DEFAULT_TO];
    const keys = allRows.map((r) => dateMonthKey(r.date));
    return [keyToInput(Math.min(...keys)), keyToInput(Math.max(...keys))];
  }, [allRows]);

  /* KPI options — distinct labels (credit field names + payout KPI labels) */
  const kpiOptions = useMemo(() => [
    ...new Set(allRows.map((r) => r.label).filter((l): l is string => !!l)),
  ], [allRows]);

  /* Apply date-range + earn/burn + KPI filter, newest-first */
  const displayedRows = useMemo(() => {
    const fromKey = inputToKey(fromMonth);
    const toKey   = inputToKey(toMonth);
    return allRows
      .filter((r) => { const k = dateMonthKey(r.date); return k >= fromKey && k <= toKey; })
      .filter((r) => {
        // Earn/Burn applies to points rows; payout rows are inbound ₹ → treated as "earn".
        if (earnBurnFilter === 'all') return true;
        if (r.kind === 'payout') return earnBurnFilter === 'earn';
        if (earnBurnFilter === 'earn') return EARN_TYPES.has(r.entry.type);
        return BURN_TYPES.has(r.entry.type);
      })
      .filter((r) => !kpiFilter || r.label === kpiFilter)
      .sort((a, b) => +b.date - +a.date);
  }, [allRows, fromMonth, toMonth, earnBurnFilter, kpiFilter]);

  const periodDisp = rangeLabel(fromMonth, toMonth);

  function applyRange()  { setFromMonth(pendingFrom); setToMonth(pendingTo); setCalOpen(false); }
  function clearRange()  {
    setPendingFrom(DEFAULT_FROM); setPendingTo(DEFAULT_TO);
    setFromMonth(DEFAULT_FROM);   setToMonth(DEFAULT_TO);
    setCalOpen(false);
  }

  if (!loading && (fetchError || !outlet)) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <AlertTriangle className="h-10 w-10 text-amber-400" />
        <p className="text-sm text-gray-500">{fetchError || 'Outlet not found'}</p>
        <Link href="/sales/kyc" className="text-sm text-[var(--brand-primary)] font-medium">← Back</Link>
      </div>
    );
  }

  // Until the fetch resolves, `outlet` is null. The title below dereferences
  // `o.name`/`o.outletCode` BEFORE the inline loading spinner, so a bare `outlet!`
  // here threw during the loading window — and during SSR (the effect never runs
  // server-side, so loading stays true), which 500-ed the whole route ("This page
  // couldn't load"). Render a spinner until the outlet is loaded.
  if (!outlet) {
    return <div className="flex items-center justify-center py-20"><Spinner size="lg" /></div>;
  }
  const o = outlet;

  return (
    <div className="space-y-5 fade-in">

      {/* Back + title */}
      <div className="flex items-center gap-2">
        <Link href={`/sales/kyc/${id}`} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div>
          <h1 className="text-base font-bold text-gray-900">{o.name}</h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-xs text-gray-500">Points Ledger</p>
            <span className="text-[10px] font-mono font-semibold text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
              {o.outletCode}
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
              {o.lifetime.toLocaleString()}
              <span className="text-base font-normal text-white/40 ml-1.5">pts</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white/10 rounded-xl px-3 py-2.5">
                <p className="text-[10px] text-white/40 font-medium uppercase tracking-wide">Available</p>
                <p className="text-lg font-bold text-white mt-0.5">
                  {o.balance.toLocaleString()}
                  <span className="text-xs font-normal text-white/50 ml-1">pts</span>
                </p>
              </div>
              <div className="bg-white/10 rounded-xl px-3 py-2.5">
                <p className="text-[10px] text-white/40 font-medium uppercase tracking-wide">Redeemed</p>
                <p className="text-lg font-bold text-white mt-0.5">
                  {o.redeemed.toLocaleString()}
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
                  {displayedRows.length > 0 && (
                    <button
                      onClick={() => downloadLedger(displayedRows, o.name, `${fromMonth}_${toMonth}`)}
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
                <span className="ml-auto text-[10px] text-gray-400">{displayedRows.length} entries</span>
              </div>
            </div>

            {/* Transaction list — points rows + ₹ payout rows, interleaved by date */}
            {displayedRows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12">
                <Coins className="h-8 w-8 text-gray-200" />
                <p className="text-sm text-gray-400">No transactions for this period</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50 px-4">
                {displayedRows.map((r) =>
                  r.kind === 'points' ? (
                    <div key={`pts-${r.entry.id}`}>
                      <TransactionItem transaction={toWalletTx(r.entry)} />
                    </div>
                  ) : (
                    <PayoutStatementRow key={`pay-${r.payout.id}`} entry={r.payout} />
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
