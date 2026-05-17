'use client';

import React, { useState, useEffect } from 'react';
import { Layers } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { SchemeCard } from '@/components/schemes/scheme-card';
import { cn } from '@/lib/utils';

type StatusFilter = 'ALL' | 'ACTIVE' | 'ACHIEVED' | 'MISSED' | 'UPCOMING';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'ACHIEVED', label: 'Achieved' },
  { key: 'MISSED', label: 'Missed' },
  { key: 'UPCOMING', label: 'Upcoming' },
];

const MOCK_SCHEMES = [
  {
    id: '1',
    name: 'Q2 Sales Push – Olive Oil',
    description: 'Earn bonus points for every unit of Bertolli Olive Oil sold this quarter',
    startDate: '2026-04-01',
    endDate: '2026-06-30',
    targetValue: 500,
    achievedValue: 380,
    incentiveEarned: 760,
    incentiveType: 'SALES',
    calculationMethod: 'SLAB',
    eligibilityNote: 'Open to Gold and Silver tier retailers with KYC Approved status.',
    status: 'ACTIVE' as const,
    slabs: [
      { minValue: 0, maxValue: 200, payoutValue: 2, isOverachievement: false },
      { minValue: 201, maxValue: 400, payoutValue: 2.5, isOverachievement: false },
      { minValue: 401, maxValue: undefined, payoutValue: 3, isOverachievement: false },
    ],
  },
  {
    id: '2',
    name: 'Summer Display Visibility',
    description: 'Submit photos of Deoleo product displays at your outlet entrance',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    targetValue: 10,
    achievedValue: 10,
    incentiveEarned: 200,
    incentiveType: 'VISIBILITY',
    calculationMethod: 'FLAT',
    eligibilityNote: 'All active retailers with any KYC status.',
    status: 'ACHIEVED' as const,
    slabs: [],
  },
  {
    id: '3',
    name: 'Wholesale Volume Bonus',
    description: 'Higher purchase volumes unlock better rewards this season',
    startDate: '2026-04-01',
    endDate: '2026-07-15',
    targetValue: 1000,
    achievedValue: 450,
    incentiveEarned: 450,
    incentiveType: 'SALES',
    calculationMethod: 'SLAB',
    eligibilityNote: 'Wholesalers only. Minimum order quantity applies.',
    status: 'ACTIVE' as const,
    slabs: [
      { minValue: 0, maxValue: 499, payoutValue: 1, isOverachievement: false },
      { minValue: 500, maxValue: 999, payoutValue: 1.5, isOverachievement: false },
      { minValue: 1000, maxValue: undefined, payoutValue: 2, isOverachievement: false },
    ],
  },
  {
    id: '4',
    name: 'Monsoon Referral Drive',
    description: 'Earn bonus points for every new outlet you onboard during monsoon season',
    startDate: '2026-07-01',
    endDate: '2026-09-30',
    targetValue: 5,
    achievedValue: 0,
    incentiveEarned: 0,
    incentiveType: 'REFERRAL',
    calculationMethod: 'PER_UNIT',
    eligibilityNote: 'All active partners with 6+ months on platform.',
    status: 'UPCOMING' as const,
    slabs: [],
  },
];

export default function SchemesPage() {
  const [schemes, setSchemes] = useState<typeof MOCK_SCHEMES>([]);
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setSchemes(MOCK_SCHEMES);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const filtered = filter === 'ALL' ? schemes : schemes.filter((s) => s.status === filter);

  return (
    <div className="space-y-5 fade-in">
      <h1 className="text-xl font-bold text-gray-900">My Schemes</h1>

      {/* Filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
              filter === f.key
                ? 'bg-[#C8102E] text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-48">
          <Spinner size="lg" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-8 w-8" />}
          title="No schemes found"
          description="No schemes match the selected filter."
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((scheme) => (
            <SchemeCard key={scheme.id} scheme={scheme} />
          ))}
        </div>
      )}
    </div>
  );
}
