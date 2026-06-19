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
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/partner/me', { headers: { ...authHeader() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        const d = res?.data;
        if (cancelled || !d) return;
        const name = getStoredUser()?.name ?? '';
        setIdentity({
          businessName: d.businessName || name,
          ownerName: d.ownerName || name,
          partnerCode: d.partnerCode ?? null,
        });
      })
      .catch(() => {/* keep the JWT-name fallback */});
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}
