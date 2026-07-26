'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, Tag, Calendar, ChevronRight, BarChart3 } from 'lucide-react';
import { api } from '@/lib/api-client';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant read-only Scheme Reports (D2/D26) — CLIENT_ADMIN cannot create/manage
// schemes, but can view aggregate coverage reports. This is the scheme picker;
// the per-scheme report lives at /admin/scheme-reports/:id (read-only, no media).
// ─────────────────────────────────────────────────────────────────────────────

interface SchemeRow {
  id: string;
  code: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
}
interface Pagination { page: number; limit: number; total: number; pages: number }
interface ListResponse { schemes: SchemeRow[]; pagination: Pagination }

const STATUS_STYLES: Record<string, string> = {
  ACTIVE:    'bg-green-100 text-green-700',
  DRAFT:     'bg-gray-100 text-gray-600',
  PAUSED:    'bg-blue-100 text-blue-700',
  EXPIRED:   'bg-red-50 text-red-500',
  CANCELLED: 'bg-red-100 text-red-600',
};

export default function SchemeReportsListPage() {
  const [schemes, setSchemes] = useState<SchemeRow[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search.trim()) params.set('search', search.trim());
    const res = await api.get<ListResponse>(`/api/schemes?${params.toString()}`);
    if (res.success) { setSchemes(res.data.schemes); setPagination(res.data.pagination ?? null); }
    else setError(res.error);
    setLoading(false);
  }, [page, search]);

  useEffect(() => { const t = setTimeout(() => { void load(); }, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { setPage(1); }, [search]);

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-[var(--brand-primary)]" /> Scheme Reports</h2>
        <p className="text-xs text-gray-500">Read-only coverage reports for your tenant&apos;s schemes.</p>
      </div>

      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search schemes..."
          className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]" />
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">Loading schemes…</div>
      ) : error ? (
        <div className="py-20 text-center"><p className="text-sm text-red-500">{error}</p><button onClick={load} className="mt-3 text-xs text-[var(--brand-primary)] hover:underline">Retry</button></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {schemes.map((s) => (
            <Link key={s.id} href={`/admin/scheme-reports/${s.id}`}
              className="bg-white rounded-xl border border-gray-200 hover:shadow-md transition-all p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[s.status] ?? 'bg-gray-100 text-gray-600'}`}>{s.status}</span>
                <span className="text-xs text-gray-400 font-mono">{s.code}</span>
              </div>
              <div className="flex items-start gap-2">
                <div className="p-2 rounded-lg bg-red-50 flex-shrink-0"><Tag className="w-4 h-4 text-[var(--brand-primary)]" /></div>
                <h3 className="text-sm font-semibold text-gray-900 leading-tight">{s.name}</h3>
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-500"><Calendar className="w-3.5 h-3.5" />{s.startDate.slice(0, 10)} → {s.endDate.slice(0, 10)}</div>
              <span className="mt-1 text-xs text-[var(--brand-primary)] font-medium flex items-center gap-1">View report <ChevronRight className="w-3.5 h-3.5" /></span>
            </Link>
          ))}
          {schemes.length === 0 && (
            <div className="md:col-span-2 xl:col-span-3 py-16 text-center bg-white rounded-xl border border-gray-200">
              <Tag className="w-8 h-8 text-gray-300 mx-auto mb-3" /><p className="text-sm text-gray-400">No schemes found</p>
            </div>
          )}
        </div>
      )}

      {pagination && pagination.pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pagination.page <= 1} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">Previous</button>
          <span>Page {pagination.page} / {pagination.pages}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={pagination.page >= pagination.pages} className="px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  );
}
