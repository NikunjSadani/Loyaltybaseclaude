'use client';

/* ─── Group Overview (Wave 3, READ-ONLY) ──────────────────────────────────────
   A partner whose login is the group PARENT sees a consolidated, read-only wallet
   roll-up across the group's child outlets, with per-outlet drill-down. No spend
   or redeem controls are ever rendered here — redemption happens per outlet.

   Data: GET /api/partner/group/wallet returns either { available: false } (this
   login has no group overview → friendly empty state) OR the full roll-up
   { available: true, parent, totals, conversionRate, outlets[] }. All point fields
   are integer POINTS (never paise); conversionRate converts points → ₹ the same way
   the rewards flow does (₹ = points ÷ conversionRate).
─────────────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Layers, Lock, ArrowLeft } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { formatPoints } from '@/lib/utils';
import { api } from '@/lib/api-client';

/* ─── API contract ────────────────────────────────────────────────────────────── */

interface GroupOutlet {
  outletCode:       string;
  businessName:     string;
  ownerName:        string;
  isActive:         boolean;
  redeemablePoints: number;
  earnedPoints:     number;
  redeemedPoints:   number;
  expiredPoints:    number;
  lockedPoints:     number;
}

interface GroupTotals {
  redeemablePoints: number;
  earnedPoints:     number;
  redeemedPoints:   number;
  expiredPoints:    number;
  lockedPoints:     number;
  lifetimeEarned:   number;
  lifetimeRedeemed: number;
}

type GroupWallet =
  | { available: false }
  | {
      available: true;
      parent:         { businessName: string; ownerName: string };
      totals:         GroupTotals;
      conversionRate: number;
      outlets:        GroupOutlet[];
    };

/* ─── ₹ helpers ───────────────────────────────────────────────────────────────── */

/** ₹ equivalent of a points figure, mirroring the rewards flow: ₹ = points ÷ rate.
    Guards a zero/invalid rate so we never divide by zero (returns null → shown as —). */
function inrEquivalent(points: number, conversionRate: number): number | null {
  const hasRate = Number.isFinite(conversionRate) && conversionRate > 0;
  return hasRate ? points / conversionRate : null;
}

