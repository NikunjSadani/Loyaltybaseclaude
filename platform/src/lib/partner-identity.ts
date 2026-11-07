/* ─── Partner identity (REAL) ─────────────────────────────────────────────────
   Sources the logged-in partner's real identity from GET /api/partner/me (the
   channel-partner record), replacing the demo persona in lib/partner-session
   (DEMO_SESSIONS — "Rajesh Kumar / Kumar General Store / Gold") for shell/header
   display. Falls back to the JWT user name while loading or if the caller has no
   channel-partner row — NEVER the demo persona, so no flash-of-demo. Client-only.
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import { useState, useEffect, useRef } from 'react';
import { authHeader } from '@/lib/api-client';
import { getStoredUser } from '@/lib/auth-client';
import { setActivePartner } from '@/lib/active-partner-actions';
import type { FeatureFlags } from '@/lib/platform/client-config';
import { DEFAULT_FEATURES, normalizeFeatures } from '@/lib/tenant-features';

/**
 * Wave 3 — one login can operate multiple outlets (its own + login-less same-group
 * siblings that share its phone). Each entry is a distinct ChannelPartner the login
 * may act as; `partnerId` is what the picker/switcher writes to the `active_partner_id`
 * cookie (own-first ordering). `isOwnLogin` marks the login's own outlet.
 */
export interface OperableOutlet {
  partnerId: string;
  outletId: string;
  outletCode: string;
  /** The outlet's MASTER name (Outlet.name); the switcher prefers it over businessName. May be null. */
  outletName: string | null;
  businessName: string;
  ownerName: string;
  isOwnLogin: boolean;
}

/** Wave 3 — the owner-group parent, when the login belongs to a group (read-only overview). */
export interface GroupParent {
  parentId: string;
  businessName: string;
  ownerName: string;
}

/**
 * The ACTIVE outlet's address on file, used ONLY to pre-fill the physical-gift delivery form
 * (GET /partner/me `deliveryDefaults`; PLATFORM-WIDE, outlet address only). Any field may be
 * null when it isn't on file. Same shape as the backend helper (not imported from api/).
 */
export interface DeliveryDefaults {
  line1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
}

function isDeliveryDefaults(v: unknown): v is DeliveryDefaults {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (['line1', 'city', 'state', 'pincode'] as const).every(
    (k) => o[k] === null || typeof o[k] === 'string',
  );
}

export interface PartnerIdentity {
  /** firm/business name for the shell header (channelPartner.businessName). */
  businessName: string;
  /**
   * The ACTIVE outlet's MASTER name (Outlet.name, the admin-roster name). The shell header shows
   * this (falling back to businessName) so it matches the outlet master. Null while loading / when
   * the partner has no outlet.
   */
  outletName: string | null;
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
   * Driven by the per-outlet-type "Loyalty (Earn and redeem points)" flag, delivered on
   * the /partner/me response. Gates the partner Rewards catalogue/redeem. Default TRUE
   * unless the API explicitly says false (backward-compatible when the field is absent).
   */
  loyaltyEnabled: boolean;
  /**
   * The caller's tenant feature flags (DB-backed, from the same /partner/me response —
   * §A-DOMAIN "P5"). The partner shell reads its nav gating (walletModule /
   * partnerApp.showLeaderboard) from HERE, not the in-code CLIENT_REGISTRY. Fully
   * shaped (normalizeFeatures) so nested keys are always safe to read; DEFAULT_FEATURES
   * while loading / when the caller has no resolvable tenant features.
   */
  features: FeatureFlags;
  /**
   * Wave 3 — the outlet the login is currently ACTING AS (the `active_partner_id`
   * selection), or null when it operates its own outlet (the login default). The
   * switcher marks the matching `operableOutlets` entry as current.
   */
  activePartnerId: string | null;
  /**
   * Wave 3 — every outlet this login may operate (own + login-less same-group
   * siblings sharing its phone), own-first. Length <= 1 means today's single-outlet
   * behaviour — no picker, no switcher.
   */
  operableOutlets: OperableOutlet[];
  /** Wave 3 — true when this login belongs to an owner group and may view the read-only group overview. */
  groupOverviewAvailable: boolean;
  /** Wave 3 — the owner-group parent when in a group, else null. */
  groupParent: GroupParent | null;
  /**
   * Wave 3 — true when the backend degraded the active-outlet selection to the login's
   * OWN outlet because the `active_partner_id` cookie named a non-operable partner (stale
   * after re-grouping, or foreign). The hook SELF-HEALS by clearing the cookie once per
   * invalid response (see below), so downstream pages/requests stop carrying the bad id.
   */
  activeSelectorInvalid: boolean;
  /**
   * The ACTIVE outlet's delivery-address pre-fill for the gift redeem form. Null while loading,
   * when nothing is on file, or when the response lacks/malforms it (older backend).
   */
  deliveryDefaults: DeliveryDefaults | null;
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
  // The initial render must NOT read client-only storage (getStoredUser → localStorage):
  // during SSR it returns '' and on the client's first paint it returns the cached name,
  // so the shell header text differs server↔client → a hydration mismatch (React #418,
  // app-wide). Start empty so SSR and the first client paint agree, then seed the cached
  // name in the post-mount effect below — it fills on the first post-mount commit (a ≤1-frame
  // blank name is the accepted tradeoff for removing the app-wide hydration error).
  const [identity, setIdentity] = useState<PartnerIdentity>({
    businessName: '',
    outletName: null,
    ownerName: '',
    partnerCode: null,
    outletType: null,
    hasPointsActivity: false,
    hasPayoutActivity: false,
    // Default TRUE — the documented "on unless the API explicitly says false" contract.
    // Loyalty-ON is the common case, so this shows Rewards immediately (no nav flash-in)
    // and, critically, is what the .catch below preserves via ...prev: a TRANSIENT
    // /partner/me failure must not permanently hide Rewards (+ show the wrong "paid to
    // your bank" wall) for a normal points outlet. A loyalty-OFF outlet briefly shows the
    // nav then it hides once /me resolves to false; the rewards PAGE wall is guarded by
    // !identity.loading, so it never flashes.
    loyaltyEnabled: true,
    features: DEFAULT_FEATURES,
    activePartnerId: null,
    operableOutlets: [],
    groupOverviewAvailable: false,
    groupParent: null,
    activeSelectorInvalid: false,
    deliveryDefaults: null,
    loading: true,
  });

