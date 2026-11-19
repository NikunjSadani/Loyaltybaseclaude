import React from 'react';
import { formatPoints } from '@/lib/utils';
import { istDateKey } from '@/lib/ist-date';
import { TransactionType, type WalletTransaction } from '@/types';

interface TransactionItemProps {
  transaction: WalletTransaction;
  /** Set to true for locked-section rows (LOCK / UNLOCK) */
  isLockedEntry?: boolean;
  /** Sales / admin views: show "Reversal ref <id>" under a credit-reversal row (owner decision 2, 2026-11-19). */
  showReversalRef?: boolean;
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function TransactionItem({ transaction: tx, isLockedEntry = false, showReversalRef = false }: TransactionItemProps) {
  // IST calendar day/month (istDateKey → "YYYY-MM-DD" in Asia/Kolkata).
  const key   = istDateKey(tx.createdAt);
  const day   = key ? key.slice(8, 10) : '';
  const mon   = key ? MONTH_SHORT[Number(key.slice(5, 7)) - 1] : '';

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
        {showReversalRef && tx.reversalRef && (
          <p data-testid="transaction-reversal-ref" className="text-[10px] text-gray-400 mt-0.5 font-mono break-all">
            Reversal ref {tx.reversalRef}
          </p>
        )}
      </div>

      {/* Amount + running balance */}
      <div className="text-right shrink-0 pl-2">
        <p className={`text-[13px] font-bold ${amtColor} whitespace-nowrap`}>
          {/* amtSign already carries the direction (+/−); render the magnitude so a
              negatively-stored debit/expiry amount doesn't double up as "−-6,939".
              LOCK rows have no prefix (amtSign === '') → keep their raw value. */}
          {amtSign}{formatPoints(amtSign ? Math.abs(tx.amount) : tx.amount)}<span className="text-[10px] font-normal ml-0.5">pts</span>
        </p>
        {!isLockedEntry && (
          <p className="text-[10px] text-gray-400 mt-0.5 whitespace-nowrap">
            Bal {tx.balanceAfter < 0 ? `−${formatPoints(-tx.balanceAfter)}` : formatPoints(tx.balanceAfter)}
          </p>
        )}
      </div>
    </div>
  );
}

export default TransactionItem;
