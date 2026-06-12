'use client';

import { useState, useEffect } from 'react';
import {
  Plus,
  Search,
  Tag,
  Calendar,
  CheckCircle,
  Archive,
  Clock,
  ChevronRight,
  Filter,
  ClipboardList,
} from 'lucide-react';
import Link from 'next/link';
import { getAdminSchemes, seedAdminSchemes, type AdminPublishedScheme } from '@/lib/schemes';

const STATUS_STYLES: Record<string, string> = {
  ACTIVE:   'bg-green-100 text-green-700',
  DRAFT:    'bg-gray-100 text-gray-600',
  UPCOMING: 'bg-blue-100 text-blue-700',
  ARCHIVED: 'bg-gray-100 text-gray-500',
  EXPIRED:  'bg-red-50 text-red-500',
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  ACTIVE:   <CheckCircle className="w-3.5 h-3.5" />,
  DRAFT:    <Clock className="w-3.5 h-3.5" />,
  UPCOMING: <Calendar className="w-3.5 h-3.5" />,
  ARCHIVED: <Archive className="w-3.5 h-3.5" />,
  EXPIRED:  <Archive className="w-3.5 h-3.5" />,
};

const INCENTIVE_LABELS: Record<string, string> = {
  SALES:           'Sales Incentive',
  VISIBILITY:      'Visibility',
  SECONDARY_SALES: 'Secondary Sales',
  LOYALTY:         'Loyalty Points',
  REFERRAL:        'Referral Bonus',
  MILESTONE:       'Milestone',
};

const CALC_LABELS: Record<string, string> = {
  FLAT:       'Flat Amount',
  PERCENTAGE: 'Percentage',
  SLAB:       'Slab-based',
  PER_UNIT:   'Per Unit',
  HYBRID:     'Hybrid',
};

const CLASS_COLORS: Record<string, string> = {
  PLATINUM: 'text-purple-700 bg-purple-50',
  GOLD:     'text-amber-700 bg-amber-50',
  SILVER:   'text-gray-600 bg-gray-100',
  BRONZE:   'text-orange-700 bg-orange-50',
  STANDARD: 'text-blue-700 bg-blue-50',
};

const ALL_STATUSES = ['ALL', 'ACTIVE', 'DRAFT', 'UPCOMING', 'EXPIRED', 'ARCHIVED'] as const;

export default function SchemesPage() {
  const [schemes,      setSchemes]      = useState<AdminPublishedScheme[]>([]);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [typeFilter,   setTypeFilter]   = useState('ALL');

  useEffect(() => {
    seedAdminSchemes();          // no-op if data already exists
    setSchemes(getAdminSchemes());
  }, []);

  const filtered = schemes.filter((s) => {
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'ALL' || s.status === statusFilter;
    const matchType   = typeFilter === 'ALL' || s.incentiveType === typeFilter;
    return matchSearch && matchStatus && matchType;
  });

  const statusCounts = schemes.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">Scheme Management</h2>
          <p className="text-xs text-gray-500">{schemes.length} total schemes configured</p>
        </div>
        <Link
          href="/admin/schemes/new"
          className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Create Scheme
        </Link>
      </div>

      {/* Status summary pills */}
      <div className="flex flex-wrap gap-2">
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
              statusFilter === s
                ? 'border-[var(--brand-primary)] bg-red-50 text-[var(--brand-primary)]'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            {s === 'ALL' ? `All (${schemes.length})` : `${s} (${statusCounts[s] ?? 0})`}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search schemes..."
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
          >
            <option value="ALL">All Types</option>
            <option value="SALES">Sales Incentive</option>
            <option value="VISIBILITY">Visibility</option>
            <option value="SECONDARY_SALES">Secondary Sales</option>
            <option value="LOYALTY">Loyalty</option>
            <option value="REFERRAL">Referral</option>
            <option value="MILESTONE">Milestone</option>
          </select>
        </div>
      </div>

      {/* Scheme cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((scheme) => (
          <div
            key={scheme.id}
            className="bg-white rounded-xl border border-gray-200 hover:shadow-md transition-all overflow-hidden"
          >
            {/* Card header */}
            <div className={`px-4 py-2 ${scheme.status === 'ACTIVE' ? 'bg-green-50 border-b border-green-100' : 'bg-gray-50 border-b border-gray-100'}`}>
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[scheme.status] ?? 'bg-gray-100 text-gray-600'}`}
                >
                  {STATUS_ICONS[scheme.status]}
                  {scheme.status}
                </span>
                <span className="text-xs text-gray-400">{scheme.id}</span>
              </div>
            </div>

            {/* Card body */}
            <div className="p-4">
              <div className="flex items-start gap-2 mb-3">
                <div className="p-2 rounded-lg bg-red-50 flex-shrink-0">
                  <Tag className="w-4 h-4 text-[var(--brand-primary)]" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 leading-tight">{scheme.name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {INCENTIVE_LABELS[scheme.incentiveType ?? ''] ?? scheme.incentiveType ?? '—'}
                    {scheme.calculationMethod ? ` · ${CALC_LABELS[scheme.calculationMethod] ?? scheme.calculationMethod}` : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 mb-3 text-xs text-gray-500">
                <Calendar className="w-3.5 h-3.5" />
                {scheme.startDate} → {scheme.endDate}
              </div>

              {(scheme.applicableClasses ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4">
                  {(scheme.applicableClasses ?? []).map((cls) => (
                    <span key={cls} className={`text-xs px-1.5 py-0.5 rounded font-medium ${CLASS_COLORS[cls] ?? 'text-gray-600 bg-gray-100'}`}>
                      {cls}
                    </span>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 mb-4 text-xs">
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-gray-500">Partners Enrolled</p>
                  <p className="font-bold text-gray-900 mt-0.5">{(scheme.partnersEnrolled ?? 0).toLocaleString()}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-gray-500">Total Payout</p>
                  <p className="font-bold text-gray-900 mt-0.5">{scheme.totalPayout ?? '—'}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <Link
                  href={`/admin/schemes/${scheme.id}`}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-[var(--brand-primary)] text-[var(--brand-primary)] rounded-lg text-xs font-medium hover:bg-green-50 transition-colors"
                >
                  {scheme.status === 'DRAFT' ? 'Continue Editing' : 'View & Edit'}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Link>
                {scheme.status !== 'DRAFT' && (
                  <Link
                    href={`/admin/schemes/${scheme.id}/enrollments`}
                    className="flex items-center gap-1 py-2 px-3 border border-gray-200 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors"
                    title="View Enrollments"
                  >
                    <ClipboardList className="w-3.5 h-3.5" />
                  </Link>
                )}
              </div>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3 py-16 text-center bg-white rounded-xl border border-gray-200">
            <Tag className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-400">No schemes match your filters</p>
          </div>
        )}
      </div>
    </div>
  );
}