function fmtInr(n: number | null): string {
  if (n == null) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/* ─── Consolidated totals card ────────────────────────────────────────────────────
   Reuses the wallet balance-card visual language (dark gradient, rounded-2xl,
   white text, shadow) but rolls the whole group together and adds the ₹ equivalent
   of the redeemable balance via conversionRate. */

function GroupTotalsCard({ totals, conversionRate }: { totals: GroupTotals; conversionRate: number }) {
  const redeemableInr = inrEquivalent(totals.redeemablePoints, conversionRate);
  return (
    <div
      data-testid="group-totals-card"
      className="bg-gradient-to-br from-[#1A1A2E] to-[#16213E] rounded-2xl px-5 py-4 text-white shadow-xl"
    >
      {/* Redeemable — primary, with ₹ equivalent */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-white/50 text-[11px] font-medium uppercase tracking-widest shrink-0">
          Group Redeemable
        </p>
        <div className="text-right">
          <p className="text-3xl font-extrabold tracking-tight leading-none">
            {formatPoints(totals.redeemablePoints)}
            <span className="text-base font-normal text-white/40 ml-1.5">pts</span>
          </p>
          <p data-testid="group-redeemable-inr" className="text-white/50 text-xs mt-1">
            ≈ {fmtInr(redeemableInr)}
          </p>
        </div>
      </div>

      {/* Secondary roll-ups */}
      <div className="grid grid-cols-2 gap-2.5 mt-4">
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">Lifetime Earned</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.lifetimeEarned)} pts</p>
        </div>
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">Lifetime Redeemed</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.lifetimeRedeemed)} pts</p>
        </div>
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">Earned</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.earnedPoints)} pts</p>
        </div>
        <div>
          <p className="text-white/40 text-[10px] uppercase tracking-wide">On Hold</p>
          <p className="text-white/80 font-semibold text-sm">{formatPoints(totals.lockedPoints)} pts</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Per-outlet roll-up ──────────────────────────────────────────────────────── */

function OutletRow({ outlet, conversionRate }: { outlet: GroupOutlet; conversionRate: number }) {
  const redeemableInr = inrEquivalent(outlet.redeemablePoints, conversionRate);
  return (
    <div data-testid="group-outlet-row" className="px-4 py-3">
      {/* Header row: name + code + active badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{outlet.businessName}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {outlet.outletCode}
            {outlet.ownerName ? ` · ${outlet.ownerName}` : ''}
          </p>
        </div>
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            outlet.isActive
              ? 'bg-emerald-50 text-emerald-600'
              : 'bg-gray-100 text-gray-400'
          }`}
        >
          {outlet.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>

      {/* Points figures */}
      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Redeemable</p>
          <p className="text-sm font-bold text-gray-900">{formatPoints(outlet.redeemablePoints)}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">≈ {fmtInr(redeemableInr)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Earned</p>
          <p className="text-sm font-semibold text-gray-700">{formatPoints(outlet.earnedPoints)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">Redeemed</p>
          <p className="text-sm font-semibold text-gray-700">{formatPoints(outlet.redeemedPoints)}</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Empty / no-group state ──────────────────────────────────────────────────── */

function NoGroupState() {
  return (
    <div
      data-testid="group-empty-state"
      className="bg-white rounded-2xl border border-gray-100 flex flex-col items-center gap-3 py-14 px-6 text-center"
    >
      <Layers className="h-9 w-9 text-gray-200" />
      <p className="text-sm font-semibold text-gray-700">No group overview available</p>
      <p className="text-xs text-gray-400 max-w-xs">
        This login isn&apos;t the parent of an outlet group, so there&apos;s no consolidated view to show.
      </p>
      <Link
        href="/partner/dashboard"
        className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--brand-primary)] hover:underline"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to dashboard
      </Link>
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────────── */

export default function GroupOverviewPage() {
  const [data,    setData]    = useState<GroupWallet | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.get<GroupWallet>('/api/partner/group/wallet')
      .then((res) => {
        if (cancelled) return;
        // Only a successful envelope carrying a usable shape becomes state; anything
        // else (network error, non-envelope) falls through to the no-group empty state.
        setData(res.success ? res.data : { available: false });
      })
      .catch(() => {
        if (!cancelled) setData({ available: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-48">
        <Spinner size="lg" />
      </div>
    );
  }

  // No group → friendly empty state (never a crash, never redeem controls).
  if (!data || data.available === false) {
    return (
      <div className="space-y-5 fade-in">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Group Overview</h1>
        </div>
        <NoGroupState />
      </div>
    );
  }

  const { parent, totals, conversionRate, outlets } = data;

  return (
    <div className="space-y-5 fade-in">
      {/* Header + read-only badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-gray-900 truncate">
            Group Overview — {parent.businessName}
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">{parent.ownerName}</p>
        </div>
        <span
          data-testid="read-only-badge"
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500"
        >
          <Lock className="h-3 w-3" />
          Read-only
        </span>
      </div>

      {/* Consolidated totals */}
      <GroupTotalsCard totals={totals} conversionRate={conversionRate} />

      {/* Per-outlet roll-up */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 pt-3 pb-2 border-b border-gray-50 flex items-center justify-between">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
            Outlets in group
          </p>
          <span className="text-[10px] text-gray-400">{outlets.length} outlets</span>
        </div>

        {outlets.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12">
            <Layers className="h-8 w-8 text-gray-200" />
            <p className="text-sm text-gray-400">No outlets in this group yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {outlets.map((o) => (
              <OutletRow key={o.outletCode} outlet={o} conversionRate={conversionRate} />
            ))}
          </div>
        )}
      </div>

      {/* Read-only helper note */}
      <p className="text-[11px] text-gray-400 text-center px-6">
        Read-only consolidated view — redemption happens per outlet.
      </p>
    </div>
  );
}
