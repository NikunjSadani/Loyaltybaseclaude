'use client';

import {
  ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';

export type SalesChartView    = 'monthly' | 'yoy';
export type SalesOutletFilter = 'ALL' | 'VRIDDHI' | 'SAMBANDH';

// ── Mock data per program ────────────────────────────────────────────────────
const MONTHLY: Record<SalesOutletFilter, { month: string; target: number; achieved: number }[]> = {
  ALL: [
    { month: 'Dec', target: 8.0,  achieved: 6.2 },
    { month: 'Jan', target: 9.0,  achieved: 8.1 },
    { month: 'Feb', target: 10.0, achieved: 9.8 },
    { month: 'Mar', target: 12.0, achieved: 13.1 },
    { month: 'Apr', target: 13.0, achieved: 11.9 },
    { month: 'May', target: 14.0, achieved: 8.4 },
  ],
  VRIDDHI: [
    { month: 'Dec', target: 4.0, achieved: 3.1 },
    { month: 'Jan', target: 4.5, achieved: 4.0 },
    { month: 'Feb', target: 5.0, achieved: 4.9 },
    { month: 'Mar', target: 6.0, achieved: 6.8 },
    { month: 'Apr', target: 6.5, achieved: 5.9 },
    { month: 'May', target: 7.0, achieved: 4.2 },
  ],
  SAMBANDH: [
    { month: 'Dec', target: 3.0, achieved: 2.4 },
    { month: 'Jan', target: 3.2, achieved: 3.0 },
    { month: 'Feb', target: 3.5, achieved: 3.4 },
    { month: 'Mar', target: 4.0, achieved: 4.6 },
    { month: 'Apr', target: 4.5, achieved: 4.2 },
    { month: 'May', target: 5.0, achieved: 3.1 },
  ],
};

const YOY: Record<SalesOutletFilter, { month: string; target: number; fy25: number; fy26: number | null }[]> = {
  ALL: [
    { month: 'Apr', target: 10.0, fy25: 8.2,  fy26: 11.9 },
    { month: 'May', target: 11.0, fy25: 9.4,  fy26: 8.4 },
    { month: 'Jun', target: 11.5, fy25: 10.8, fy26: null },
    { month: 'Jul', target: 12.0, fy25: 11.2, fy26: null },
    { month: 'Aug', target: 12.0, fy25: 10.5, fy26: null },
    { month: 'Sep', target: 13.0, fy25: 12.6, fy26: null },
    { month: 'Oct', target: 14.0, fy25: 13.9, fy26: null },
    { month: 'Nov', target: 13.0, fy25: 11.8, fy26: null },
    { month: 'Dec', target: 12.0, fy25: 9.4,  fy26: 6.2 },
    { month: 'Jan', target: 12.0, fy25: 10.8, fy26: 8.1 },
    { month: 'Feb', target: 12.5, fy25: 11.4, fy26: 9.8 },
    { month: 'Mar', target: 14.0, fy25: 14.2, fy26: 13.1 },
  ],
  VRIDDHI: [
    { month: 'Apr', target: 5.0, fy25: 4.1,  fy26: 5.9 },
    { month: 'May', target: 5.5, fy25: 4.7,  fy26: 4.2 },
    { month: 'Jun', target: 5.8, fy25: 5.4,  fy26: null },
    { month: 'Jul', target: 6.0, fy25: 5.6,  fy26: null },
    { month: 'Aug', target: 6.0, fy25: 5.2,  fy26: null },
    { month: 'Sep', target: 6.5, fy25: 6.3,  fy26: null },
    { month: 'Oct', target: 7.0, fy25: 6.9,  fy26: null },
    { month: 'Nov', target: 6.5, fy25: 5.9,  fy26: null },
    { month: 'Dec', target: 6.0, fy25: 4.7,  fy26: 3.1 },
    { month: 'Jan', target: 6.0, fy25: 5.4,  fy26: 4.0 },
    { month: 'Feb', target: 6.2, fy25: 5.7,  fy26: 4.9 },
    { month: 'Mar', target: 7.0, fy25: 7.1,  fy26: 6.8 },
  ],
  SAMBANDH: [
    { month: 'Apr', target: 3.5, fy25: 3.0,  fy26: 4.2 },
    { month: 'May', target: 3.8, fy25: 3.4,  fy26: 3.1 },
    { month: 'Jun', target: 4.0, fy25: 3.9,  fy26: null },
    { month: 'Jul', target: 4.2, fy25: 4.0,  fy26: null },
    { month: 'Aug', target: 4.2, fy25: 3.7,  fy26: null },
    { month: 'Sep', target: 4.5, fy25: 4.5,  fy26: null },
    { month: 'Oct', target: 5.0, fy25: 4.9,  fy26: null },
    { month: 'Nov', target: 4.5, fy25: 4.1,  fy26: null },
    { month: 'Dec', target: 4.0, fy25: 3.4,  fy26: 2.4 },
    { month: 'Jan', target: 4.0, fy25: 3.8,  fy26: 3.0 },
    { month: 'Feb', target: 4.2, fy25: 4.0,  fy26: 3.4 },
    { month: 'Mar', target: 5.0, fy25: 5.2,  fy26: 4.6 },
  ],
};

// ── Tooltips ─────────────────────────────────────────────────────────────────
interface TpProps {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number | null }>;
  label?: string;
}

