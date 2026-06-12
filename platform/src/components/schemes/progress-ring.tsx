'use client';

import React from 'react';

interface ProgressRingProps {
  value: number; // 0-100
  size?: number;
  strokeWidth?: number;
  className?: string;
  label?: string;
}

function getColor(pct: number): string {
  if (pct < 50) return 'var(--brand-primary)';
  if (pct <= 80) return '#f59e0b';
  return '#10b981';
}

export function ProgressRing({
  value,
  size = 64,
  strokeWidth = 6,
  className,
  label,
}: ProgressRingProps) {
  const pct = Math.min(100, Math.max(0, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (pct / 100) * circumference;
  const color = getColor(pct);
  const center = size / 2;

  return (
    <div
      className={`relative flex items-center justify-center ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        {/* Track */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={strokeWidth}
        />
        {/* Progress */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xs font-bold text-gray-900 leading-none">{pct}%</span>
        {label && <span className="text-[9px] text-gray-400 mt-0.5">{label}</span>}
      </div>
    </div>
  );
}

export default ProgressRing;
