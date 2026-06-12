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

export type ChartView = 'monthly' | 'yoy';

// Last 6 months: target vs achieved
const monthlyData = [
  { month: 'Dec', target: 18.0, achieved: 14.2 },
  { month: 'Jan', target: 20.0, achieved: 17.8 },
  { month: 'Feb', target: 22.0, achieved: 21.4 },
  { month: 'Mar', target: 25.0, achieved: 27.1 },
  { month: 'Apr', target: 28.0, achieved: 26.3 },
  { month: 'May', target: 30.0, achieved: 19.5 },
];

// Year on year: same months, FY2024-25 vs FY2025-26
const yoyData = [
  { month: 'Apr', target: 22.0, fy25: 18.4, fy26: 19.5 },
  { month: 'May', target: 24.0, fy25: 21.2, fy26: 19.5 },
  { month: 'Jun', target: 26.0, fy25: 24.8, fy26: null },
  { month: 'Jul', target: 28.0, fy25: 27.3, fy26: null },
  { month: 'Aug', target: 28.0, fy25: 25.1, fy26: null },
  { month: 'Sep', target: 30.0, fy25: 29.4, fy26: null },
  { month: 'Oct', target: 32.0, fy25: 31.8, fy26: null },
  { month: 'Nov', target: 32.0, fy25: 28.6, fy26: null },
  { month: 'Dec', target: 30.0, fy25: 22.1, fy26: 14.2 },
  { month: 'Jan', target: 28.0, fy25: 25.9, fy26: 17.8 },
  { month: 'Feb', target: 28.0, fy25: 26.4, fy26: 21.4 },
  { month: 'Mar', target: 30.0, fy25: 32.1, fy26: 27.1 },
];

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number | null }>;
  label?: string;
}

const MonthlyTooltip = ({ active, payload, label }: TooltipProps) => {
  if (!active || !payload?.length) return null;
  const target = payload.find((p) => p.name === 'Target')?.value ?? 0;
  const achieved = payload.find((p) => p.name === 'Achieved')?.value ?? 0;
  const pct = (target as number) > 0 ? Math.round(((achieved as number) / (target as number)) * 100) : 0;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {payload.filter(p => p.name !== 'Trend').map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-gray-600">{entry.name}:</span>
          <span className="font-medium">₹{entry.value}L</span>
        </div>
      ))}
      <div className="mt-2 pt-2 border-t border-gray-100">
        <span className={`font-semibold ${pct >= 100 ? 'text-green-600' : pct >= 85 ? 'text-amber-600' : 'text-red-600'}`}>
          {pct}% achievement
        </span>
      </div>
    </div>
  );
};

const YoYTooltip = ({ active, payload, label }: TooltipProps) => {
  if (!active || !payload?.length) return null;
  const target  = payload.find((p) => p.name === 'Target')?.value;
  const fy25    = payload.find((p) => p.name === 'FY 24-25')?.value;
  const fy26    = payload.find((p) => p.name === 'FY 25-26')?.value;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
      <p className="font-semibold text-gray-800 mb-2">{label}</p>
      {target != null && (
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-gray-300" />
          <span className="text-gray-600">Target:</span>
          <span className="font-medium">₹{target}L</span>
        </div>
      )}
      {fy25 != null && (
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-[#94a3b8]" />
          <span className="text-gray-600">FY 24-25:</span>
          <span className="font-medium">₹{fy25}L</span>
        </div>
      )}
      {fy26 != null && (
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)]" />
          <span className="text-gray-600">FY 25-26:</span>
          <span className="font-medium">₹{fy26}L</span>
        </div>
      )}
      {fy25 != null && fy26 != null && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <span className={`font-semibold ${(fy26 as number) >= (fy25 as number) ? 'text-green-600' : 'text-red-500'}`}>
            {(fy26 as number) >= (fy25 as number) ? '▲' : '▼'}{' '}
            {Math.abs(Math.round(((fy26 as number) - (fy25 as number)) / (fy25 as number) * 100))}% YoY
          </span>
        </div>
      )}
    </div>
  );
};

interface AchievementChartProps {
  view?: ChartView;
}

export function AchievementChart({ view = 'monthly' }: AchievementChartProps) {
  if (view === 'yoy') {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={yoyData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
          <YAxis tickFormatter={(v) => `₹${v}L`} tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false} width={42} />
          <Tooltip content={<YoYTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} iconType="circle" iconSize={7} />
          <Bar dataKey="target" name="Target" fill="#e5e7eb" radius={[3, 3, 0, 0]} barSize={12} />
          <Bar dataKey="fy25"   name="FY 24-25" fill="#94a3b8" radius={[3, 3, 0, 0]} barSize={12} />
          <Bar dataKey="fy26"   name="FY 25-26" fill="var(--brand-primary)" radius={[3, 3, 0, 0]} barSize={12} />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={monthlyData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
        <YAxis tickFormatter={(v) => `₹${v}L`} tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false} width={42} />
        <Tooltip content={<MonthlyTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} iconType="circle" iconSize={7} />
        <Bar dataKey="target"   name="Target"   fill="#e5e7eb" radius={[3, 3, 0, 0]} barSize={20} />
        <Bar dataKey="achieved" name="Achieved" fill="var(--brand-primary)" radius={[3, 3, 0, 0]} barSize={20} />
        <Line type="monotone" dataKey="achieved" name="Trend" stroke="#1A1A2E" strokeWidth={2} dot={{ fill: '#1A1A2E', r: 3 }} legendType="none" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
