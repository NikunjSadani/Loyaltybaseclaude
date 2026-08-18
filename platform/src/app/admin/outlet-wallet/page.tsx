'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Wallet, Store, Plus, Minus, AlertTriangle } from 'lucide-react';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { TransactionItem } from '@/components/wallet/transaction-item';
import { useAdminSession } from '@/lib/admin-session';
import { formatPoints } from '@/lib/utils';
import { TransactionType, WalletBucket, type WalletTransaction } from '@/types';

/* ─── API types (frozen backend contract) ──────────────────────────────────────── */

interface ApiOutletId {
  outletId:   string; // = outletCode
  isActive:   boolean;
  kycStatus:  string;
}

interface ApiSummary {
  outlet:     { outletCode: string; name: string; ownerName: string };
  partnerId:  string | null;
  hasWallet:  boolean;
  wallet: {
    earnedPoints:     number;
    lockedPoints:     number;
    redeemablePoints: number;
    redeemedPoints:   number;
    expiredPoints:    number;
    lifetimeEarned:   number;
    lifetimeRedeemed: number;
    lifetimeExpired:  number;
    currency:         string;
    conversionRate:   number;
  };
}

interface ApiTransaction {
  id:            string;
  transactionType: string;
  description:   string;
  points:        number;
  date:          string;
  balanceType:   string;
  balanceAfter:  number;
  referenceType: string | null;
  referenceId:   string | null;
  fieldName?:    string | null;
  narration?:    string | null;
}

interface Pagination {
  page:  number;
  limit: number;
  total: number;
  pages: number;
}

const PAGE_SIZE = 20;

/* ─── Mappers (reuse the partner-wallet passbook row) ────────────────────────────── */

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

// Same treatment as the partner passbook: credit rows lead with the resolved FIELD
// NAME as the header and show the raw upload narration as a small sub-line below.
function mapApiTransaction(t: ApiTransaction): WalletTransaction {
  const hasFieldName = !!t.fieldName;
  const header    = hasFieldName ? (t.fieldName as string) : t.description;
  const narration = hasFieldName && t.narration ? t.narration : undefined;
  return {
    id:             t.id,
    walletId:       'w',
    userId:         'u',
    type:           mapTransactionType(t.transactionType),
    bucket:         mapBucket(t.balanceType),
    amount:         t.points,
    balanceAfter:   t.balanceAfter,
    description:    header,
    schemeId:       t.referenceId,
    invoiceId:      null,
    kpiLabel:       t.fieldName ?? undefined,
    narration,
    reversedById:   null,
    reversalReason: null,
    createdAt:      new Date(t.date),
  };
}

