'use client';

import React from 'react';
import { formatPoints } from '@/lib/utils';
import { teamChartMax, type ApiTeamMonth } from '../../_lib/employee';

/* ─── Team earned-vs-redeemed chart ─────────────────────────────────────────────
   A small, self-contained inline-SVG grouped-bar chart (NO charting dependency) — two
   bars per month (earned vs redeemed), scaled to the largest single bar across the
   series. Responsive via a fixed viewBox + width:100%; brand-primary for earned, a
   muted slate for redeemed. Honest empty render when there is no monthly data. ──── */

const EARNED_COLOR = 'var(--brand-primary)';
const REDEEMED_COLOR = '#94a3b8'; // slate-400 — reads as "spent" against the brand fill

// viewBox geometry (abstract units; the SVG scales to its container width).
const VB_W = 340;
const VB_H = 150;
const PAD_X = 6;
const PAD_TOP = 8;
const AXIS_H = 20; // room for the month labels under the bars
const PLOT_H = VB_H - PAD_TOP - AXIS_H;
const GROUP_GAP = 10; // gap between month groups
const BAR_GAP = 3; // gap between the two bars in a group

export function TeamEarnChart({ monthly }: { monthly: ApiTeamMonth[] }) {
  const months = monthly ?? [];

  if (months.length === 0) {
    return (
      <p className="text-xs text-gray-400 text-center py-6">No monthly activity to chart yet</p>
    );
  }

  const max = teamChartMax(months);
  const groupW = (VB_W - PAD_X * 2 - GROUP_GAP * (months.length - 1)) / months.length;
  const barW = Math.max(4, (groupW - BAR_GAP) / 2);

  return (
    <div>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        role="img"
        aria-label="Team points earned versus redeemed over the last months"
        preserveAspectRatio="xMidYMid meet"
        className="block"
      >
        {/* baseline */}
        <line
          x1={PAD_X}
          y1={PAD_TOP + PLOT_H}
          x2={VB_W - PAD_X}
          y2={PAD_TOP + PLOT_H}
          stroke="#e5e7eb"
          strokeWidth={1}
        />
        {months.map((m, i) => {
          const gx = PAD_X + i * (groupW + GROUP_GAP);
          const earnedH = (m.earned / max) * PLOT_H;
          const redeemedH = (m.redeemed / max) * PLOT_H;
          const earnedY = PAD_TOP + PLOT_H - earnedH;
          const redeemedY = PAD_TOP + PLOT_H - redeemedH;
          return (
            <g key={m.monthKey}>
              <rect
                x={gx}
                y={earnedY}
                width={barW}
                height={Math.max(0, earnedH)}
                rx={2}
                fill={EARNED_COLOR}
              >
                <title>{`${m.label}: earned ${formatPoints(m.earned)} pts`}</title>
              </rect>
              <rect
                x={gx + barW + BAR_GAP}
                y={redeemedY}
                width={barW}
                height={Math.max(0, redeemedH)}
                rx={2}
                fill={REDEEMED_COLOR}
              >
                <title>{`${m.label}: redeemed ${formatPoints(m.redeemed)} pts`}</title>
              </rect>
              <text
                x={gx + groupW / 2}
                y={VB_H - 6}
                textAnchor="middle"
                fontSize={10}
                fill="#9ca3af"
              >
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="mt-2 flex items-center justify-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: EARNED_COLOR }} />
          <span className="text-[11px] text-gray-500">Earned</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: REDEEMED_COLOR }} />
          <span className="text-[11px] text-gray-500">Redeemed</span>
        </span>
      </div>
    </div>
  );
}

export default TeamEarnChart;
