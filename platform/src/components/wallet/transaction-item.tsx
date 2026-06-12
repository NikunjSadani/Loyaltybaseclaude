import React from 'react';
import { formatPoints } from '@/lib/utils';
import { TransactionType, type WalletTransaction } from '@/types';

interface TransactionItemProps {
  transaction: WalletTransaction;
  /** Set to true for locked-section rows (LOCK / UNLOCK) */
  isLockedEntry?: boolean;
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDay(d: Date) {
  return String(d.getDate()).padStart(2, '0');
}
function fmtMon(d: Date) {
  return MONTH_SHORT[d.getMonth()];
}

export function TransactionItem({ transaction: tx, isLockedEntry = false }: TransactionItemProps) {
  const date = new Date(tx.createdAt);
  const day   = fmtDay(date);
  const mon   = fmtMon(date);

  /* ── Amount colour & sign ── */
  const isCredit  = tx.type === TransactionType.CREDIT;
  const isDebit   = tx.type === TransactionType.DEBIT;
  const isExpire  = tx.type === TransactionType.EXPIRE;
  const isLock    = tx.type === TransactionType.LOCK;
  const isUnlock  = tx.type === TransactionType.UNLOCK;

  let amtColor = 'text-gray-500';
  let amtSign  = '';
  let bgDot    = 'bg-gray-300';

  if (isCredit)       { amtColor = 'text-emerald-600'; amtSign = '+'; bgDot = 'bg-emerald-400'; }
  else if (isDebit)   { amtColor = 'text-red-500';     amtSign = '−'; bgDot = 'bg-red-400';     }
  else if (isExpire)  { amtColor = 'text-amber-600';   amtSign = '−'; bgDot = 'bg-amber-400';   }
  else if (isLock)    { amtColor = 'text-purple-600';  amtSign = '';  bgDot = 'bg-purple-400';  }
  else if (isUnlock)  { amtColor = 'text-blue-600';    amtSign = '+'; bgDot = 'bg-blue-400';    }

  /* ── Sub-label ── */
  let subLabel = '';
  if (isExpire)  subLabel = 'Expired';
  else if (isLock)   subLabel = 'Held · releasing soon';
  else if (isUnlock) subLabel = 'Released from hold';

  return (
    <div data-testid="transaction-item" className="flex items-start gap-3 py-3.5">

      {/* Date column */}
      <div className="w-8 shrink-0 text-center mt-0.5">
        <p className="text-[13px] font-bold text-gray-800 leading-none">{day}</p>
        <p className="text-[10px] text-gray-400 leading-none mt-0.5 uppercase">{mon}</p>
      </div>

      {/* Thin vertical rule */}
      <div className="w-px self-stretch bg-gray-100 shrink-0" />

      {/* Dot accent */}
      <div className={`w-1.5 h-1.5 rounded-full ${bgDot} shrink-0 mt-1.5`} />

      {/* Description */}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-gray-800 leading-snug">{tx.description}</p>
        {subLabel && (
          <p className="text-[10px] text-gray-400 mt-0.5">{subLabel}</p>
        )}
        {tx.narration && (
          <p data-testid="transaction-narration" className="text-[10px] text-gray-500 mt-0.5 leading-snug">{tx.narration}</p>
        )}
      </div>

      {/* Amount + running balance */}
      <div className="text-right shrink-0 pl-2">
        <p className={`text-[13px] font-bold ${amtColor} whitespace-nowrap`}>
          {amtSign}{formatPoints(tx.amount)}<span className="text-[10px] font-normal ml-0.5">pts</span>
        </p>
        {!isLockedEntry && (
          <p className="text-[10px] text-gray-400 mt-0.5 whitespace-nowrap">
            Bal {formatPoints(tx.balanceAfter)}
          </p>
        )}
      </div>
    </div>
  );
}

export default TransactionItem;
