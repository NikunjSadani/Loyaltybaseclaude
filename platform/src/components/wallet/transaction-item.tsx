import React from 'react';
import {
  ArrowUpCircle, ArrowDownCircle, Lock, Unlock, AlertTriangle, RotateCcw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatPoints, formatDateTime } from '@/lib/utils';
import { TransactionType, type WalletTransaction } from '@/types';

interface TransactionItemProps {
  transaction: WalletTransaction;
}

const typeConfig: Record<
  TransactionType,
  { icon: React.ReactNode; label: string; amountClass: string; sign: string }
> = {
  [TransactionType.CREDIT]: {
    icon: <ArrowDownCircle className="h-5 w-5 text-emerald-500" />,
    label: 'Credit',
    amountClass: 'text-emerald-600',
    sign: '+',
  },
  [TransactionType.DEBIT]: {
    icon: <ArrowUpCircle className="h-5 w-5 text-red-500" />,
    label: 'Debit',
    amountClass: 'text-red-600',
    sign: '-',
  },
  [TransactionType.LOCK]: {
    icon: <Lock className="h-5 w-5 text-purple-500" />,
    label: 'Locked',
    amountClass: 'text-purple-600',
    sign: '~',
  },
  [TransactionType.UNLOCK]: {
    icon: <Unlock className="h-5 w-5 text-blue-500" />,
    label: 'Unlocked',
    amountClass: 'text-blue-600',
    sign: '+',
  },
  [TransactionType.EXPIRE]: {
    icon: <AlertTriangle className="h-5 w-5 text-amber-500" />,
    label: 'Expired',
    amountClass: 'text-amber-600',
    sign: '-',
  },
  [TransactionType.REVERSE]: {
    icon: <RotateCcw className="h-5 w-5 text-gray-500" />,
    label: 'Reversed',
    amountClass: 'text-gray-600',
    sign: '±',
  },
};

export function TransactionItem({ transaction: tx }: TransactionItemProps) {
  const config = typeConfig[tx.type];

  return (
    <div className="flex items-start gap-3 py-3.5">
      <div className="p-2 bg-gray-50 rounded-full shrink-0">{config.icon}</div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">
          {tx.description ?? config.label}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-gray-400">{formatDateTime(tx.createdAt)}</span>
          <Badge variant="default" className="text-[10px]">
            {tx.bucket}
          </Badge>
        </div>
      </div>

      <div className="text-right shrink-0">
        <p className={`text-sm font-bold ${config.amountClass}`}>
          {config.sign}{formatPoints(tx.amount)} pts
        </p>
        <p className="text-xs text-gray-400 mt-0.5">
          Bal: {formatPoints(tx.balanceAfter)}
        </p>
      </div>
    </div>
  );
}

export default TransactionItem;
