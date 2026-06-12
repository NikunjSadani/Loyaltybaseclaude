/* ─── Partner Session ────────────────────────────────────────────────────────
   Source of truth for which outlet type is currently logged in.
   In production this comes from the auth token / API.
   For the demo, a localStorage key lets you switch outlet types.
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import { useState, useEffect } from 'react';
import { loadRedemptions } from '@/lib/redemption-store';

export type OutletType  = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT';
export type RewardTrack = 'POINTS' | 'INR';

export interface PartnerSession {
  outletId:           string;
  outletType:         OutletType;
  firmName:           string;
  partnerName:        string;
  tier:               string;
  mobile:             string;
  track:              RewardTrack;
  // ── Wholesaler (POINTS track) ──
  pointsBalance:      number;
  pointsLifetime:     number;
  leaderboardRank:    number;
  leaderboardTotal:   number;
  // ── INR track (SSS / Sub-Stockist / SSS TOT) ──
  inrEarnedThisCycle: number;
  pendingPayoutInr:   number;
}

export const REWARD_TRACK: Record<OutletType, RewardTrack> = {
  SSS:          'INR',
  WHOLESALER:   'POINTS',
  SUB_STOCKIST: 'INR',
  SSS_TOT:      'INR',
};

export const OUTLET_TYPE_LABELS: Record<OutletType, string> = {
  SSS:          'SSS',
  WHOLESALER:   'Wholesaler',
  SUB_STOCKIST: 'Sub-Stockist',
  SSS_TOT:      'SSS TOT',
};

export const OUTLET_TYPE_COLORS: Record<OutletType, { bg: string; text: string }> = {
  WHOLESALER:   { bg: 'bg-amber-100',   text: 'text-amber-700'  },
  SSS:          { bg: 'bg-blue-100',    text: 'text-blue-700'   },
  SUB_STOCKIST: { bg: 'bg-purple-100',  text: 'text-purple-700' },
  SSS_TOT:      { bg: 'bg-emerald-100', text: 'text-emerald-700'},
};

/* ── Demo sessions (one per type) — covers all TDD scenarios ─────────────────
   WHOLESALER : points balance above threshold  → all redemptions enabled
   SSS        : paid + pending payout           → shows UTR + pending status
   SUB_STOCKIST: only pending, no UTR yet       → shows processing state
   SSS_TOT    : high-value, partially paid      → shows partial paid state
─────────────────────────────────────────────────────────────────────────────── */
export const DEMO_SESSIONS: Record<OutletType, PartnerSession> = {
  WHOLESALER: {
    outletId: 'o1', outletType: 'WHOLESALER', firmName: 'Kumar General Store',
    partnerName: 'Rajesh Kumar', tier: 'Gold', mobile: '9876543210',
    track: 'POINTS',
    pointsBalance: 4_250, pointsLifetime: 8_550,
    leaderboardRank: 12, leaderboardTotal: 248,
    inrEarnedThisCycle: 0, pendingPayoutInr: 0,
  },
  SSS: {
    outletId: 'o2', outletType: 'SSS', firmName: 'Sharma Kirana',
    partnerName: 'Amit Sharma', tier: 'Silver', mobile: '9765432109',
    track: 'INR',
    pointsBalance: 0, pointsLifetime: 0,
    leaderboardRank: 0, leaderboardTotal: 0,
    inrEarnedThisCycle: 12_500, pendingPayoutInr: 4_500,
  },
  SUB_STOCKIST: {
    outletId: 'o3', outletType: 'SUB_STOCKIST', firmName: 'Patel Distributors',
    partnerName: 'Suresh Patel', tier: 'Bronze', mobile: '9654321098',
    track: 'INR',
    pointsBalance: 0, pointsLifetime: 0,
    leaderboardRank: 0, leaderboardTotal: 0,
    inrEarnedThisCycle: 7_200, pendingPayoutInr: 7_200,
  },
  SSS_TOT: {
    outletId: 'o4', outletType: 'SSS_TOT', firmName: 'BigMart Superstore',
    partnerName: 'Priya Singh', tier: 'Platinum', mobile: '9543210987',
    track: 'INR',
    pointsBalance: 0, pointsLifetime: 0,
    leaderboardRank: 0, leaderboardTotal: 0,
    inrEarnedThisCycle: 45_000, pendingPayoutInr: 20_000,
  },
};

const SESSION_KEY = 'partner_outlet_type_demo';

export function getPartnerSession(): PartnerSession {
  if (typeof window === 'undefined') return DEMO_SESSIONS['WHOLESALER'];
  const stored = localStorage.getItem(SESSION_KEY) as OutletType | null;
  const type: OutletType = (stored && stored in DEMO_SESSIONS) ? stored : 'WHOLESALER';
  const base = DEMO_SESSIONS[type];
  if (base.track !== 'POINTS') return base;
  // Deduct any redemptions made during the session so all pages show the same balance
  const redeemed = loadRedemptions().reduce((sum, r) => sum + r.points, 0);
  return { ...base, pointsBalance: Math.max(0, base.pointsBalance - redeemed) };
}

export function setDemoOutletType(type: OutletType): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(SESSION_KEY, type);
    window.dispatchEvent(new Event('partner-session-change'));
  }
}

export function usePartnerSession(): PartnerSession {
  const [session, setSession] = useState<PartnerSession>(DEMO_SESSIONS['WHOLESALER']);
  useEffect(() => {
    setSession(getPartnerSession());
    const handler = () => setSession(getPartnerSession());
    window.addEventListener('partner-session-change', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('partner-session-change', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);
  return session;
}
