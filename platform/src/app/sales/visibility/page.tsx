'use client';

import React, { useState, useEffect } from 'react';
import { Eye, Camera, Search, ChevronRight, Plus, Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';

type VisibilityStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'UNDER_REVIEW';

interface VisibilitySubmission {
  id: string;
  outletName: string;
  city: string;
  submittedAt: string;
  status: VisibilityStatus;
  pointsEarned?: number;
  rejectionReason?: string;
  imageCount: number;
}

const STATUS_FILTERS: { key: 'ALL' | VisibilityStatus; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'UNDER_REVIEW', label: 'In Review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

const statusConfig: Record<VisibilityStatus, {
  variant: 'success' | 'warning' | 'danger' | 'info' | 'default';
  label: string;
  icon: React.ReactNode;
}> = {
  SUBMITTED: { variant: 'info', label: 'Submitted', icon: <Clock className="h-3.5 w-3.5 text-blue-500" /> },
  UNDER_REVIEW: { variant: 'warning', label: 'In Review', icon: <AlertCircle className="h-3.5 w-3.5 text-amber-500" /> },
  APPROVED: { variant: 'success', label: 'Approved', icon: <CheckCircle className="h-3.5 w-3.5 text-emerald-500" /> },
  REJECTED: { variant: 'danger', label: 'Rejected', icon: <XCircle className="h-3.5 w-3.5 text-red-500" /> },
};

const MOCK_SUBMISSIONS: VisibilitySubmission[] = [
  { id: 'v1', outletName: 'Kumar General Store', city: 'Andheri, Mumbai', submittedAt: '2026-05-14', status: 'APPROVED', pointsEarned: 100, imageCount: 3 },
  { id: 'v2', outletName: 'Singh Supermart', city: 'Malad, Mumbai', submittedAt: '2026-05-13', status: 'REJECTED', rejectionReason: 'Product display not clearly visible', imageCount: 2 },
  { id: 'v3', outletName: 'Sharma Kirana', city: 'Borivali, Mumbai', submittedAt: '2026-05-12', status: 'UNDER_REVIEW', imageCount: 4 },
  { id: 'v4', outletName: 'Patel Grocery', city: 'Thane', submittedAt: '2026-05-11', status: 'APPROVED', pointsEarned: 150, imageCount: 5 },
  { id: 'v5', outletName: 'Mehta Provisions', city: 'Kandivali, Mumbai', submittedAt: '2026-05-10', status: 'SUBMITTED', imageCount: 3 },
  { id: 'v6', outletName: 'Verma Traders', city: 'Mira Road, Thane', submittedAt: '2026-05-08', status: 'APPROVED', pointsEarned: 100, imageCount: 2 },
  { id: 'v7', outletName: 'Desai Grocers', city: 'Goregaon, Mumbai', submittedAt: '2026-05-07', status: 'REJECTED', rejectionReason: 'Duplicate submission detected', imageCount: 3 },
];

export default function SalesVisibilityPage() {
  const [submissions, setSubmissions] = useState<VisibilitySubmission[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | VisibilityStatus>('ALL');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setSubmissions(MOCK_SUBMISSIONS);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const filtered = submissions.filter((s) => {
    const matchesStatus = statusFilter === 'ALL' || s.status === statusFilter;
    const matchesSearch =
      s.outletName.toLowerCase().includes(search.toLowerCase()) ||
      s.city.toLowerCase().includes(search.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const totalEarned = submissions
    .filter((s) => s.status === 'APPROVED')
    .reduce((sum, s) => sum + (s.pointsEarned ?? 0), 0);

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Visibility</h1>
          <p className="text-sm text-gray-500">{totalEarned} pts earned this month</p>
        </div>
        <Button variant="primary" size="sm">
          <Camera className="h-4 w-4" />
          Submit
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by outlet or city..."
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
        />
      </div>

      {/* Status filters */}
      <div className="flex gap-2 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            className={cn(
              'px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
              statusFilter === f.key
                ? 'bg-[var(--brand-primary)] text-white'
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
          icon={<Eye className="h-8 w-8" />}
          title="No submissions found"
          description="Try adjusting your search or filter."
          className="py-12"
        />
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <div className="divide-y divide-gray-50">
              {filtered.map((sub) => {
                const config = statusConfig[sub.status];
                return (
                  <div
                    key={sub.id}
                    className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                  >
                    <div className="p-2.5 bg-gray-50 rounded-xl shrink-0">
                      {config.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-gray-900 truncate min-w-0 flex-1">
                          {sub.outletName}
                        </p>
                        <Badge variant={config.variant} className="flex-shrink-0 text-[10px]">
                          {config.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{sub.city}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-gray-400">{formatDate(sub.submittedAt)}</span>
                        <span className="text-xs text-gray-400">· {sub.imageCount} photo{sub.imageCount !== 1 ? 's' : ''}</span>
                        {sub.status === 'APPROVED' && sub.pointsEarned && (
                          <span className="text-xs font-medium text-emerald-600">+{sub.pointsEarned} pts</span>
                        )}
                      </div>
                      {sub.rejectionReason && (
                        <p className="text-xs text-red-500 mt-0.5 truncate">
                          {sub.rejectionReason}
                        </p>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
