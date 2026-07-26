'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, Tag, Calendar, CheckCircle, Clock, ChevronRight, Trash2,
  ClipboardList,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api-client';

// ─── Backend scheme shape (data-collection reality — reward-era columns dropped
//     from the UI per D5; they may still exist as inert DB columns). ───────────

interface BackendScheme {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  startDate: string;
  endDate: string;
  status: string;
  createdAt: string;
}

interface Pagination { page: number; limit: number; total: number; pages: number }
interface ListSchemesResponse { schemes: BackendScheme[]; pagination: Pagination }

const PAGE_SIZE = 20;

// Prisma SchemeStatus (the old UPCOMING/ARCHIVED values were never valid — D6).
const STATUS_STYLES: Record<string, string> = {
  ACTIVE:    'bg-green-100 text-green-700',
  DRAFT:     'bg-gray-100 text-gray-600',
  PAUSED:    'bg-blue-100 text-blue-700',
  EXPIRED:   'bg-red-50 text-red-500',
  CANCELLED: 'bg-red-100 text-red-600',
};
const STATUS_ICONS: Record<string, React.ReactNode> = {
  ACTIVE:  <CheckCircle className="w-3.5 h-3.5" />,
  DRAFT:   <Clock className="w-3.5 h-3.5" />,
  PAUSED:  <Calendar className="w-3.5 h-3.5" />,
};
const ALL_STATUSES = ['ALL', 'ACTIVE', 'DRAFT', 'PAUSED', 'EXPIRED', 'CANCELLED'] as const;

export default function SchemesPage() {
  const [schemes,      setSchemes]      = useState<BackendScheme[]>([]);
  const [pagination,   setPagination]   = useState<Pagination | null>(null);
  const [page,         setPage]         = useState(1);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const loadSchemes = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search.trim())          params.set('search', search.trim());
    if (statusFilter !== 'ALL') params.set('status', statusFilter);
    const result = await api.get<ListSchemesResponse>(`/api/schemes?${params.toString()}`);
    if (result.success) {
      setSchemes(result.data.schemes);
      setPagination(result.data.pagination ?? null);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [page, search, statusFilter]);

  useEffect(() => {
    const t = setTimeout(() => { void loadSchemes(); }, 250);
    return () => clearTimeout(t);
  }, [loadSchemes]);

  useEffect(() => { setPage(1); }, [search, statusFilter]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this scheme? This cannot be undone.')) return;
    const result = await api.del<{ message: string }>(`/api/schemes/${id}`);
    if (result.success) setSchemes((prev) => prev.filter((s) => s.id !== id));
    else alert(`Delete failed: ${result.error}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-gray-400">Loading schemes…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-20 text-center">
        <p className="text-sm text-red-500">{error}</p>
        <button onClick={loadSchemes} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">Scheme Management</h2>
          <p className="text-xs text-gray-500">
            {pagination ? `${pagination.total} scheme${pagination.total === 1 ? '' : 's'}` : `${schemes.length} schemes`}
            {' · data-collection instruments'}
          </p>
        </div>
        <Link href="/admin/schemes/new"
          className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors">
          <Plus className="w-4 h-4" /> Create Scheme
        </Link>
      </div>

      {/* Status pills */}
      <div className="flex flex-wrap gap-2">
        {ALL_STATUSES.map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${statusFilter === s ? 'border-[var(--brand-primary)] bg-red-50 text-[var(--brand-primary)]' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
            {s === 'ALL' ? `All${pagination ? ` (${pagination.total})` : ''}` : s}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search schemes..."
          className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {schemes.map((scheme) => (
          <div key={scheme.id} className="bg-white rounded-xl border border-gray-200 hover:shadow-md transition-all overflow-hidden">
            <div className={`px-4 py-2 ${scheme.status === 'ACTIVE' ? 'bg-green-50 border-b border-green-100' : 'bg-gray-50 border-b border-gray-100'}`}>
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[scheme.status] ?? 'bg-gray-100 text-gray-600'}`}>
                  {STATUS_ICONS[scheme.status]}{scheme.status}
                </span>
                <span className="text-xs text-gray-400 font-mono">{scheme.code}</span>
              </div>
            </div>
            <div className="p-4">
              <div className="flex items-start gap-2 mb-3">
                <div className="p-2 rounded-lg bg-red-50 flex-shrink-0"><Tag className="w-4 h-4 text-[var(--brand-primary)]" /></div>
                <h3 className="text-sm font-semibold text-gray-900 leading-tight">{scheme.name}</h3>
              </div>
              <div className="flex items-center gap-1 mb-3 text-xs text-gray-500">
                <Calendar className="w-3.5 h-3.5" />
                {scheme.startDate.slice(0, 10)} → {scheme.endDate.slice(0, 10)}
              </div>
              {scheme.description && <p className="text-xs text-gray-500 mb-3 line-clamp-2">{scheme.description}</p>}
              <div className="flex gap-2">
                <Link href={`/admin/schemes/${scheme.id}`}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-[var(--brand-primary)] text-[var(--brand-primary)] rounded-lg text-xs font-medium hover:bg-green-50 transition-colors">
                  {scheme.status === 'DRAFT' ? 'Continue Setup' : 'Manage'}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Link>
                {scheme.status !== 'DRAFT' && (
                  <Link href={`/admin/schemes/${scheme.id}/enrollments`}
                    className="flex items-center gap-1 py-2 px-3 border border-gray-200 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors" title="View Enrollments">
                    <ClipboardList className="w-3.5 h-3.5" />
                  </Link>
                )}
                <button onClick={() => handleDelete(scheme.id)}
                  className="flex items-center gap-1 py-2 px-3 border border-red-100 text-red-500 rounded-lg text-xs font-medium hover:bg-red-50 transition-colors" title="Delete Scheme">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}

        {schemes.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3 py-16 text-center bg-white rounded-xl border border-gray-200">
            <Tag className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-400">No schemes match your filters</p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pagination && pagination.pages > 1 && (
        <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-gray-500">
          <span>Page <strong className="text-gray-700">{pagination.page}</strong> of <strong className="text-gray-700">{pagination.pages}</strong> · <strong className="text-gray-700">{pagination.total}</strong> total</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pagination.page <= 1}
              className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Previous</button>
            <button onClick={() => setPage((p) => p + 1)} disabled={pagination.page >= pagination.pages}
              className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
