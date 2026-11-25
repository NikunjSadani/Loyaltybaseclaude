'use client';

/**
 * OutletWalletView — the ONE presentational outlet wallet: summary cards (points / payout) + the
 * combined statement (period picker, Earn/Burn chips, KPI filter, rows, empty + error states).
 *
 * Rendered by BOTH the partner's own wallet (`/partner/wallet`) and the sales app's view of an
 * outlet's wallet (`/sales/kyc/[id]/ledger`), so a sales rep always sees exactly what the outlet
 * sees (owner-approved, platform-wide, 2026-11-19). Each page keeps ONLY its own data loading and
 * page chrome (header / back link); everything below the header lives here, driven by props.
 *
 * Card rules (mirror the backend's shared resolveOutletWalletActivity):
 *   - showPointsCard  (hasPointsActivity) → the points BalanceCard
 *   - showPayoutCard  (hasPayoutActivity) → the ₹ PayoutSummary (+ "Incl. Activation" sub-line
 *     when inclActivationNote — WHOLESALER outlets on a tenant with wholesalerPayoutInclActivation)
 *   - neither → no cards; the statement below always renders.
 */

import React, { useState, useMemo, useEffect, useId } from 'react';
import { Coins, Calendar, X } from 'lucide-react';
import { StatementDownloadButton } from '@/components/wallet/statement-download-button';
import { isUploadDeductionRow, type StatementDoc } from '@/lib/wallet-statement/statement-model';
import { BalanceCard } from '@/components/wallet/balance-card';
import { TransactionItem } from '@/components/wallet/transaction-item';
import { PayoutStatementRow } from '@/components/wallet/payout-statement-row';
import { istMonthKey } from '@/lib/ist-date';
import { TransactionType, WalletBucket, type WalletBalance, type WalletTransaction } from '@/types';
import type { PayoutLedgerEntry } from '@/types';

/* ─── API types & mappers (shared by both pages) ──────────────────────────────── */

/** Exact shape returned by GET /api/wallet (flat — no nesting under .balance), and by the sales
 *  ledger's `meta.walletBalance` (the SAME fields from the SAME Wallet row). */
export interface ApiWalletBalance {
  earnedPoints:     number;
  lockedPoints:     number;
  redeemablePoints: number;
  redeemedPoints:   number;
  expiredPoints:    number;
  lifetimeEarned:   number;
  lifetimeRedeemed: number;
  currency?:        string;
  conversionRate?:  number;
  /** Negative wallets only (owner decision 2, 2026-11-19). */
  owedPoints?:       number;
  owedFromReversal?: boolean;
  /** Negative wallets only: the below-zero stretch includes an upload deduction (field names may be empty). */
  owedFromDeduction?:   boolean;
  owedDeductionFields?: string[];
}

/** A row of GET /api/wallet/statement (the FULL, unpaginated statement) — also the row shape of
 *  the sales ledger's `statement.rows` (the same shared backend builder). */
