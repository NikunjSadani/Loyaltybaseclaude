'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts';

const achievementData = [
  { region: 'Mumbai', target: 45.0, achieved: 48.3, achievement: 107 },
  { region: 'Delhi NCR', target: 38.0, achieved: 35.1, achievement: 92 },
  { region: 'Bengaluru', target: 32.0, achieved: 34.8, achievement: 109 },
  { region: 'Chennai', target: 28.0, achieved: 24.5, achievement: 88 },
  { region: 'Hyderabad', target: 25.0, achieved: 26.9, achievement: 108 },
  { region: 'Kolkata', target: 22.0, achieved: 19.8, achievement: 90 },
  { region: 'Pune', target: 18.0, achieved: 20.1, achievement: 112 },
  { region: 'Ahmedabad', target: 16.0, achieved: 14.2, achievement: 89 },
];

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number }>;
  label?: string;
}

const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    const achieved = payload.find((p) => p.name === 'Achieved')?.value ?? 0;
    const target = payload.find((p) => p.name === 'Target')?.value ?? 0;
    const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-gray-800 mb-2">{label}</p>
        {payload.map((entry) => (
          <div key={entry.name} className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-gray-600">{entry.name}:</span>
            <span className="font-medium">₹{entry.value}Cr</span>
          </div>
        ))}
        <div className="mt-2 pt-2 border-t border-gray-100">
          <span className={`font-semibold ${pct >= 100 ? 'text-green-600' : 'text-amber-600'}`}>
            {pct}% Achievement
          </span>
        </div>
      </div>
    );
  }
  return null;
};

export function AchievementChart() {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={achievementData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis
          dataKey="region"
          tick={{ fontSize: 11, fill: '#6b7280' }}
          tickLine={false}
          axisLine={{ stroke: '#e5e7eb' }}
        />
        <YAxis
          tickFormatter={(v) => `₹${v}Cr`}
          tick={{ fontSize: 11, fill: '#6b7280' }}
          tickLine={false}
          axisLine={false}
          width={55}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 16 }} iconType="circle" iconSize={8} />
        <Bar dataKey="target" name="Target" fill="#e5e7eb" radius={[3, 3, 0, 0]} />
        <Bar dataKey="achieved" name="Achieved" radius={[3, 3, 0, 0]}>
          {achievementData.map((entry, index) => (
            <Cell
              key={index}
              fill={entry.achievement >= 100 ? '#16a34a' : entry.achievement >= 90 ? '#f59e0b' : '#C8102E'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
