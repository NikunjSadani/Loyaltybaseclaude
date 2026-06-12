import React from 'react';
import { formatPoints } from '@/lib/utils';
import type { WalletBalance } from '@/types';

interface BalanceCardProps {
  balance: WalletBalance;
}

export function BalanceCard({ balance }: BalanceCardProps) {
  return (
    <div className="bg-gradient-to-br from-[#1A1A2E] to-[#16213E] rounded-2xl px-5 py-4 text-white shadow-xl">
      {/* Lifetime Earned — primary */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-white/50 text-[11px] font-medium uppercase tracking-widest shrink-0">
          Lifetime Earned
        </p>
        <p className="text-3xl font-extrabold tracking-tight leading-none">
          {formatPoints(balance.earned)}
          <span className="text-base font-normal text-white/40 ml-1.5">pts</span>
        </p>
      </div>

      {/* Available to Redeem — secondary */}
      <div className="flex items-center justify-between gap-3 mt-2.5">
        <p className="text-white/40 text-[10px] uppercase tracking-wide shrink-0">Available to Redeem</p>
        <p className="text-white/80 font-semibold text-sm">{formatPoints(balance.redeemable)} pts</p>
      </div>

    </div>
  );
}

export default BalanceCard;
