import React from 'react';
import { Coins, Lock, ArrowDownCircle, ArrowUpCircle, AlertCircle } from 'lucide-react';
import { formatPoints } from '@/lib/utils';
import type { WalletBalance } from '@/types';

interface BalanceCardProps {
  balance: WalletBalance;
  conversionRate?: number; // points per ₹1
}

export function BalanceCard({ balance, conversionRate = 100 }: BalanceCardProps) {
  const rupeeValue = Math.floor(balance.redeemable / conversionRate);

  return (
    <div className="bg-gradient-to-br from-[#1A1A2E] to-[#16213E] rounded-2xl p-6 text-white shadow-xl">
      {/* Main balance */}
      <div className="text-center mb-6">
        <p className="text-white/60 text-sm mb-1">Available to Redeem</p>
        <p className="text-4xl font-bold">
          {formatPoints(balance.redeemable)}
          <span className="text-xl font-normal text-white/60 ml-1">pts</span>
        </p>
        <p className="text-white/50 text-sm mt-1">
          ≈ ₹{rupeeValue.toLocaleString('en-IN')} value
        </p>
        <p className="text-white/40 text-xs mt-0.5">
          {conversionRate} pts = ₹1
        </p>
      </div>

      {/* Breakdown grid */}
      <div className="grid grid-cols-2 gap-3">
        {[
          {
            label: 'Earned',
            value: balance.earned,
            icon: Coins,
            color: 'text-emerald-400',
            bg: 'bg-emerald-400/10',
          },
          {
            label: 'Locked',
            value: balance.locked,
            icon: Lock,
            color: 'text-purple-400',
            bg: 'bg-purple-400/10',
          },
          {
            label: 'Redeemed',
            value: balance.redeemed,
            icon: ArrowUpCircle,
            color: 'text-amber-400',
            bg: 'bg-amber-400/10',
          },
          {
            label: 'Expired',
            value: balance.expired,
            icon: AlertCircle,
            color: 'text-red-400',
            bg: 'bg-red-400/10',
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="bg-white/5 rounded-xl p-3 flex items-center gap-2.5">
              <div className={`p-1.5 rounded-lg ${item.bg}`}>
                <Icon className={`h-4 w-4 ${item.color}`} />
              </div>
              <div>
                <p className="text-white/50 text-[10px]">{item.label}</p>
                <p className="text-white font-semibold text-sm">
                  {formatPoints(item.value)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default BalanceCard;
