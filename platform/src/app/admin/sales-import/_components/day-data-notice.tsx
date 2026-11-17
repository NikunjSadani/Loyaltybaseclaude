'use client';

/**
 * S4 (no silent pass-through): when an apply / recalculation could NOT store a month's day-by-day figures (the API's
 * `dayData.written === false` on a result, or `dayData.available === false` on a recalculation preview), say so plainly
 * next to the result — the monthly figures were still written, but the daily comparison has no data for that month.
 * Renders nothing when the day figures were (or will be) stored, or when the API sent no day-data status.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { monthLabel, sentence } from '@/lib/sales-import/format';
import type { SalesDayDataResult } from '@/lib/sales-import/types';

export function DayDataNotice({ month, dayData }: {
  month: string;
  dayData?: Pick<SalesDayDataResult, 'written' | 'reason'> | { available: boolean; reason?: string } | null;
}) {
  if (!dayData) return null;
  const stored = 'written' in dayData ? dayData.written : dayData.available;
  if (stored) return null;
  const reason = sentence(dayData.reason) || 'the reason was not reported. Contact Gifsy support';
  return (
    <p role="alert" data-testid={`day-data-missing-${month}`}
      className="mt-2 flex gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
      <span><strong>Daily figures not stored for {monthLabel(month)}:</strong> {reason}{/[.!?]$/.test(reason) ? '' : '.'}</span>
    </p>
  );
}
