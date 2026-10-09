'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { BalanceCard } from '@/components/wallet/balance-card';
import { TransactionItem } from '@/components/wallet/transaction-item';
import type { WalletBalance, WalletTransaction } from '@/types';
import { authHeader } from '@/lib/api-client';
import {
  mapEmployeeBalance,
  mapEmployeeTransaction,
  type ApiEmployeeWallet,
  type ApiEmployeeTransaction,
} from '../_lib/employee';

/* ─── REP Wallet ──────────────────────────────────────────────────────────────
   Balance summary + paginated passbook. Employees have NO cash-payout rail, so
   (unlike the partner wallet) there is no payout card / combined-statement — just
   the points balance + the transaction history, loaded page by page. ─────────── */

const PAGE_SIZE = 20;

export default function RepWalletPage() {
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  // Balance once; passbook page by page.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/rewards/employee/wallet', { headers: { ...authHeader() } })
        .then((r) => r.json())
        .catch(() => null),
      fetch(`/api/rewards/employee/wallet/transactions?page=1&limit=${PAGE_SIZE}`, {
        headers: { ...authHeader() },
      })
        .then((r) => r.json())
        .catch(() => null),
    ]).then(([walletJson, txJson]) => {
      if (cancelled) return;
      if (walletJson?.success && walletJson.data?.earnedPoints !== undefined) {
        setBalance(mapEmployeeBalance(walletJson.data as ApiEmployeeWallet));
      }
      if (txJson?.success && Array.isArray(txJson.data?.transactions)) {
        setTransactions((txJson.data.transactions as ApiEmployeeTransaction[]).map(mapEmployeeTransaction));
        setPages(txJson.data.pagination?.pages ?? 1);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = useCallback(() => {
    const next = page + 1;
    setLoadingMore(true);
    fetch(`/api/rewards/employee/wallet/transactions?page=${next}&limit=${PAGE_SIZE}`, {
      headers: { ...authHeader() },
    })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { transactions: ApiEmployeeTransaction[]; pagination?: { pages: number } } }) => {
        if (json.success && Array.isArray(json.data?.transactions)) {
          setTransactions((prev) => [...prev, ...json.data!.transactions.map(mapEmployeeTransaction)]);
          setPage(next);
          if (json.data!.pagination?.pages) setPages(json.data!.pagination.pages);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [page]);

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="text-lg font-bold text-gray-900">My Wallet</h1>
        <p className="text-xs text-gray-500 mt-0.5">Your points balance and history</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {balance && <BalanceCard balance={balance} />}

          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-4 pt-3 pb-2 border-b border-gray-50 flex items-center justify-between">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                Passbook
              </p>
              <span className="text-[10px] text-gray-400">{transactions.length} entries</span>
            </div>

            {transactions.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12">
                <Coins className="h-8 w-8 text-gray-200" />
                <p className="text-sm text-gray-400">No transactions yet</p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-gray-50 px-4">
                  {transactions.map((tx) => (
                    <TransactionItem key={tx.id} transaction={tx} />
                  ))}
                </div>
                {page < pages && (
                  <div className="p-3 border-t border-gray-50">
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="w-full py-2 text-xs font-semibold text-[var(--brand-primary)] rounded-lg hover:bg-gray-50 disabled:opacity-60 transition-colors"
                    >
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
