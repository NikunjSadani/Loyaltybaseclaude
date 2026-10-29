/**
 * TargetTrendChart — a 6-month target-vs-achieved bar chart. Shared by the sales dashboard
 * (across the rep's outlets / roll-up aware) and the outlet-detail page (a single outlet, raw).
 * Pure presentational: pass any `{ month, target, achieved }[]` series + the display unit.
 */

import { formatInrCompact, isInrUnit } from '@/lib/format-inr';

export interface TrendPoint {
  month: string;
  target: number;
  achieved: number;
}

export function TargetTrendChart({
  trend, unit, emptyText = 'No target history yet for your outlets.',
}: { trend: TrendPoint[]; unit: string; emptyText?: string }) {
  const hasData = trend.some((t) => t.target > 0 || t.achieved > 0);
  if (!hasData) {
    return <p className="text-xs text-gray-400 text-center py-6">{emptyText}</p>;
  }
  const max = Math.max(1, ...trend.map((t) => Math.max(t.target, t.achieved)));
  // A ₹ series shows compact Indian ₹ (K/L/Cr) in the bar tooltips — the ₹ sits in the value, so the
  // unit suffix is dropped. Volume/count series keep today's full-digit value + unit suffix.
  const inr = isInrUnit(unit);
  const fmt = (v: number) => (inr ? formatInrCompact(v) : `${v.toLocaleString('en-IN')} ${unit}`);
  return (
    <div className="flex items-end justify-between gap-2 h-40 px-1 pt-2">
      {trend.map((t) => {
        const label = new Date(`${t.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
        return (
          <div key={t.month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <div className="flex items-end gap-0.5 h-32 w-full justify-center">
              <div className="w-2.5 bg-gray-200 rounded-t" style={{ height: `${(t.target / max) * 100}%` }} title={`Target ${fmt(t.target)}`} />
              <div className="w-2.5 bg-[var(--brand-primary)] rounded-t" style={{ height: `${(t.achieved / max) * 100}%` }} title={`Achieved ${fmt(t.achieved)}`} />
            </div>
            <span className="text-[9px] text-gray-400">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