/** ₹-equivalent of a POINTS figure: points / conversionRate (Deoleo rate = 1 → 1pt = ₹1). */
function inrEquivalent(points: number, conversionRate: number): string {
  if (!conversionRate || conversionRate <= 0) return '—';
  return `₹${(points / conversionRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function OutletWalletPage() {
  const session = useAdminSession();

  // Outlet picker — the whole (assumed) tenant's outlet codes, loaded once.
  const [outletIds,     setOutletIds]     = useState<string[]>([]);
  const [idsLoading,    setIdsLoading]    = useState(true);
  const [idsError,      setIdsError]      = useState<string | null>(null);
  const [selectedCode,  setSelectedCode]  = useState('');

  // Summary
  const [summary,        setSummary]        = useState<ApiSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError,   setSummaryError]   = useState<string | null>(null);

  // Passbook
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [pagination,   setPagination]   = useState<Pagination | null>(null);
  const [page,         setPage]         = useState(1);
  const [txLoading,    setTxLoading]    = useState(false);
  const [txError,      setTxError]      = useState<string | null>(null);

  // Adjust modal
  const [adjustOpen,     setAdjustOpen]     = useState(false);
  const [adjType,        setAdjType]        = useState<'CREDIT' | 'DEBIT'>('CREDIT');
  const [adjAmount,      setAdjAmount]      = useState('');
  const [adjReason,      setAdjReason]      = useState('');
  const [adjApprovedBy,  setAdjApprovedBy]  = useState('');
  const [adjConfirming,  setAdjConfirming]  = useState(false);
  const [adjSubmitting,  setAdjSubmitting]  = useState(false);
  const [adjMsg,         setAdjMsg]         = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const wallet    = summary?.wallet ?? null;
  const hasWallet = summary?.hasWallet === true && !!summary?.partnerId;

  // Keep the latest selected code in a ref so late async writes (the post-adjust
  // refetch) can detect a since-changed selection and drop stale responses.
  const selectedCodeRef = useRef(selectedCode);
  useEffect(() => { selectedCodeRef.current = selectedCode; }, [selectedCode]);

  const modalRef = useRef<HTMLDivElement>(null);

  // ── Load the outlet id list once ──
  useEffect(() => {
    let ignore = false;
    setIdsError(null);
    (async () => {
      try {
        const res  = await fetch('/api/admin/outlets/ids');
        const json = await res.json();
        if (ignore) return;
        if (json.success && Array.isArray(json.data?.outlets)) {
          const codes = (json.data.outlets as ApiOutletId[])
            .map((o) => o.outletId)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
          setOutletIds(codes);
        } else {
          setIdsError(json.error ?? 'Could not load the outlet list.');
        }
      } catch (e) {
        if (!ignore) setIdsError(e instanceof Error ? e.message : 'Could not load the outlet list.');
      } finally {
        if (!ignore) setIdsLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, []);

  // ── Fetch summary when the selected outlet changes; also reset the passbook page ──
  useEffect(() => {
    if (!selectedCode) {
      setSummary(null);
      setSummaryError(null);
      return;
    }
    let ignore = false;
    setSummaryLoading(true);
    setSummaryError(null);
    setSummary(null);
    setPage(1);
    (async () => {
      try {
        const res  = await fetch(`/api/wallet/admin/outlet/${encodeURIComponent(selectedCode)}/summary`);
        const json = await res.json();
        if (ignore) return;
        if (json.success && json.data) {
          setSummary(json.data as ApiSummary);
        } else {
          setSummaryError(json.error ?? 'Failed to load wallet summary.');
        }
      } catch (e) {
        if (!ignore) setSummaryError(e instanceof Error ? e.message : 'Network error');
      } finally {
        if (!ignore) setSummaryLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, [selectedCode]);

  // ── Fetch a passbook page (only for outlets that actually have a wallet) ──
  const loadTransactions = useCallback(async (code: string, pageNum: number, signal: { ignore: boolean }) => {
    setTxLoading(true);
    setTxError(null);
    try {
      const params = new URLSearchParams({ page: String(pageNum), limit: String(PAGE_SIZE) });
      const res  = await fetch(`/api/wallet/admin/outlet/${encodeURIComponent(code)}/transactions?${params.toString()}`);
      const json = await res.json();
      if (signal.ignore) return;
      if (json.success && json.data) {
        setTransactions(((json.data.transactions ?? []) as ApiTransaction[]).map(mapApiTransaction));
        setPagination((json.data.pagination ?? null) as Pagination | null);
      } else {
        setTransactions([]);
        setPagination(null);
        setTxError(json.error ?? 'Failed to load passbook.');
      }
    } catch (e) {
      if (!signal.ignore) {
        setTransactions([]);
        setPagination(null);
        setTxError(e instanceof Error ? e.message : 'Network error');
      }
    } finally {
      if (!signal.ignore) setTxLoading(false);
    }
  }, []);

  useEffect(() => {
    // No wallet (pre-KYC) → no passbook fetch and nothing to show.
    if (!selectedCode || !hasWallet) {
      setTransactions([]);
      setPagination(null);
      return;
    }
    const signal = { ignore: false };
    void loadTransactions(selectedCode, page, signal);
    return () => { signal.ignore = true; };
  }, [selectedCode, page, hasWallet, loadTransactions]);

  // ── Re-fetch summary + first passbook page after a successful adjust ──
  // Guarded against a since-changed selection so a late response can't paint
  // outlet A's numbers while the picker now shows outlet B.
  const refetchAfterAdjust = useCallback(async (code: string) => {
    // Summary
    setSummaryLoading(true);
    try {
      const res  = await fetch(`/api/wallet/admin/outlet/${encodeURIComponent(code)}/summary`);
      const json = await res.json();
      if (selectedCodeRef.current === code && json.success && json.data) {
        setSummary(json.data as ApiSummary);
      }
    } catch { /* keep prior summary on transient error */ }
    finally {
      if (selectedCodeRef.current === code) setSummaryLoading(false);
    }
    // Passbook — back to page 1 (the adjust is the newest entry).
    if (selectedCodeRef.current !== code) return;
    if (page === 1) {
      const signal = { ignore: false };
      // Drop the write if the selection changed while this was in flight.
      void loadTransactions(code, 1, {
        get ignore() { return selectedCodeRef.current !== code || signal.ignore; },
      } as { ignore: boolean });
    } else {
      setPage(1); // triggers the guarded passbook effect
    }
  }, [page, loadTransactions]);

  // ── Adjust modal helpers ──
  const amountNum  = Number(adjAmount);
  const amountValid = Number.isInteger(amountNum) && amountNum > 0;
  const reasonValid = adjReason.trim().length > 0;
  const approvedByValid = adjApprovedBy.trim().length > 0;
  // Client-side heads-up only — the backend is the source of truth for DEBIT.
  const debitExceeds =
    adjType === 'DEBIT' && amountValid && wallet != null && amountNum > wallet.redeemablePoints;
  const formValid = amountValid && reasonValid && approvedByValid;

  const closeAdjust = useCallback(() => {
    setAdjustOpen(false);
    setAdjConfirming(false);
    setAdjSubmitting(false);
  }, []);

  function openAdjust() {
    setAdjType('CREDIT');
    setAdjAmount('');
    setAdjReason('');
    setAdjApprovedBy(session.name || '');
    setAdjConfirming(false);
    setAdjSubmitting(false);
    setAdjMsg(null);
    setAdjustOpen(true);
  }

  // Modal a11y: focus into the dialog on open, Esc to close, simple focus trap,
  // and focus restored to the trigger on close.
  useEffect(() => {
    if (!adjustOpen) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const node = modalRef.current;
    const selector =
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    // Focus the first field of the dialog once mounted.
    window.requestAnimationFrame(() => {
      node?.querySelector<HTMLElement>(selector)?.focus();
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAdjust();
        return;
      }
      if (e.key === 'Tab' && node) {
        const list = Array.from(node.querySelectorAll<HTMLElement>(selector));
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [adjustOpen, adjConfirming, adjMsg, closeAdjust]);

  async function submitAdjust() {
    if (adjSubmitting) return; // reentrancy guard on a money write
    if (!summary?.partnerId || !formValid) return;
    const code = summary.outlet.outletCode;
    setAdjSubmitting(true);
    setAdjMsg(null);
    try {
      const res = await fetch('/api/wallet/adjust', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId:  summary.partnerId,
          amount:     amountNum,
          type:       adjType,
          reason:     adjReason.trim(),
          approvedBy: adjApprovedBy.trim(),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setAdjMsg({ type: 'err', text: json.error ?? 'Failed to adjust balance.' });
        setAdjConfirming(false);
      } else {
        const newBal = json.data?.newBalance;
        setAdjMsg({
          type: 'ok',
          text: `Balance adjusted. New redeemable balance: ${
            typeof newBal === 'number' ? `${formatPoints(newBal)} pts` : String(newBal ?? '—')
          }.`,
        });
        await refetchAfterAdjust(code);
      }
    } catch (e) {
      setAdjMsg({ type: 'err', text: e instanceof Error ? e.message : 'Network error' });
      setAdjConfirming(false);
    } finally {
      setAdjSubmitting(false);
    }
  }

  const disabledAdjustReason = !hasWallet
    ? 'This outlet has no wallet yet (KYC not approved)'
    : undefined;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Wallet className="w-5 h-5 text-[var(--brand-primary)]" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">Outlet Wallet</h2>
          <p className="text-xs text-gray-500">
            View an outlet&apos;s points balance and passbook, and make an owner-only manual adjustment.
          </p>
        </div>
      </div>

      {/* Outlet picker */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
        <label htmlFor="outlet-wallet-picker" className="text-xs font-medium text-gray-600">
          Outlet
        </label>
        <SearchableSelect
          value={selectedCode}
          onChange={setSelectedCode}
          options={outletIds}
          placeholder={idsLoading ? 'Loading outlets…' : 'Search by outlet code…'}
          disabled={idsLoading}
          testIdPrefix="outlet-wallet-picker"
          aria-label="Outlet"
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-[var(--brand-primary)] focus:ring-[var(--brand-primary)]/20 transition-colors"
        />
        {idsError && (
          <p className="text-[11px] text-red-600">{idsError}</p>
        )}
      </div>

      {/* Nothing selected */}
      {!selectedCode && (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-10 text-center">
          <Store className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">Pick an outlet to view its points wallet.</p>
        </div>
      )}

      {/* Summary loading */}
      {selectedCode && summaryLoading && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-10 text-center" role="status" aria-live="polite">
          <p className="text-sm text-gray-500 animate-pulse">Loading wallet…</p>
        </div>
      )}

      {/* Summary error (e.g. 404 outlet not in this tenant) */}
      {selectedCode && !summaryLoading && summaryError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 flex items-start gap-3" role="alert">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-700">Could not load this outlet&apos;s wallet</p>
            <p className="text-xs text-red-600 mt-1">{summaryError}</p>
          </div>
        </div>
      )}

      {/* Summary loaded */}
      {selectedCode && !summaryLoading && summary && (
        <>
          {/* Outlet identity + adjust button */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-gray-900">{summary.outlet.name || '—'}</p>
              <p className="text-xs text-gray-500 mt-0.5 font-mono">{summary.outlet.outletCode}</p>
              <p className="text-xs text-gray-500 mt-0.5">Owner: {summary.outlet.ownerName || '—'}</p>
            </div>
            <button
              type="button"
              onClick={openAdjust}
              disabled={!hasWallet}
              title={disabledAdjustReason}
              aria-label="Adjust balance"
              aria-disabled={!hasWallet}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Wallet className="w-4 h-4" />
              Adjust balance
            </button>
          </div>

          {/* No wallet (pre-KYC) */}
          {!hasWallet && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-800">This outlet has no wallet yet</p>
                <p className="text-xs text-amber-700 mt-1">
                  A wallet is created once KYC is approved. There is no balance to view or adjust.
                </p>
              </div>
            </div>
          )}

          {/* Balance */}
          {hasWallet && wallet && (
            <>
              {/* Headline: available-to-redeem + ₹-equivalent */}
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Available to redeem</p>
                <p className="text-3xl font-bold text-gray-900 mt-1 break-words">
                  {formatPoints(wallet.redeemablePoints)}{' '}
                  <span className="text-base font-medium text-gray-400">pts</span>
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  ≈ {inrEquivalent(wallet.redeemablePoints, wallet.conversionRate)} redeemable value
                  {wallet.conversionRate > 0 ? ` · ${wallet.conversionRate} pt/₹` : ''}
                </p>
              </div>

              {/* Full bucket breakdown */}
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Balance detail</p>
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-xs">
                  {([
                    ['Earned (current)',  wallet.earnedPoints],
                    ['Available to redeem', wallet.redeemablePoints],
                    ['On hold (locked)',  wallet.lockedPoints],
                    ['Redeemed',          wallet.redeemedPoints],
                    ['Expired',           wallet.expiredPoints],
                    ['Lifetime earned',   wallet.lifetimeEarned],
                    ['Lifetime redeemed', wallet.lifetimeRedeemed],
                    ['Lifetime expired',  wallet.lifetimeExpired],
                  ] as const).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-gray-400">{label}</dt>
                      <dd className="text-sm font-semibold text-gray-800 mt-0.5">{formatPoints(value)} pts</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}

          {/* Passbook — only for outlets that have a wallet */}
          {hasWallet && (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Points passbook</p>
                {pagination && (
                  <span className="text-[10px] text-gray-400">{pagination.total} entries</span>
                )}
              </div>

              {txLoading ? (
                <p className="px-4 py-10 text-center text-sm text-gray-500 animate-pulse" role="status" aria-live="polite">
                  Loading passbook…
                </p>
              ) : txError ? (
                <div className="px-4 py-8 flex items-start gap-3" role="alert">
                  <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-600">{txError}</p>
                </div>
              ) : transactions.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-12">
                  <Wallet className="h-8 w-8 text-gray-200" />
                  <p className="text-sm text-gray-400">No transactions yet.</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50 px-4">
                  {transactions.map((tx) => (
                    <TransactionItem key={tx.id} transaction={tx} />
                  ))}
                </div>
              )}

              {/* Pagination */}
              {pagination && pagination.pages > 1 && (
                <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-t border-gray-50 text-sm text-gray-500">
                  <span>
                    Page <strong className="text-gray-900">{pagination.page}</strong> of{' '}
                    <strong className="text-gray-900">{pagination.pages}</strong>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={pagination.page <= 1 || txLoading}
                      className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() => setPage((p) => p + 1)}
                      disabled={pagination.page >= pagination.pages || txLoading}
                      className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Adjust modal */}
      {adjustOpen && summary && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeAdjust(); }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="adjust-modal-title"
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 id="adjust-modal-title" className="font-bold text-gray-900">Adjust wallet balance</h3>
              <button
                onClick={closeAdjust}
                aria-label="Close"
                className="text-gray-400 hover:text-gray-700 text-lg leading-none"
              >
                ×
              </button>
            </div>

            {/* Read-only target summary */}
            <div className="bg-gray-50 rounded-xl p-4 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Outlet</span>
                <span className="font-medium text-gray-800">{summary.outlet.name || summary.outlet.outletCode}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Outlet code</span>
                <span className="font-mono font-medium text-gray-800">{summary.outlet.outletCode}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Available to redeem</span>
                <span className="font-medium text-gray-800">
                  {wallet ? `${formatPoints(wallet.redeemablePoints)} pts` : '—'}
                </span>
              </div>
            </div>

            {adjMsg && (
              <div
                role={adjMsg.type === 'err' ? 'alert' : 'status'}
                className={`rounded-xl px-4 py-3 text-xs ${adjMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
              >
                {adjMsg.text}
              </div>
            )}

            {/* Success state — only a Close button */}
            {adjMsg?.type === 'ok' ? (
              <div className="flex justify-end pt-1">
                <button
                  onClick={closeAdjust}
                  className="px-4 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)]"
                >
                  Done
                </button>
              </div>
            ) : !adjConfirming ? (
              /* ── Phase 1: form ── */
              <>
                {/* Type — segmented control */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-gray-700 block" id="adjust-type-label">Adjustment type</span>
                  <div className="flex gap-2" role="group" aria-labelledby="adjust-type-label">
                    {([
                      { v: 'CREDIT', label: 'Credit (add points)', icon: <Plus className="w-3.5 h-3.5" /> },
                      { v: 'DEBIT',  label: 'Debit (remove points)',  icon: <Minus className="w-3.5 h-3.5" /> },
                    ] as const).map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        aria-pressed={adjType === opt.v}
                        onClick={() => setAdjType(opt.v)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border transition-all ${
                          adjType === opt.v
                            ? opt.v === 'CREDIT'
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'bg-red-500 text-white border-red-500'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {opt.icon}
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Amount */}
                <div className="space-y-2">
                  <label htmlFor="adjust-amount" className="text-xs font-medium text-gray-700">
                    Amount (whole points)
                  </label>
                  <input
                    id="adjust-amount"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                  />
                  {adjAmount !== '' && !amountValid && (
                    <p className="text-[11px] text-red-600">Enter a whole number of points greater than 0.</p>
                  )}
                  {debitExceeds && (
                    <p className="text-[11px] text-amber-600">
                      Amount exceeds the {wallet ? formatPoints(wallet.redeemablePoints) : ''} pts available to
                      redeem — the backend will reject this debit.
                    </p>
                  )}
                </div>

                {/* Reason */}
                <div className="space-y-2">
                  <label htmlFor="adjust-reason" className="text-xs font-medium text-gray-700">Reason</label>
                  <textarea
                    id="adjust-reason"
                    value={adjReason}
                    onChange={(e) => setAdjReason(e.target.value)}
                    rows={2}
                    placeholder="Why is this manual adjustment being made?"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 resize-none"
                  />
                </div>

                {/* Approved by */}
                <div className="space-y-2">
                  <label htmlFor="adjust-approved-by" className="text-xs font-medium text-gray-700">Approved by</label>
                  <input
                    id="adjust-approved-by"
                    type="text"
                    value={adjApprovedBy}
                    onChange={(e) => setAdjApprovedBy(e.target.value)}
                    placeholder="Your name"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setAdjConfirming(true)}
                    disabled={!formValid}
                    className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Review
                  </button>
                  <button
                    onClick={closeAdjust}
                    className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              /* ── Phase 2: confirm ── */
              <>
                <div className="rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800">
                  <p>
                    <strong className={adjType === 'CREDIT' ? 'text-emerald-700' : 'text-red-600'}>
                      {adjType === 'CREDIT' ? 'Credit' : 'Debit'} {formatPoints(amountNum)} points
                    </strong>{' '}
                    {adjType === 'CREDIT' ? 'to' : 'from'}{' '}
                    <strong>{summary.outlet.name || summary.outlet.outletCode}</strong> ({summary.outlet.outletCode})?
                  </p>
                  <p className="text-xs text-gray-500 mt-1.5">Reason: {adjReason.trim()}</p>
                  <p className="text-xs text-gray-500 mt-0.5">Approved by: {adjApprovedBy.trim()}</p>
                </div>

                {debitExceeds && (
                  <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-2.5 text-[11px] text-amber-700">
                    This debit exceeds the {wallet ? formatPoints(wallet.redeemablePoints) : ''} pts available to
                    redeem and will be rejected by the backend.
                  </div>
                )}

                <div className="flex items-start gap-2 rounded-xl bg-gray-50 px-4 py-2.5 text-[11px] text-gray-500">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px text-gray-400" />
                  <span>This posts a permanent entry to the outlet&apos;s wallet ledger and cannot be undone from here.</span>
                </div>

                <div className="flex gap-3 pt-1">
                  <button
                    onClick={submitAdjust}
                    disabled={adjSubmitting}
                    className="flex-1 py-2.5 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--brand-primary-dark)] disabled:opacity-50"
                  >
                    {adjSubmitting ? 'Submitting…' : 'Confirm & submit'}
                  </button>
                  <button
                    onClick={() => setAdjConfirming(false)}
                    disabled={adjSubmitting}
                    className="px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Back
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
