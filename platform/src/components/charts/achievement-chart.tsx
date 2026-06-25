'use client';

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { MonthlyPoint, YoYPoint } from '@/lib/target-trend';
import { hasData } from '@/lib/target-trend';

export type ChartView = 'monthly' | 'yoy';

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number | null }>;
  label?: string;
}

/** Compact number for axis ticks (1500 → 1.5k). */
function fmtTick(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return `${v}`;
}
function fmtVal(v: number | null, unit: string): string {
  if (v == null) return '—';
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${unit ? ` ${unit}` : ''}`;
}

function MonthlyTooltip({ active, payload, label, unit }: TooltipProps & { unit: string }) {
  if (!active || !payload?.length) return null;
  const target = payload.find((p) => p.name === 'Target')?.value ?? 0;
  const achieved = payload.find((p) => p.name === 'Achieved')?.value ?? 0;
  const pct = (target as number) > 0 ? Math.round(((achieved as number) / (target as number)) * 100) : 0;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {payload.filter((p) => p.name !== 'Trend').map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-gray-600">{entry.name}:</span>
          <span className="font-medium">{fmtVal(entry.value, unit)}</span>
        </div>
      ))}
      {(target as number) > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <span className={`font-semibold ${pct >= 100 ? 'text-green-600' : pct >= 85 ? 'text-amber-600' : 'text-red-600'}`}>
            {pct}% achievement
          </span>
        </div>
      )}
    </div>
  );
}

function YoYTooltip({ active, payload, label, unit, labels }: TooltipProps & { unit: string; labels: { prev: string; cur: string } }) {
  if (!active || !payload?.length) return null;
  const target = payload.find((p) => p.name === 'Target')?.value;
  const fy25 = payload.find((p) => p.name === labels.prev)?.value;
  const fy26 = payload.find((p) => p.name === labels.cur)?.value;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {target != null && (
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-gray-300" />
          <span className="text-gray-600">Target:</span>
          <span className="font-medium">{fmtVal(target, unit)}</span>
        </div>
      )}
      {fy25 != null && (
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-[#94a3b8]" />
          <span className="text-gray-600">{labels.prev}:</span>
          <span className="font-medium">{fmtVal(fy25, unit)}</span>
        </div>
      )}
      {fy26 != null && (
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)]" />
          <span className="text-gray-600">{labels.cur}:</span>
          <span className="font-medium">{fmtVal(fy26, unit)}</span>
        </div>
      )}
      {fy25 != null && fy26 != null && (fy25 as number) > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <span className={`font-semibold ${(fy26 as number) >= (fy25 as number) ? 'text-green-600' : 'text-red-500'}`}>
            {(fy26 as number) >= (fy25 as number) ? '▲' : '▼'}{' '}
            {Math.abs(Math.round((((fy26 as number) - (fy25 as number)) / (fy25 as number)) * 100))}% YoY
          </span>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-[220px] flex items-center justify-center">
      <p className="text-xs text-gray-400">No target data yet for this period.</p>
    </div>
  );
}

interface AchievementChartProps {
  view?: ChartView;
  unit?: string;
  monthly?: MonthlyPoint[];
  yoy?: YoYPoint[];
  yoyLabels?: { prev: string; cur: string };
}

export function AchievementChart({
  view = 'monthly',
  unit = '',
  monthly = [],
  yoy = [],
  yoyLabels = { prev: 'Prev FY', cur: 'This FY' },
}: AchievementChartProps) {
  if (view === 'yoy') {
    if (!hasData(yoy)) return <EmptyState />;
    return (
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={yoy} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
          <YAxis tickFormatter={fmtTick} tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false} width={42} />
          <Tooltip content={(p) => <YoYTooltip {...(p as unknown as TooltipProps)} unit={unit} labels={yoyLabels} />} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} iconType="circle" iconSize={7} />
          <Bar dataKey="target" name="Target" fill="#e5e7eb" radius={[3, 3, 0, 0]} barSize={12} />
          <Bar dataKey="fy25" name={yoyLabels.prev} fill="#94a3b8" radius={[3, 3, 0, 0]} barSize={12} />
          <Bar dataKey="fy26" name={yoyLabels.cur} fill="var(--brand-primary)" radius={[3, 3, 0, 0]} barSize={12} />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  if (!hasData(monthly)) return <EmptyState />;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={monthly} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
        <YAxis tickFormatter={fmtTick} tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false} width={42} />
        <Tooltip content={(p) => <MonthlyTooltip {...(p as unknown as TooltipProps)} unit={unit} />} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} iconType="circle" iconSize={7} />
        <Bar dataKey="target" name="Target" fill="#e5e7eb" radius={[3, 3, 0, 0]} barSize={20} />
        <Bar dataKey="achieved" name="Achieved" fill="var(--brand-primary)" radius={[3, 3, 0, 0]} barSize={20} />
        <Line type="monotone" dataKey="achieved" name="Trend" stroke="#1A1A2E" strokeWidth={2} dot={{ fill: '#1A1A2E', r: 3 }} legendType="none" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
