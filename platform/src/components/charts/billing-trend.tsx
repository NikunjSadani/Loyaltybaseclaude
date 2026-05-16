'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const billingData = [
  { month: 'May-24', GOLD: 18.4, SILVER: 12.1, PLATINUM: 8.2, BRONZE: 6.5 },
  { month: 'Jun-24', GOLD: 21.3, SILVER: 13.5, PLATINUM: 9.1, BRONZE: 7.2 },
  { month: 'Jul-24', GOLD: 19.8, SILVER: 14.2, PLATINUM: 8.7, BRONZE: 6.9 },
  { month: 'Aug-24', GOLD: 23.5, SILVER: 15.8, PLATINUM: 10.2, BRONZE: 7.8 },
  { month: 'Sep-24', GOLD: 25.1, SILVER: 16.3, PLATINUM: 11.5, BRONZE: 8.4 },
  { month: 'Oct-24', GOLD: 28.7, SILVER: 18.1, PLATINUM: 13.2, BRONZE: 9.1 },
  { month: 'Nov-24', GOLD: 31.2, SILVER: 19.4, PLATINUM: 14.8, BRONZE: 10.3 },
  { month: 'Dec-24', GOLD: 35.6, SILVER: 22.7, PLATINUM: 16.1, BRONZE: 11.8 },
  { month: 'Jan-25', GOLD: 29.3, SILVER: 17.9, PLATINUM: 12.4, BRONZE: 8.7 },
  { month: 'Feb-25', GOLD: 27.8, SILVER: 16.5, PLATINUM: 11.8, BRONZE: 8.2 },
  { month: 'Mar-25', GOLD: 32.4, SILVER: 20.1, PLATINUM: 14.3, BRONZE: 9.6 },
  { month: 'Apr-25', GOLD: 36.9, SILVER: 23.4, PLATINUM: 17.2, BRONZE: 12.1 },
];

const COLORS = {
  GOLD: '#f59e0b',
  SILVER: '#6b7280',
  PLATINUM: '#8b5cf6',
  BRONZE: '#d97706',
};

const formatCrore = (value: number) => `₹${value}Cr`;

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number }>;
  label?: string;
}

const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-gray-800 mb-2">{label}</p>
        {payload.map((entry) => (
          <div key={entry.name} className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-gray-600">{entry.name}:</span>
            <span className="font-medium text-gray-900">₹{entry.value}Cr</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export function BillingTrendChart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={billingData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 11, fill: '#6b7280' }}
          tickLine={false}
          axisLine={{ stroke: '#e5e7eb' }}
        />
        <YAxis
          tickFormatter={formatCrore}
          tick={{ fontSize: 11, fill: '#6b7280' }}
          tickLine={false}
          axisLine={false}
          width={55}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 16 }}
          iconType="circle"
          iconSize={8}
        />
        {(Object.keys(COLORS) as Array<keyof typeof COLORS>).map((cls) => (
          <Line
            key={cls}
            type="monotone"
            dataKey={cls}
            stroke={COLORS[cls]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
