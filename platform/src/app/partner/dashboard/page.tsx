'use client';

import React, { useState, useEffect } from 'react';
import {
  Coins, Lock, TrendingUp, Gift, Trophy, ArrowRight,
  Zap, Clock, Target,
} from 'lucide-react';
import Link from 'next/link';
import { StatsCard } from '@/components/ui/stats-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatPoints, formatDate } from '@/lib/utils';
import { TransactionType, type WalletTransaction, type Scheme } from '@/types';

interface DashboardData {
  wallet: {
    available: number;
    locked: number;
    earnedThisMonth: number;
    redeemedTotal: number;
    availableChange: number;
  };
  schemes: Array<{
    id: string;
    name: string;
    targetValue: number;
    achievedValue: number;
    endDate: string;
    incentiveEarned: number;
    status: 'ACTIVE' | 'ACHIEVED' | 'MISSED' | 'UPCOMING';
  }>;
  recentTransactions: WalletTransaction[];
  leaderboard: { rank: number; total: number };
}

const MOCK_DATA: DashboardData = {
  wallet: {
    available: 4250,
    locked: 1200,
    earnedThisMonth: 850,
    redeemedTotal: 3100,
    availableChange: 12.4,
  },
  schemes: [
    {
      id: '1',
      name: 'Q2 Sales Push – Olive Oil',
      targetValue: 500,
      achievedValue: 380,
      endDate: '2026-06-30',
      incentiveEarned: 760,
      status: 'ACTIVE',
    },
    {
      id: '2',
      name: 'Summer Display Visibility',
      targetValue: 10,
      achievedValue: 10,
      endDate: '2026-05-31',
      incentiveEarned: 200,
      status: 'ACHIEVED',
    },
    {
      id: '3',
      name: 'Wholesale Volume Bonus',
      targetValue: 1000,
      achievedValue: 450,
      endDate: '2026-07-15',
      incentiveEarned: 450,
      status: 'ACTIVE',
    },
  ],
  recentTransactions: [
    {
      id: 't1', walletId: 'w1', userId: 'u1',
      type: TransactionType.CREDIT, bucket: 'EARNED' as never,
      amount: 200, balanceAfter: 4250,
      description: 'Invoice #INV-2024-001 credited',
      createdAt: new Date('2026-05-14'),
      schemeId: '1', invoiceId: null, reversedById: null, reversalReason: null,
    },
    {
      id: 't2', walletId: 'w1', userId: 'u1',
      type: TransactionType.DEBIT, bucket: 'REDEEMED' as never,
      amount: 500, balanceAfter: 4050,
      description: 'Redemption – Amazon voucher',
      createdAt: new Date('2026-05-10'),
      schemeId: null, invoiceId: null, reversedById: null, reversalReason: null,
    },
    {
      id: 't3', walletId: 'w1', userId: 'u1',
      type: TransactionType.CREDIT, bucket: 'EARNED' as never,
      amount: 350, balanceAfter: 4550,
      description: 'Invoice #INV-2024-002 credited',
      createdAt: new Date('2026-05-08'),
      schemeId: '1', invoiceId: null, reversedById: null, reversalReason: null,
    },
    {
      id: 't4', walletId: 'w1', userId: 'u1',
      type: TransactionType.LOCK, bucket: 'LOCKED' as never,
      amount: 300, balanceAfter: 4200,
      description: 'Points locked – holding period',
      createdAt: new Date('2026-05-07'),
      schemeId: '3', invoiceId: null, reversedById: null, reversalReason: null,
    },
    {
      id: 't5', walletId: 'w1', userId: 'u1',
      type: TransactionType.CREDIT, bucket: 'EARNED' as never,
      amount: 100, balanceAfter: 4500,
      description: 'Visibility submission approved',
      createdAt: new Date('2026-05-05'),
      schemeId: '2', invoiceId: null, reversedById: null, reversalReason: null,
    },
  ],
  leaderboard: { rank: 12, total: 248 },
};

function txIcon(type: TransactionType) {
  if (type === TransactionType.CREDIT) return 'bg-emerald-50 text-emerald-600';
  if (type === TransactionType.DEBIT) return 'bg-red-50 text-red-600';
  return 'bg-purple-50 text-purple-600';
}