  // Guards the self-heal so the stale `active_partner_id` cookie is cleared AT MOST ONCE
  // per component mount — clearing it triggers no refetch here, but this makes the intent
  // (fire-once, no loop) explicit and robust against any future re-fetch.
  const healedRef = useRef(false);

  // Seed the cached display name AFTER mount — not during render (that localStorage read
  // during the initial render is what caused the React #418 hydration mismatch). Post-
  // hydration SSR and the first client paint agree (both empty), then this fills the name
  // on the first post-mount commit (≤1 frame later), well before /partner/me resolves. The
  // old code filled it during the first paint but at the cost of the app-wide hydration error.
  useEffect(() => {
    const stored = getStoredUser()?.name ?? '';
    if (!stored) return;
    setIdentity((prev) => ({
      ...prev,
      businessName: prev.businessName || stored,
      ownerName: prev.ownerName || stored,
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/partner/me', { headers: { ...authHeader() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (cancelled) return;
        const d = res?.data;
        const name = getStoredUser()?.name ?? '';
        // Self-heal: the backend degraded to the login's own outlet because the
        // active_partner_id cookie named a non-operable partner (stale/foreign). Clear the
        // cookie ONCE so every other page/request stops sending the bad id. Guarded by
        // healedRef so it can never loop.
        if (d?.activeSelectorInvalid === true && !healedRef.current) {
          healedRef.current = true;
          void setActivePartner(null);
        }
        // Settle loading regardless — a caller with no channel-partner row (d null) is a
        // resolved "no activity" state, not an eternal load.
        setIdentity((prev) => ({
          businessName: d?.businessName || name || prev.businessName,
          // Active outlet's master name; null when absent so the header falls back to businessName.
          outletName: d?.outletName ?? null,
          ownerName: d?.ownerName || name || prev.ownerName,
          partnerCode: d?.partnerCode ?? null,
          outletType: d?.outletType ?? null,
          hasPointsActivity: d?.hasPointsActivity === true,
          hasPayoutActivity: d?.hasPayoutActivity === true,
          // TRUE unless the API explicitly returns false (backward-compatible if absent).
          loyaltyEnabled: d?.loyaltyEnabled !== false,
          features: normalizeFeatures(d?.features),
          activePartnerId: d?.activePartnerId ?? null,
          operableOutlets: Array.isArray(d?.operableOutlets) ? (d.operableOutlets as OperableOutlet[]) : [],
          groupOverviewAvailable: d?.groupOverviewAvailable === true,
          groupParent: d?.groupParent ?? null,
          activeSelectorInvalid: d?.activeSelectorInvalid === true,
          deliveryDefaults: isDeliveryDefaults(d?.deliveryDefaults) ? d.deliveryDefaults : null,
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