export interface ApiWalletTransaction {
  id:              string;
  transactionType: string;   // e.g. 'CREDIT_POINTS_EARNED', 'DEBIT_REDEMPTION'
  description:     string;   // narration, else the per-type default ("Points redeemed", …)
  points:          number;   // SIGNED: positive credit, negative debit/expiry
  date:            string;   // ISO string
  balanceType?:    string;   // not on statement rows (always the redeemable balance)
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

export function mapApiBalance(api: ApiWalletBalance): WalletBalance {
  return {
    earned:     api.earnedPoints,
    locked:     api.lockedPoints,
    redeemable: api.redeemablePoints,
    redeemed:   api.redeemedPoints,
    expired:    api.expiredPoints,
    available:  api.redeemablePoints,
    ...(api.owedPoints !== undefined ? { owedPoints: api.owedPoints } : {}),
    ...(api.owedFromReversal !== undefined ? { owedFromReversal: api.owedFromReversal } : {}),
    ...(api.owedFromDeduction !== undefined ? { owedFromDeduction: api.owedFromDeduction } : {}),
    ...(Array.isArray(api.owedDeductionFields) ? { owedDeductionFields: api.owedDeductionFields } : {}),
  };
}

export function mapApiTransaction(t: ApiWalletTransaction): WalletTransaction {
  // Credit rows lead with the resolved FIELD NAME as the header and show the raw
  // upload narration as a small gray sub-line below (only when non-empty). Non-credit
  // rows keep their own description (narration, else the per-type default such as
  // "Points redeemed" / "Points expired") as the header and carry no sub-line.
  // An UPLOAD DEDUCTION (DEBIT_ADJUSTMENT written by a credit batch): its own server text already names the field
  // ("320 points deducted — Target, November 2026 · <note>") — shown as-is, never with the field name again.
  const isUploadDeduction = isUploadDeductionRow(t);
  const hasFieldName = !!t.fieldName && !isUploadDeduction;
  const header    = isUploadDeduction
    ? t.description
    : hasFieldName ? (t.fieldName as string) : t.description;
  const narration = hasFieldName && t.narration ? t.narration : undefined;

  return {
    id:             t.id,
    walletId:       'w1',
    userId:         'u1',
    type:           mapTransactionType(t.transactionType),
    bucket:         mapBucket(t.balanceType ?? ''),
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
    reversalRef:    t.referenceType === 'CREDIT_REVERSAL' ? t.referenceId : null,
    createdAt:      new Date(t.date),
  };
}

/** Statement rows arrive OLDEST first (balance-chain order); the screen shows newest first, so
 *  reverse (keeps same-timestamp rows in correct reverse-chain order) and map. */
export function mapStatementRows(rows: ApiWalletTransaction[]): WalletTransaction[] {
  return [...rows].reverse().map(mapApiTransaction);
}

function fmtInr(n: number) { return `₹${n.toLocaleString('en-IN')}`; }
function monthLabel(period: string) {
  const [yr, mo] = period.split('-');
  return new Date(+yr, +mo - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/* ─── Helpers ─────────────────────────────────────────────────────────────────── */

/** A row's statement month (YYYYMM) — its IST calendar month, the SAME bucketing the downloaded
 *  statement uses (backend istMonthBounds) and the date column shows (TransactionItem → IST). */
function toMonthKey(d: Date): number   { return monthInputToKey(istMonthKey(d)); }
function monthKeyToInput(key: number)  { const yr = Math.floor(key/100); const mo = key%100; return `${yr}-${String(mo).padStart(2,'0')}`; }
function monthInputToKey(val: string)  { const [yr,mo] = val.split('-'); return parseInt(yr,10)*100+parseInt(mo,10); }
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

/** Current calendar month as a `YYYY-MM` month-input value, computed from `new Date()` in IST —
 *  the SAME clock the row months use (toMonthKey) and the download uses, so "this month" and a row's
 *  month can never disagree on a non-IST device near a month edge (deliberate, 2026-11-19).
 *  Used as the FIRST-paint default (before live data arrives) and as the empty-history
 *  fallback — never a hardcoded date, so the wallet opens on "today", not a fixed past month. */
export function currentMonthInput(): string {
  return istMonthKey(new Date());
}

/* ─── Points summary card ─────────────────────────────────────────────────────── */

function PointsSummary({ balance, audience }: { balance: WalletBalance | null; audience: 'partner' | 'staff' }) {
  if (!balance) return null;
  return <BalanceCard balance={balance} audience={audience} />;
}

/* ─── Payout (INR) summary card ───────────────────────────────────────────────── */

export function PayoutSummary({ payouts, inclActivationNote = false }: { payouts: PayoutLedgerEntry[]; inclActivationNote?: boolean }) {
  // Only confirmed PAID entries feed the lifetime/last-month figures.
  const paidEntries = useMemo(() => payouts.filter((p) => p.status === 'PAID'), [payouts]);
  // payoutAmountPaise is integer paise; accumulate in paise then divide for display
  const lifetimePaid = useMemo(() => paidEntries.reduce((s, p) => s + p.payoutAmountPaise, 0) / 100, [paidEntries]);
  const lastPaid = useMemo(() =>
    paidEntries.length > 0
      ? [...paidEntries].sort((a, b) => b.period.localeCompare(a.period))[0]
      : null,
  [paidEntries]);
  // payoutAmountPaise is already NET (gross − TDS withheld). B-L6: a fully withheld latest payout is labelled.
  const lastMonthAmt   = (lastPaid?.payoutAmountPaise ?? 0) / 100;
  const lastMonthLabel = lastPaid ? monthLabel(lastPaid.period) : '—';

  return (
    <div data-testid="payout-summary" className="rounded-2xl p-5 text-white" style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)' }}>
      <div className="flex items-baseline justify-between gap-3 mb-4">
        {inclActivationNote ? (
          // Tenant flag wholesalerPayoutInclActivation (Bajaj, wholesalers only): a smaller sub-line under the label.
          <div>
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Lifetime Payout</p>
            <p data-testid="payout-incl-activation" className="text-[10px] text-slate-400 mt-0.5">Incl. Activation</p>
          </div>
        ) : (
          <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">Lifetime Payout</p>
        )}
        <p className="text-3xl font-extrabold tracking-tight">{fmtInr(lifetimePaid)}</p>
      </div>
      <div data-testid="payout-last-month" className="bg-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] text-slate-400 font-medium">Last Month Payout</p>
          <p className="text-[10px] text-slate-500 mt-0.5">{lastMonthLabel}</p>
        </div>
        {lastPaid?.settledByTds ? (
          <p className="text-sm font-bold text-amber-300">{fmtInr(0)} — withheld as TDS</p>
        ) : (
          <p className="text-xl font-bold text-white">{fmtInr(lastMonthAmt)}</p>
        )}
      </div>
    </div>
  );
}

/* ─── The shared view ─────────────────────────────────────────────────────────── */

export interface OutletWalletViewProps {
  /** Points balance for the points card (null → no points card even when showPointsCard). */
  balance: WalletBalance | null;
  /** Points statement rows, NEWEST first (see mapStatementRows). */
  transactions: WalletTransaction[];
  /** The outlet's payout ledger (₹), from the shared backend payout builder. */
  payouts: PayoutLedgerEntry[];
  /** True when the points statement could not be loaded — an error, never an empty statement. */
  statementError: boolean;
  /** hasPointsActivity — draw the points card. */
  showPointsCard: boolean;
  /** hasPayoutActivity — draw the ₹ payout card. */
  showPayoutCard: boolean;
  /** WHOLESALER outlet on a tenant with wholesalerPayoutInclActivation → "Incl. Activation" line. */
  inclActivationNote: boolean;
  /** Per-outlet-type Loyalty switch — gates the Earn/Burn chips. */
  loyaltyEnabled: boolean;
  /** The outlet's type code — the "Visibility" KPI option is kept only for SSS / SSS_TOT. */
  outletType: string | null;
  /** For the download file name. */
  outletCode: string;
  /** Build the downloadable statement for the selected [from..to] (YYYY-MM) period. */
  loadStatementDoc: (range: { from: string; to: string }) => Promise<StatementDoc>;
  /** Copy for the statement-load error (the partner's own wallet keeps the default "your"). */
  statementErrorMessage?: string;
  /** Sales / admin views: show the reversal reference under a "Credit reversed" row (owner decision 2, 2026-11-19). */
  showReversalReference?: boolean;
  /** Who is looking: the outlet itself ('partner', default) or a sales rep / admin ('staff' — "This outlet owes …"). */
  audience?: 'partner' | 'staff';
}

const DEFAULT_STATEMENT_ERROR = "Couldn't load your statement. Please try again.";

export function OutletWalletView({
  balance, transactions, payouts, statementError,
  showPointsCard, showPayoutCard, inclActivationNote, loyaltyEnabled, outletType, outletCode,
  loadStatementDoc, statementErrorMessage, showReversalReference = false, audience = 'partner',
}: OutletWalletViewProps) {
  /* Earn / Burn filter (points rows only) */
  const [earnBurnFilter, setEarnBurnFilter] = useState<'all' | 'earn' | 'burn'>('all');

  /* KPI filter */
  const [kpiFilter, setKpiFilter] = useState('');

  /* Date-range state — initialised to the CURRENT month (lazy, from real `new Date()`).
     The SELECTED period defaults to the outlet's activity range (see `activeFrom`/`activeTo`
     below) so the whole history is visible on open; these `fromMonth`/`toMonth` values only
     take over once the viewer picks a range. */
  const [fromMonth,   setFromMonth]   = useState<string>(currentMonthInput);
  const [toMonth,     setToMonth]     = useState<string>(currentMonthInput);
  const [pendingFrom, setPendingFrom] = useState<string>(currentMonthInput);
  const [pendingTo,   setPendingTo]   = useState<string>(currentMonthInput);
  const [calOpen,     setCalOpen]     = useState(false);

  /* Flips true the moment the viewer Applies a period of their own. Until then the
     statement snaps to the full activity range; afterwards their pick is honoured and
     never overridden on re-render. Reset returns to the snapped default (flag → false). */
  const [userPicked, setUserPicked] = useState(false);

  /* ── Normalise both sources into a single chronological ledger ── */

  // Points rows: only the "main" passbook entries (credit/debit/expire); lock/unlock
  // housekeeping rows stay excluded.
  const pointsRows = useMemo<PointsRow[]>(
    () => transactions
      .filter(isMainEntry)
      // `tx.kpiLabel` carries the resolved credit field name (see mapApiTransaction).
      .map((tx) => ({ kind: 'points', date: new Date(tx.createdAt), label: tx.kpiLabel, tx })),
    [transactions],
  );

  // Payout rows: every in-flight-or-paid payout entry (pending → paid; FAILED/REVERSED are
  // excluded). Dated by paidAt once money has hit, else by uploadedAt (when the payout was
  // added), else 00:00 IST on the period's 1st — so a pending row carries its real added-date.
  const payoutRows = useMemo<PayoutRow[]>(
    () => payouts
      .filter((p) => p.status !== 'FAILED')
      .map((p) => {
        const [yr, mo] = p.period.split('-');
        const date = p.paidAt ? new Date(p.paidAt)
          : p.uploadedAt ? new Date(p.uploadedAt)
          : new Date(Date.UTC(+yr, +mo - 1, 1) - 330 * 60_000); // 00:00 IST on the period's 1st
        return { kind: 'payout', date, label: p.kpiLabel, entry: p };
      }),
    [payouts],
  );

  const allRows = useMemo<LedgerRow[]>(() => [...pointsRows, ...payoutRows], [pointsRows, payoutRows]);

  /* Earliest and latest month across the COMBINED history (falls back to the current
     month — never a hardcoded date — when there is no activity at all). */
  const [minMonth, maxMonth] = useMemo(() => {
    if (!allRows.length) { const cm = currentMonthInput(); return [cm, cm]; }
    const keys = allRows.map((r) => toMonthKey(r.date));
    return [monthKeyToInput(Math.min(...keys)), monthKeyToInput(Math.max(...keys))];
  }, [allRows]);

  /* Effective selected period. Until the viewer picks a range of their own, snap to the
     FULL activity range [minMonth..maxMonth]; with no activity at all this is the current
     month. Derived at render (not via an effect) so the default is correct on the SAME
     render the data arrives — no empty-first-frame flash and no snap-timing race. */
  const activeFrom = userPicked ? fromMonth : minMonth;
  const activeTo   = userPicked ? toMonth   : maxMonth;

  /* Picker bounds: always allow selecting up to the current month even if the latest
     activity is older (max = later of maxMonth / current month); and never let the
     lower bound sit past the current month (min = earlier of minMonth / current month).
     `YYYY-MM` strings order correctly under lexical comparison. */
  const currentMonth = currentMonthInput();
  const pickerMax = maxMonth > currentMonth ? maxMonth : currentMonth;
  const pickerMin = minMonth < currentMonth ? minMonth : currentMonth;

  /* Rows in the selected period, BEFORE the earn/burn + KPI filters (the download covers all of them). */
  const rangeRows = useMemo(() => {
    const fromKey = monthInputToKey(activeFrom);
    const toKey   = monthInputToKey(activeTo);
    return allRows.filter((r) => { const k = toMonthKey(r.date); return k >= fromKey && k <= toKey; });
  }, [allRows, activeFrom, activeTo]);

  /* Period- + earn/burn-filtered rows (before the KPI filter) */
  const periodRows = useMemo(() => {
    return rangeRows
      .filter((r) => {
        // Earn/Burn applies to points rows; payout rows are inbound value → treated as "earn".
        if (earnBurnFilter === 'all') return true;
        if (r.kind === 'payout') return earnBurnFilter === 'earn';
        if (earnBurnFilter === 'earn') return r.tx.type === TransactionType.CREDIT;
        return r.tx.type === TransactionType.DEBIT || r.tx.type === TransactionType.EXPIRE;
      });
  }, [rangeRows, earnBurnFilter]);

  /* KPI options — derived from the period rows; Visibility only for SSS / SSS_TOT outlets */
  const kpiOptions = useMemo(() => {
    const isVisibility = outletType === 'SSS' || outletType === 'SSS_TOT';
    return [...new Set(
      periodRows
        .map((r) => r.label)
        .filter((l): l is string => !!l && (isVisibility || l !== 'Visibility')),
    )];
  }, [periodRows, outletType]);

  /* Rows to actually display — periodRows further filtered by kpiFilter, newest first */
  const displayedRows = useMemo(() => {
    const filtered = kpiFilter ? periodRows.filter((r) => r.label === kpiFilter) : periodRows;
    return [...filtered].sort((a, b) => +b.date - +a.date);
  }, [periodRows, kpiFilter]);

  /* A KPI picked earlier that no longer exists in the current options (the period or the
     Earn/Burn chip changed) falls back to "All Parameters" — never a stale, invisible selection
     filtering the list down to nothing. Adjusted during render (React's "adjust state when a
     prop/derived value changes" pattern), so there is no empty intermediate frame. */
  if (kpiFilter && !kpiOptions.includes(kpiFilter)) setKpiFilter('');

  /* Escape closes the period popover. */
  useEffect(() => {
    if (!calOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCalOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [calOpen]);

  const idBase   = useId();
  const fromId   = `${idBase}-from`;
  const toId     = `${idBase}-to`;
  const dialogId = `${idBase}-period`;

  const periodDisp = rangeLabel(activeFrom, activeTo);

  return (
    <>
      {/* ── Summary cards — presence-based (points, payout, both, or none) ── */}
      {showPointsCard && <PointsSummary balance={balance} audience={audience} />}
      {showPayoutCard && (
        <PayoutSummary payouts={payouts} inclActivationNote={inclActivationNote} />
      )}

      {/* ── Combined statement — ALWAYS the full history (points + payouts) ── */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 pt-3 pb-2 border-b border-gray-50 space-y-2">
          {/* Row 1: label + Download (Excel/PDF) + date picker */}
          <div data-testid="statement-controls-row" className="flex items-center justify-between">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
              Statement · {periodDisp}
            </p>

          <div className="flex items-center gap-2">
            {/* Download → Excel / PDF (full statement for the period); disabled when the period is empty */}
            <StatementDownloadButton
              disabled={rangeRows.length === 0}
              loadDoc={() => loadStatementDoc({ from: activeFrom, to: activeTo })}
              fileBase={`wallet-statement-${outletCode || 'outlet'}-${activeFrom}_${activeTo}`}
            />

            <div className="relative">
              <button
                data-testid="period-picker-btn"
                aria-haspopup="dialog"
                aria-expanded={calOpen}
                aria-controls={calOpen ? dialogId : undefined}
                onClick={() => { setPendingFrom(activeFrom); setPendingTo(activeTo); setCalOpen(o => !o); }}
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
                  <div id={dialogId} role="dialog" aria-label="Select period" className="absolute top-full right-0 mt-2 bg-white rounded-2xl border border-gray-100 shadow-xl p-4 z-20 w-64">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-bold text-gray-800">Select Period</p>
                      <button onClick={() => setCalOpen(false)} aria-label="Close period picker" className="p-1 rounded-full hover:bg-gray-100 text-gray-400">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label htmlFor={fromId} className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide block mb-1">From</label>
                        <input id={fromId} type="month" value={pendingFrom} min={pickerMin} max={pendingTo}
                          onChange={e => setPendingFrom(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                        />
                      </div>
                      <div>
                        <label htmlFor={toId} className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide block mb-1">To</label>
                        <input id={toId} type="month" value={pendingTo} min={pendingFrom} max={pickerMax}
                          onChange={e => setPendingTo(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-1 focus:ring-[var(--brand-primary)]/20"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <button
                        onClick={() => { setUserPicked(false); setPendingFrom(minMonth); setPendingTo(maxMonth); setFromMonth(minMonth); setToMonth(maxMonth); setCalOpen(false); }}
                        className="flex-1 py-2 border border-gray-200 text-gray-500 rounded-xl text-xs font-semibold hover:bg-gray-50 transition-colors"
                      >
                        Reset
                      </button>
                      <button
                        onClick={() => { setUserPicked(true); setFromMonth(pendingFrom); setToMonth(pendingTo); setCalOpen(false); }}
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

          {/* Earn / Burn filter chips + KPI filter. The Earn/Burn chips are points concepts
              (earn=credit, burn=debit) — meaningless for a loyalty-OFF (payout-only) outlet whose
              statement is all inbound payouts — so they are shown ONLY when loyalty is enabled.
              The KPI ("All Parameters") filter stays for every outlet type. */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {loyaltyEnabled && ([
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

        {statementError ? (
          <div data-testid="statement-load-error" className="flex flex-col items-center gap-2 py-12">
            <Coins className="h-8 w-8 text-gray-200" />
            <p className="text-sm text-red-500">{statementErrorMessage ?? DEFAULT_STATEMENT_ERROR}</p>
          </div>
        ) : displayedRows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12">
            <Coins className="h-8 w-8 text-gray-200" />
            <p className="text-sm text-gray-400">No transactions for this period</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50 px-4">
            {displayedRows.map((r) =>
              r.kind === 'points' ? (
                <TransactionItem key={`pts-${r.tx.id}`} transaction={r.tx} showReversalRef={showReversalReference} />
              ) : (
                <PayoutStatementRow key={`pay-${r.entry.id}`} entry={r.entry} />
              ),
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default OutletWalletView;