function schemeStatusBadge(status: string) {
  const map: Record<string, { variant: 'success' | 'danger' | 'warning' | 'info'; label: string }> = {
    ACTIVE: { variant: 'info', label: 'Active' },
    ACHIEVED: { variant: 'success', label: 'Achieved' },
    MISSED: { variant: 'danger', label: 'Missed' },
    UPCOMING: { variant: 'warning', label: 'Upcoming' },
  };
  return map[status] ?? { variant: 'default' as never, label: status };
}

export default function PartnerDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate API fetch
    const timer = setTimeout(() => {
      setData(MOCK_DATA);
      setLoading(false);
    }, 600);
    return () => clearTimeout(timer);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6 fade-in">
      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Good morning!</h1>
          <p className="text-sm text-gray-500 mt-0.5">Here&apos;s your loyalty overview</p>
        </div>
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 px-3 py-2 rounded-xl">
          <Trophy className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-semibold text-amber-800">
            Rank #{data.leaderboard.rank}
          </span>
          <span className="text-xs text-amber-600">
            of {data.leaderboard.total}
          </span>
        </div>
      </div>

      {/* Points summary cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatsCard
          icon={<Coins className="h-5 w-5" />}
          title="Available Points"
          value={formatPoints(data.wallet.available)}
          change={data.wallet.availableChange}
          changeLabel="vs last month"
        />
        <StatsCard
          icon={<Lock className="h-5 w-5" />}
          title="Locked Points"
          value={formatPoints(data.wallet.locked)}
          accentColor="#7c3aed"
        />
        <StatsCard
          icon={<TrendingUp className="h-5 w-5" />}
          title="Earned This Month"
          value={formatPoints(data.wallet.earnedThisMonth)}
          accentColor="#059669"
        />
        <StatsCard
          icon={<Gift className="h-5 w-5" />}
          title="Total Redeemed"
          value={formatPoints(data.wallet.redeemedTotal)}
          accentColor="#d97706"
        />
      </div>

      {/* Target progress */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5 text-[#C8102E]" />
              Scheme Targets
            </CardTitle>
            <Link href="/schemes" className="text-xs text-[#C8102E] font-medium hover:underline">
              View all
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {data.schemes.map((scheme) => {
              const pct = Math.round((scheme.achievedValue / scheme.targetValue) * 100);
              const { variant, label } = schemeStatusBadge(scheme.status);
              return (
                <div key={scheme.id} className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {scheme.name}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant={variant}>{label}</Badge>
                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDate(scheme.endDate)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-gray-900">
                        {scheme.achievedValue} / {scheme.targetValue}
                      </p>
                      <p className="text-xs text-emerald-600 font-medium">
                        +{formatPoints(scheme.incentiveEarned)} pts
                      </p>
                    </div>
                  </div>
                  <ProgressBar value={pct} size="sm" showPercentage={false} />
                  <p className="text-xs text-gray-500 text-right">{pct}% achieved</p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Recent transactions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Recent Activity</CardTitle>
            <Link href="/wallet" className="text-xs text-[#C8102E] font-medium hover:underline flex items-center gap-1">
              Full history <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-gray-50">
            {data.recentTransactions.map((tx) => {
              const isCredit = tx.type === TransactionType.CREDIT;
              const isDebit = tx.type === TransactionType.DEBIT;
              return (
                <div key={tx.id} className="py-3 flex items-center gap-3">
                  <div className={`p-2 rounded-full ${txIcon(tx.type)}`}>
                    <Coins className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 truncate">{tx.description}</p>
                    <p className="text-xs text-gray-400">{formatDate(tx.createdAt)}</p>
                  </div>
                  <p
                    className={`text-sm font-semibold ${
                      isCredit ? 'text-emerald-600' : isDebit ? 'text-red-600' : 'text-purple-600'
                    }`}
                  >
                    {isCredit ? '+' : isDebit ? '-' : '~'}
                    {formatPoints(tx.amount)}
                  </p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { href: '/rewards', label: 'Redeem Points', icon: Gift, color: '#C8102E' },
          { href: '/rewards', label: 'View Catalog', icon: Zap, color: '#1A1A2E' },
          { href: '/wallet', label: 'View History', icon: Clock, color: '#059669' },
        ].map((action) => (
          <Link
            key={action.href + action.label}
            href={action.href}
            className="flex flex-col items-center gap-2 p-4 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all text-center"
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ backgroundColor: `${action.color}15` }}
            >
              <action.icon className="h-5 w-5" style={{ color: action.color }} />
            </div>
            <span className="text-xs font-medium text-gray-700 leading-tight">
              {action.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
