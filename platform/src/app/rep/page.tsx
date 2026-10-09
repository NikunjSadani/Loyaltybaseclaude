'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Gift, Wallet, Package, ArrowRight, ChevronRight, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { formatPoints } from '@/lib/utils';
import { authHeader } from '@/lib/api-client';
import {
  mapCatalogItem,
  pickFeatured,
  affordability,
  type ApiEmployeeWallet,
  type EmployeeCatalogResponse,
  type CatalogItem,
} from './_lib/employee';

/* ─── REP Home ────────────────────────────────────────────────────────────────
   Points summary (redeemable / earned from the wallet endpoint) + a DERIVED
   featured strip (the backend carries no featured/dream flag — see pickFeatured)
   + quick links. Mirrors the partner dashboard's hero + quick-actions idiom. ─── */

export default function RepHome() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [redeemable, setRedeemable] = useState<number | null>(null);
  const [earned, setEarned] = useState<number | null>(null);
  const [featured, setFeatured] = useState<CatalogItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    const walletP = fetch('/api/rewards/employee/wallet', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: ApiEmployeeWallet }) => {
        if (cancelled || !json.success || !json.data) return;
        setRedeemable(json.data.redeemablePoints);
        setEarned(json.data.lifetimeEarned);
      })
      .catch(() => {});

    const catalogP = fetch('/api/rewards/employee/catalog?limit=50', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: EmployeeCatalogResponse }) => {
        if (cancelled || !json.success || !json.data) return;
        setFeatured(pickFeatured((json.data.items ?? []).map(mapCatalogItem)));
      })
      .catch(() => {});

    Promise.allSettled([walletP, catalogP]).then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const quickLinks = [
    { href: '/rep/rewards', label: 'Redeem', icon: Gift, color: 'var(--brand-primary)' },
    { href: '/rep/wallet', label: 'Wallet', icon: Wallet, color: '#1d4ed8' },
    { href: '/rep/orders', label: 'Orders', icon: Package, color: '#7c3aed' },
  ];

  return (
    <div className="space-y-4 fade-in">
      {/* ── Points hero ── */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 50%, var(--brand-primary-dark) 100%)',
        }}
      >
        <div className="px-4 pt-4 pb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-white/70">Redeemable Points</p>
            <Link
              href="/rep/wallet"
              className="flex items-center gap-1 text-[10px] font-semibold text-white/50"
            >
              Wallet <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          <p className="text-4xl font-extrabold text-white leading-none">
            {redeemable === null ? '—' : formatPoints(redeemable)}
            <span className="text-lg font-bold text-white/70 ml-1">pts</span>
          </p>
          <p className="text-[11px] text-white/50 mt-1.5">
            Lifetime earned: {earned === null ? '—' : `${formatPoints(earned)} pts`}
          </p>
        </div>
        <div className="border-t border-white/10 bg-black/25 px-4 py-3 flex items-center justify-between">
          <p className="text-[11px] text-white/60 font-medium">Turn your points into rewards</p>
          <Link
            href="/rep/rewards"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white rounded-lg text-xs font-bold text-[var(--brand-primary)] hover:bg-white/90 active:scale-95 transition-all"
          >
            Redeem <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      {/* ── Featured / within-reach strip ── */}
      {featured.length > 0 && (
        <Card>
          <CardContent className="px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-[var(--brand-primary)]" />
                <p className="text-sm font-bold text-gray-900">Rewards for you</p>
              </div>
              <Link
                href="/rep/rewards"
                className="text-[11px] font-semibold text-[var(--brand-primary)]"
              >
                See all
              </Link>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
              {featured.map((item) => {
                const { affordable } = affordability(redeemable ?? 0, item.pointsCost);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => router.push(`/rep/rewards/${item.id}`)}
                    className="shrink-0 w-32 text-left rounded-xl border border-gray-200 bg-white overflow-hidden hover:shadow-md transition-all active:scale-[0.98]"
                  >
                    <div className="h-24 flex items-center justify-center bg-gray-50">
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.imageUrl} alt="" className="max-h-full max-w-full object-contain p-2" />
                      ) : (
                        <Gift className="h-8 w-8 text-gray-300" />
                      )}
                    </div>
                    <div className="p-2.5">
                      <p className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2">
                        {item.name}
                      </p>
                      <p
                        className={`mt-1 text-sm font-bold ${
                          affordable ? 'text-[var(--brand-primary)]' : 'text-gray-400'
                        }`}
                      >
                        {formatPoints(item.pointsCost)} pts
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Quick links ── */}
      <div className="grid grid-cols-3 gap-2">
        {quickLinks.map((a) => (
          <Link
            key={a.label}
            href={a.href}
            className="flex flex-col items-center gap-1.5 p-3 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-sm active:scale-95 transition-all text-center"
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ backgroundColor: `${a.color}15` }}
            >
              <a.icon className="h-4 w-4" style={{ color: a.color }} />
            </div>
            <span className="text-[11px] font-medium text-gray-700 leading-tight">{a.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
