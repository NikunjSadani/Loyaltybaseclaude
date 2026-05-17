'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Plus, Search, ChevronRight, ClipboardList } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/utils';
import { KYCStatus } from '@/types';
import { cn } from '@/lib/utils';

interface KYCEntry {
  id: string;
  partnerName: string;
  firmName: string;
  mobile: string;
  status: KYCStatus;
  submittedAt: string;
  updatedAt: string;
  rejectionReason?: string;
}

const STATUS_FILTERS: { key: 'ALL' | KYCStatus; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: KYCStatus.PENDING, label: 'Pending' },
  { key: KYCStatus.SUBMITTED, label: 'Submitted' },
  { key: KYCStatus.UNDER_REVIEW, label: 'In Review' },
  { key: KYCStatus.APPROVED, label: 'Approved' },
  { key: KYCStatus.REJECTED, label: 'Rejected' },
  { key: KYCStatus.RESUBMISSION_REQUIRED, label: 'Re-upload' },
];

const kycBadge: Record<KYCStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string }> = {
  [KYCStatus.APPROVED]: { variant: 'success', label: 'Approved' },
  [KYCStatus.PENDING]: { variant: 'warning', label: 'Pending' },
  [KYCStatus.SUBMITTED]: { variant: 'info', label: 'Submitted' },
  [KYCStatus.UNDER_REVIEW]: { variant: 'info', label: 'In Review' },
  [KYCStatus.REJECTED]: { variant: 'danger', label: 'Rejected' },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger', label: 'Re-upload' },
};

const MOCK_KYC: KYCEntry[] = [
  { id: 'k1', partnerName: 'Rajesh Kumar', firmName: 'Kumar General Store', mobile: '9876543210', status: KYCStatus.APPROVED, submittedAt: '2026-04-01', updatedAt: '2026-04-05' },
  { id: 'k2', partnerName: 'Amit Sharma', firmName: 'Sharma Kirana', mobile: '9765432109', status: KYCStatus.PENDING, submittedAt: '2026-05-10', updatedAt: '2026-05-10' },
  { id: 'k3', partnerName: 'Suresh Patel', firmName: 'Patel Grocery', mobile: '9654321098', status: KYCStatus.REJECTED, submittedAt: '2026-04-20', updatedAt: '2026-05-01', rejectionReason: 'GST certificate invalid' },
  { id: 'k4', partnerName: 'Gurpreet Singh', firmName: 'Singh Supermart', mobile: '9543210987', status: KYCStatus.APPROVED, submittedAt: '2026-03-15', updatedAt: '2026-03-20' },
  { id: 'k5', partnerName: 'Vijay Mehta', firmName: 'Mehta Provisions', mobile: '9432109876', status: KYCStatus.SUBMITTED, submittedAt: '2026-05-14', updatedAt: '2026-05-14' },
  { id: 'k6', partnerName: 'Priya Desai', firmName: 'Desai Grocers', mobile: '9321098765', status: KYCStatus.UNDER_REVIEW, submittedAt: '2026-05-12', updatedAt: '2026-05-13' },
];

function KYCListContent() {
  const searchParams = useSearchParams();
  const statusParam = searchParams.get('status') as KYCStatus | null;

  const [entries, setEntries] = useState<KYCEntry[]>([]);
  const [filter, setFilter] = useState<'ALL' | KYCStatus>(statusParam ?? 'ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setEntries(MOCK_KYC);
      setLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, []);

  const filtered = entries.filter((e) => {
    const matchesStatus = filter === 'ALL' || e.status === filter;
    const matchesSearch =
      e.partnerName.toLowerCase().includes(search.toLowerCase()) ||
      e.firmName.toLowerCase().includes(search.toLowerCase()) ||
      e.mobile.includes(search);
    return matchesStatus && matchesSearch;
  });

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">KYC Submissions</h1>
        <Link href="/sales/kyc/new">
          <Button variant="primary" size="sm">
            <Plus className="h-4 w-4" />
            New KYC
          </Button>
        </Link>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, firm or mobile..."
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#C8102E]/20 focus:border-[#C8102E]"
        />
      </div>

      {/* Status filters */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
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
          icon={<ClipboardList className="h-8 w-8" />}
          title="No KYC submissions"
          description="No entries match your current filter."
        />
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <div className="divide-y divide-gray-50">
              {filtered.map((entry) => {
                const { variant, label } = kycBadge[entry.status];
                return (
                  <Link
                    key={entry.id}
                    href={`/sales/kyc/${entry.id}`}
                    className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-gray-900 truncate">
                          {entry.firmName}
                        </p>
                        <Badge variant={variant}>{label}</Badge>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{entry.partnerName} · {entry.mobile}</p>
                      {entry.rejectionReason && (
                        <p className="text-xs text-red-600 mt-0.5 truncate">
                          Reason: {entry.rejectionReason}
                        </p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">
                        Updated {formatDate(entry.updatedAt)}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function KYCListPage() {
  return (
    <Suspense fallback={<Spinner size="lg" />}>
      <KYCListContent />
    </Suspense>
  );
}
