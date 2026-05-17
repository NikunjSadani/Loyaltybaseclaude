'use client';

import React, { useState, useEffect } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent } from '@/components/ui/card';
import { BalanceCard } from '@/components/wallet/balance-card';
import { TransactionItem } from '@/components/wallet/transaction-item';
import { EmptyState } from '@/components/ui/empty-state';
import { Coins } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TransactionType, WalletBucket, type WalletBalance, type WalletTransaction } from '@/types';

type Filter = 'ALL' | 'CREDITS' | 'DEBITS' | 'LOCKED' | 'REDEEMED';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'CREDITS', label: 'Credits' },
  { key: 'DEBITS', label: 'Debits' },
  { key: 'LOCKED', label: 'Locked' },
  { key: 'REDEEMED', label: 'Redeemed' },
];

const MOCK_BALANCE: WalletBalance = {
  earned: 7350,
  locked: 1200,
  redeemable: 4250,
  redeemed: 3100,
  expired: 500,
  available: 4250,
};

const MOCK_TRANSACTIONS: WalletTransaction[] = [
  { id: 't1', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED, amount: 200, balanceAfter: 4250, description: 'Invoice #INV-2024-005 credited', schemeId: '1', invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-14') },
  { id: 't2', walletId: 'w1', userId: 'u1', type: TransactionType.DEBIT, bucket: WalletBucket.REDEEMED, amount: 500, balanceAfter: 4050, description: 'Redemption – Amazon voucher ₹200', schemeId: null, invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-10') },
  { id: 't3', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED, amount: 350, balanceAfter: 4550, description: 'Invoice #INV-2024-004 credited', schemeId: '1', invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-08') },
  { id: 't4', walletId: 'w1', userId: 'u1', type: TransactionType.LOCK, bucket: WalletBucket.LOCKED, amount: 300, balanceAfter: 4200, description: 'Points locked – 30-day holding', schemeId: '3', invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-07') },
  { id: 't5', walletId: 'w1', userId: 'u1', type: TransactionType.CREDIT, bucket: WalletBucket.EARNED, amount: 100, balanceAfter: 4500, description: 'Visibility submission approved', schemeId: '2', invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-05-05') },
  { id: 't6', walletId: 'w1', userId: 'u1', type: TransactionType.UNLOCK, bucket: WalletBucket.REDEEMABLE, amount: 450, balanceAfter: 4400, description: 'Points unlocked after holding period', schemeId: null, invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-04-28') },
  { id: 't7', walletId: 'w1', userId: 'u1', type: TransactionType.DEBIT, bucket: WalletBucket.REDEEMED, amount: 1000, balanceAfter: 3950, description: 'Redemption – UPI transfer', schemeId: null, invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-04-20') },
  { id: 't8', walletId: 'w1', userId: 'u1', type: TransactionType.EXPIRE, bucket: WalletBucket.EXPIRED, amount: 500, balanceAfter: 4950, description: 'Points expired – Q4 2025 scheme', schemeId: null, invoiceId: null, reversedById: null, reversalReason: null, createdAt: new Date('2026-03-31') },
];

function filterTransactions(txs: WalletTransaction[], filter: Filter): WalletTransaction[] {
  switch (filter) {
    case 'CREDITS': return txs.filter((t) => t.type === TransactionType.CREDIT || t.type === TransactionType.UNLOCK);
    case 'DEBITS': return txs.filter((t) => t.type === TransactionType.DEBIT || t.type === TransactionType.EXPIRE);
    case 'LOCKED': return txs.filter((t) => t.type === TransactionType.LOCK);
    case 'REDEEMED': return txs.filter((t) => t.bucket === WalletBucket.REDEEMED);
    default: return txs;
  }
}

export default function WalletPage() {
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setBalance(MOCK_BALANCE);
      setTransactions(MOCK_TRANSACTIONS);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const filtered = filterTransactions(transactions, filter);

  return (
    <div className="space-y-5 fade-in">
      <h1 className="text-xl font-bold text-gray-900">My Wallet</h1>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          {balance && <BalanceCard balance={balance} conversionRate={100} />}

          {/* Filter tabs */}
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                  filter === f.key
                    ? 'bg-[#C8102E] text-white'
                    : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Transaction passbook */}
          <Card>
            <CardContent className="px-4">
              {filtered.length === 0 ? (
                <EmptyState
                  icon={<Coins className="h-8 w-8" />}
                  title="No transactions"
                  description="No transactions match this filter."
                  className="py-10"
                />
              ) : (
                <div className="divide-y divide-gray-50">
                  {filtered.map((tx) => (
                    <TransactionItem key={tx.id} transaction={tx} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
