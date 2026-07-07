/* ─── Partner identity (REAL) ─────────────────────────────────────────────────
   Sources the logged-in partner's real identity from GET /api/partner/me (the
   channel-partner record), replacing the demo persona in lib/partner-session
   (DEMO_SESSIONS — "Rajesh Kumar / Kumar General Store / Gold") for shell/header
   display. Falls back to the JWT user name while loading or if the caller has no
   channel-partner row — NEVER the demo persona, so no flash-of-demo. Client-only.
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import { useState, useEffect } from 'react';
import { authHeader } from '@/lib/api-client';
import { getStoredUser } from '@/lib/auth-client';

export interface PartnerIdentity {
  /** firm/business name for the shell header (channelPartner.businessName). */
  businessName: string;
  /** owner/person name for the shell sub-line (channelPartner.ownerName). */
  ownerName: string;
  partnerCode: string | null;
  /** The partner's PRIMARY outlet's OutletType.code (e.g. 'WHOLESALER'); null while loading / no outlet. */
  outletType: string | null;
  /**
   * REAL presence signals that drive the points-vs-payout experience (replaces the demo
   * REWARD_TRACK). Both default false while loading — a section is only shown once its
   * signal is confirmed true, so a payout-only partner never flashes a points UI.
   */
  hasPointsActivity: boolean;
  hasPayoutActivity: boolean;
  /**
   * True until GET /partner/me settles (resolve OR error). Consumers that GATE on the
   * presence signals (e.g. the rewards page) must wait for this to be false before
   * deciding "no points" — otherwise the false-while-loading defaults would flash the
   * gate/empty state to a partner who actually has points.
   */
  loading: boolean;
}

/**
 * Returns the real partner identity. Resolves synchronously to the JWT user name
 * (real) and upgrades to the channel-partner record once /partner/me responds.
 */
export function usePartnerIdentity(): PartnerIdentity {
  const fallbackName = getStoredUser()?.name ?? '';
  const [identity, setIdentity] = useState<PartnerIdentity>({
    businessName: fallbackName,
    ownerName: fallbackName,
    partnerCode: null,
    outletType: null,
    hasPointsActivity: false,
    hasPayoutActivity: false,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/partner/me', { headers: { ...authHeader() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (cancelled) return;
        const d = res?.data;
        const name = getStoredUser()?.name ?? '';
        // Settle loading regardless — a caller with no channel-partner row (d null) is a
        // resolved "no activity" state, not an eternal load.
        setIdentity((prev) => ({
          businessName: d?.businessName || name || prev.businessName,
          ownerName: d?.ownerName || name || prev.ownerName,
          partnerCode: d?.partnerCode ?? null,
          outletType: d?.outletType ?? null,
          hasPointsActivity: d?.hasPointsActivity === true,
          hasPayoutActivity: d?.hasPayoutActivity === true,
          loading: false,
        }));
      })
      .catch(() => {
        // Keep the JWT-name fallback, but settle loading so gates can resolve.
        if (!cancelled) setIdentity((prev) => ({ ...prev, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}
