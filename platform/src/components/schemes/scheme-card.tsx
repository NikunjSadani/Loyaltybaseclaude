'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Clock, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ProgressRing } from './progress-ring';
import { formatDate, formatPoints } from '@/lib/utils';
import { cn } from '@/lib/utils';

type SchemeStatus = 'ACTIVE' | 'ACHIEVED' | 'MISSED' | 'UPCOMING';

interface SchemeSlab {
  minValue: number;
  maxValue?: number;
  payoutValue: number;
  isOverachievement: boolean;
}

interface SchemeCardData {
  id: string;
  name: string;
  description?: string;
  startDate: string;
  endDate: string;
  targetValue?: number;
  achievedValue?: number;
  incentiveEarned?: number;
  incentiveType: string;
  calculationMethod: string;
  eligibilityNote?: string;
  slabs?: SchemeSlab[];
  status: SchemeStatus;
}

interface SchemeCardProps {
  scheme: SchemeCardData;
}

const statusConfig: Record<SchemeStatus, { variant: 'success' | 'danger' | 'warning' | 'info'; label: string }> = {
  ACTIVE: { variant: 'info', label: 'Active' },
  ACHIEVED: { variant: 'success', label: 'Achieved' },
  MISSED: { variant: 'danger', label: 'Missed' },
  UPCOMING: { variant: 'warning', label: 'Upcoming' },
};

export function SchemeCard({ scheme }: SchemeCardProps) {
  const [expanded, setExpanded] = useState(false);

  const pct = scheme.targetValue && scheme.achievedValue !== undefined
    ? Math.round((scheme.achievedValue / scheme.targetValue) * 100)
    : 0;

  const { variant, label } = statusConfig[scheme.status];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Main row */}
      <div className="p-4">
        <div className="flex items-start gap-4">
          {scheme.targetValue !== undefined && (
            <ProgressRing value={pct} size={60} />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-gray-900 leading-snug">{scheme.name}</p>
              <Badge variant={variant}>{label}</Badge>
            </div>
            {scheme.description && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{scheme.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
              <span className="text-xs text-gray-400 flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Ends {formatDate(scheme.endDate)}
              </span>
              {scheme.incentiveEarned !== undefined && (
                <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                  <Trophy className="h-3 w-3" />
                  {formatPoints(scheme.incentiveEarned)} pts earned
                </span>
              )}
            </div>
            {scheme.targetValue !== undefined && scheme.achievedValue !== undefined && (
              <p className="text-xs text-gray-600 mt-1">
                {formatPoints(scheme.achievedValue)} / {formatPoints(scheme.targetValue)} units
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Expand button */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-center gap-1 py-2 border-t border-gray-100 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
      >
        {expanded ? (
          <>Hide details <ChevronUp className="h-3.5 w-3.5" /></>
        ) : (
          <>View details <ChevronDown className="h-3.5 w-3.5" /></>
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-gray-100 p-4 bg-gray-50 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-gray-400 mb-0.5">Incentive Type</p>
              <p className="font-medium text-gray-700">{scheme.incentiveType}</p>
            </div>
            <div>
              <p className="text-gray-400 mb-0.5">Calculation</p>
              <p className="font-medium text-gray-700">{scheme.calculationMethod}</p>
            </div>
            <div>
              <p className="text-gray-400 mb-0.5">Start Date</p>
              <p className="font-medium text-gray-700">{formatDate(scheme.startDate)}</p>
            </div>
            <div>
              <p className="text-gray-400 mb-0.5">End Date</p>
              <p className="font-medium text-gray-700">{formatDate(scheme.endDate)}</p>
            </div>
          </div>

          {scheme.eligibilityNote && (
            <div>
              <p className="text-xs text-gray-400 mb-1">Eligibility</p>
              <p className="text-xs text-gray-700 bg-white border border-gray-200 rounded-lg px-3 py-2">
                {scheme.eligibilityNote}
              </p>
            </div>
          )}

          {scheme.slabs && scheme.slabs.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">Slab Table</p>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-xs">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">Min</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">Max</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">Payout</th>
                      <th className="px-3 py-2 text-left text-gray-500 font-semibold">Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {scheme.slabs.map((slab, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 text-gray-700">{formatPoints(slab.minValue)}</td>
                        <td className="px-3 py-2 text-gray-700">
                          {slab.maxValue ? formatPoints(slab.maxValue) : '∞'}
                        </td>
                        <td className="px-3 py-2 font-medium text-emerald-700">
                          {formatPoints(slab.payoutValue)} pts
                        </td>
                        <td className="px-3 py-2">
                          {slab.isOverachievement ? (
                            <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px] font-medium">
                              Over-achieve
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] font-medium">
                              Standard
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SchemeCard;
