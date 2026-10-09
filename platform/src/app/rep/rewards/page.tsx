'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Gift, Search, CheckCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, formatPoints } from '@/lib/utils';
import { authHeader } from '@/lib/api-client';
import {
  mapCatalogItem,
  affordability,
  type EmployeeCatalogResponse,
  type CatalogItem,
} from '../_lib/employee';

/* ─── REP Rewards catalogue ───────────────────────────────────────────────────
   Grid of the employee's affordability-aware, role/region-visibility-filtered
   catalogue (the backend applies both). Tapping an item → the detail/redeem page.
   Employees have no cash rail (the backend rejects UPI/BANK_TRANSFER), so this is
   a single grid with a search + category filter — no Bank Transfer tab. ──────── */

export default function RepRewardsPage() {
  const router = useRouter();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/rewards/employee/catalog?limit=100', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: EmployeeCatalogResponse }) => {
        if (cancelled || !json.success || !json.data) return;
        setItems((json.data.items ?? []).map(mapCatalogItem));
        setBalance(json.data.userBalance ?? 0);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(() => {
    const cats = Array.from(new Set(items.map((i) => i.category))).sort();
    return ['All', ...cats];
  }, [items]);

  const filtered = useMemo(() => {
    let list = items.filter((i) => i.inStock);
    if (category !== 'All') list = list.filter((i) => i.category === category);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
    }
    return list;
  }, [items, category, search]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Rewards</h1>
          <p className="text-xs text-gray-500 mt-0.5">Tap an item to see details before redeeming</p>
        </div>
        <button
          onClick={() => router.push('/rep/orders')}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors shrink-0"
        >
          <CheckCircle className="h-3.5 w-3.5" /> Orders
        </button>
      </div>

      {/* Balance pill */}
      <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5 w-fit">
        <span className="text-sm font-bold text-[var(--brand-primary)]">{formatPoints(balance)} pts</span>
        <span className="text-[10px] text-emerald-600 font-medium">available to redeem</span>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search rewards…"
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]"
        />
      </div>

      {/* Category pills */}
      {categories.length > 2 && (
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                category === cat
                  ? 'bg-[var(--brand-primary)] text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Grid */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Gift className="h-8 w-8" />}
          title="No items found"
          description="Try a different search or category"
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {filtered.map((item) => {
            const { affordable, shortfall } = affordability(balance, item.pointsCost);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => router.push(`/rep/rewards/${item.id}`)}
                className={cn(
                  'bg-white rounded-xl border overflow-hidden shadow-sm text-left',
                  'flex flex-col transition-all active:scale-[0.98]',
                  affordable
                    ? 'border-gray-200 hover:shadow-md hover:border-gray-300'
                    : 'border-gray-100 opacity-70 hover:opacity-90',
                )}
              >
                <div className="relative h-36 flex items-center justify-center bg-gray-50">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" className="max-h-full max-w-full object-contain p-3" />
                  ) : (
                    <Gift className="h-10 w-10 text-gray-300" />
                  )}
                  {!affordable && (
                    <div className="absolute inset-0 flex items-end justify-center pb-2">
                      <span className="text-[9px] font-bold bg-gray-800/70 text-white px-2 py-0.5 rounded-full">
                        Need {formatPoints(shortfall)} more pts
                      </span>
                    </div>
                  )}
                </div>
                <div className="p-3 flex-1 flex flex-col">
                  <p className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2 flex-1">
                    {item.name}
                  </p>
                  <div className="mt-2 pt-2 border-t border-gray-50 flex items-center justify-between">
                    <span
                      className={`text-sm font-bold ${
                        affordable ? 'text-[var(--brand-primary)]' : 'text-gray-400'
                      }`}
                    >
                      {formatPoints(item.pointsCost)} pts
                    </span>
                    <span className="text-[10px] text-gray-400 underline">Details</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