const MonthlyTooltip = ({ active, payload, label }: TpProps) => {
  if (!active || !payload?.length) return null;
  const target   = (payload.find(p => p.name === 'Target')?.value   ?? 0) as number;
  const achieved = (payload.find(p => p.name === 'Achieved')?.value ?? 0) as number;
  const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 shadow-lg text-xs min-w-[130px]">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {payload.filter(p => p.name !== 'Trend').map(e => (
        <div key={e.name} className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: e.color }} />
          <span className="text-gray-500">{e.name}:</span>
          <span className="font-semibold ml-auto">₹{e.value}L</span>
        </div>
      ))}
      <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between">
        <span className="text-gray-400">Achievement</span>
        <span className={`font-bold ${pct >= 100 ? 'text-emerald-600' : pct >= 80 ? 'text-amber-600' : 'text-red-600'}`}>
          {pct}%
        </span>
      </div>
    </div>
  );
};

const YoYTooltip = ({ active, payload, label }: TpProps) => {
  if (!active || !payload?.length) return null;
  const fy25 = payload.find(p => p.name === 'FY 24-25')?.value as number | null;
  const fy26 = payload.find(p => p.name === 'FY 25-26')?.value as number | null;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 shadow-lg text-xs min-w-[140px]">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {payload.map(e => e.value != null && (
        <div key={e.name} className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: e.color }} />
          <span className="text-gray-500">{e.name}:</span>
          <span className="font-semibold ml-auto">₹{e.value}L</span>
        </div>
      ))}
      {fy25 != null && fy26 != null && (
        <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between">
          <span className="text-gray-400">YoY change</span>
          <span className={`font-bold ${fy26 >= fy25 ? 'text-emerald-600' : 'text-red-500'}`}>
            {fy26 >= fy25 ? '▲' : '▼'} {Math.abs(Math.round(((fy26 - fy25) / fy25) * 100))}%
          </span>
        </div>
      )}
    </div>
  );
};

// ── Chart component ───────────────────────────────────────────────────────────
interface Props {
  view: SalesChartView;
  outlet: SalesOutletFilter;
}

export function SalesAchievementChart({ view, outlet }: Props) {
  if (view === 'yoy') {
    const data = YOY[outlet];
    return (
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
          <YAxis tickFormatter={v => `₹${v}L`} tick={{ fontSize: 9, fill: '#9ca3af' }} tickLine={false} axisLine={false} width={38} />
          <Tooltip content={<YoYTooltip />} />
          <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} iconType="circle" iconSize={6} />
          <Bar dataKey="target" name="Target"    fill="#e5e7eb" radius={[3,3,0,0]} barSize={10} />
          <Bar dataKey="fy25"   name="FY 24-25"  fill="#94a3b8" radius={[3,3,0,0]} barSize={10} />
          <Bar dataKey="fy26"   name="FY 25-26"  fill="var(--brand-primary)" radius={[3,3,0,0]} barSize={10} />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  const data = MONTHLY[outlet];
  // Add a 100% reference line at target
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
        <YAxis tickFormatter={v => `₹${v}L`} tick={{ fontSize: 9, fill: '#9ca3af' }} tickLine={false} axisLine={false} width={38} />
        <Tooltip content={<MonthlyTooltip />} />
        <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} iconType="circle" iconSize={6} />
        <Bar dataKey="target"   name="Target"   fill="#e5e7eb" radius={[3,3,0,0]} barSize={22} />
        <Bar dataKey="achieved" name="Achieved" fill="var(--brand-primary)" radius={[3,3,0,0]} barSize={22} />
        <Line type="monotone" dataKey="achieved" stroke="#1A1A2E" strokeWidth={2} dot={{ fill: '#1A1A2E', r: 3 }} legendType="none" name="Trend" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
