'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Gift,
  Wallet,
  Package,
  ArrowRight,
  ChevronRight,
  Sparkles,
  Target,
  Trophy,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { formatPoints } from '@/lib/utils';
import { authHeader } from '@/lib/api-client';
import {
  mapCatalogItem,
  pickFeatured,
  affordability,
  mapDream,
  pct,
  formatMonthYear,
  mapContest,
  formatContestDateRange,
  type ApiEmployeeWallet,
  type EmployeeCatalogResponse,
  type CatalogItem,
  type ApiEmployeeDream,
  type Dream,
  type ApiEmployeeContest,
  type Contest,
} from './_lib/employee';

/* ── Compact progress ring for the Dream hero (inline SVG) ── */
function MiniRing({ percent, size = 56, stroke = 6 }: { percent: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, percent)) / 100) * circ;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#ffffff"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-extrabold text-white">{percent}%</span>
      </div>
    </div>
  );
}

/* ─── REP Home ────────────────────────────────────────────────────────────────
   Points summary (redeemable / earned from the wallet endpoint) + a DERIVED
   featured strip (the backend carries no featured/dream flag — see pickFeatured)
   + quick links. Mirrors the partner dashboard's hero + quick-actions idiom. ─── */

export default function RepHome() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [redeemable, setRedeemable] = useState<number | null>(null);
  const [earned, setEarned] = useState<number | null>(null);
  const [targetPoints, setTargetPoints] = useState<number | null>(null);
  const [featured, setFeatured] = useState<CatalogItem[]>([]);
  const [dream, setDream] = useState<Dream | null>(null);
  const [contests, setContests] = useState<Contest[]>([]);

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

    // Current-period target (default period on the server). Display-only; null/0 → no target element.
    const targetP = fetch('/api/rewards/employee/target', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { period: string; targetPoints: number | null } }) => {
        if (cancelled || !json.success || !json.data) return;
        setTargetPoints(json.data.targetPoints);
      })
      .catch(() => {});

    const catalogP = fetch('/api/rewards/employee/catalog?limit=50', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: EmployeeCatalogResponse }) => {
        if (cancelled || !json.success || !json.data) return;
        setFeatured(pickFeatured((json.data.items ?? []).map(mapCatalogItem)));
      })
      .catch(() => {});

    // Dream Reward (null reward = none chosen yet → the hero shows a "choose" CTA). A
    // failed fetch leaves `dream` null → the whole hero is omitted (honest empty state).
    const dreamP = fetch('/api/rewards/employee/dream', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: ApiEmployeeDream }) => {
        if (cancelled || !json.success || !json.data) return;
        setDream(mapDream(json.data));
      })
      .catch(() => {});

    // Live contests (backend already scopes to this employee's role/region).
    const contestsP = fetch('/api/rewards/employee/contests', { headers: { ...authHeader() } })
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { contests: ApiEmployeeContest[] } }) => {
        if (cancelled || !json.success || !json.data) return;
        setContests((json.data.contests ?? []).map(mapContest));
      })
      .catch(() => {});

    Promise.allSettled([walletP, targetP, catalogP, dreamP, contestsP]).then(() => {
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

      {/* ── Dream Reward hero ── (tap → /rep/dream; a "choose" CTA when none is set OR
            when the dream fetch failed — so the feature stays discoverable, never a fake state) */}
      {
        dream?.reward ? (
          <button
            type="button"
            onClick={() => router.push('/rep/dream')}
            className="w-full text-left rounded-2xl overflow-hidden active:scale-[0.99] transition-transform"
            style={{
              background:
                'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%)',
            }}
          >
            <div className="px-4 py-4 flex items-center gap-3.5">
              <div className="w-14 h-14 rounded-xl bg-white/95 flex items-center justify-center overflow-hidden shrink-0">
                {dream.reward.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={dream.reward.imageUrl} alt="" className="max-h-full max-w-full object-contain p-1.5" />
                ) : (
                  <Gift className="h-7 w-7 text-gray-300" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3 text-white/70" />
                  <p className="text-[10px] font-bold tracking-wider text-white/70">DREAM REWARD</p>
                </div>
                <p className="text-sm font-bold text-white leading-snug truncate mt-0.5">
                  {dream.reward.name}
                </p>
                {dream.reached ? (
                  <p className="text-[11px] font-semibold text-white/90 mt-0.5">Reached 🎉 — redeem it now</p>
                ) : (
                  <>
                    <p className="text-[11px] text-white/70 mt-0.5">
                      {formatPoints(dream.pointsRemaining)} pts to be earned
                    </p>
                    {dream.forecastDate && (
                      <p className="text-[11px] font-semibold text-white/90 mt-0.5">
                        Est. · {formatMonthYear(dream.forecastDate)}
                      </p>
                    )}
                  </>
                )}
              </div>
              <MiniRing percent={pct(dream.redeemablePoints, dream.pointsRequired)} />
            </div>
          </button>
        ) : (
          <Link
            href="/rep/rewards"
            className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-gray-300 px-4 py-4 hover:border-[var(--brand-primary)]/50 hover:bg-gray-50 transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
              <Sparkles className="h-5 w-5 text-[var(--brand-primary)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-gray-900">Choose your Dream Reward</p>
              <p className="text-xs text-gray-500 mt-0.5">Pick a big goal and track your progress</p>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
          </Link>
        )
      }

      {/* ── Target / achievement ── (display-only; shown only when a positive target exists) */}
      {typeof targetPoints === 'number' && targetPoints > 0 && (() => {
        const earnedBasis = earned ?? 0; // lifetime-earned is the earned basis
        const pct = Math.max(0, Math.min(100, Math.round((earnedBasis / targetPoints) * 100)));
        return (
          <Card>
            <CardContent className="px-4 py-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Target className="h-4 w-4 text-[var(--brand-primary)]" />
                  <p className="text-sm font-bold text-gray-900">Your target</p>
                </div>
                <p className="text-sm font-extrabold text-[var(--brand-primary)]">{pct}%</p>
              </div>
              <p className="text-xs text-gray-600">
                Earned <span className="font-semibold text-gray-900">{formatPoints(earnedBasis)}</span> of{' '}
                <span className="font-semibold text-gray-900">{formatPoints(targetPoints)}</span> target
              </p>
              <div className="mt-2 h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--brand-primary)] transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </CardContent>
          </Card>
        );
      })()}

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

      {/* ── Live contests carousel ── (hidden when there are none) */}
      {contests.length > 0 && (
        <Card>
          <CardContent className="px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5">
                <Trophy className="h-4 w-4 text-[var(--brand-primary)]" />
                <p className="text-sm font-bold text-gray-900">Live contests</p>
              </div>
              <Link href="/rep/contests" className="text-[11px] font-semibold text-[var(--brand-primary)]">
                See all
              </Link>
            </div>
            <div
              className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1 snap-x snap-mandatory"
              style={{ scrollbarWidth: 'none' }}
            >
              {contests.map((contest) => {
                const dateRange = formatContestDateRange(contest.startDate, contest.endDate);
                return (
                  <button
                    key={contest.id}
                    type="button"
                    onClick={() => router.push('/rep/contests')}
                    className="snap-start shrink-0 w-56 text-left rounded-xl border border-gray-200 bg-white overflow-hidden hover:shadow-md transition-all active:scale-[0.98]"
                  >
                    <div className="relative h-24 flex items-center justify-center">
                      {contest.bannerUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={contest.bannerUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div
                          className="h-full w-full flex items-center justify-center"
                          style={{
                            background:
                              'linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-primary-dark) 100%)',
                          }}
                        >
                          <Trophy className="h-8 w-8 text-white/80" />
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <p className="text-xs font-bold text-gray-900 leading-snug line-clamp-1">
                        {contest.name}
                      </p>
                      {dateRange && <p className="text-[10px] text-gray-500 mt-0.5">{dateRange}</p>}
                      {contest.bonusPoints > 0 && (
                        <span className="inline-flex items-center gap-1 mt-2 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                          <Sparkles className="h-3 w-3 text-[var(--brand-primary)]" />
                          <span className="text-[10px] font-bold text-[var(--brand-primary)]">
                            Win {formatPoints(contest.bonusPoints)} pts
                          </span>
                        </span>
                      )}
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
