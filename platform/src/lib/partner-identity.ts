/* ─── Partner identity (REAL) ─────────────────────────────────────────────────
   Sources the logged-in partner's real identity from GET /api/partner/me (the
   channel-partner record), replacing the demo persona in lib/partner-session
   (DEMO_SESSIONS — "Rajesh Kumar / Kumar General Store / Gold") for shell/header
   display. While loading it shows the OUTLET identity stored in the `user` object
   (outletName/businessName — from the login reply, then overwritten by every successful
   /partner/me and by an outlet pick, so it names the last-known ACTIVE outlet even after a
   sibling switch or an admin rename), so the header title never flashes the person's name; a
   pre-deploy stored login without those fields (or a caller with no channel-partner row)
   falls back to the JWT user name — NEVER the demo persona, so no flash-of-demo. Client-only.
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import { useState, useEffect, useRef } from 'react';
import { authHeader } from '@/lib/api-client';
import { getStoredUser, updateStoredPartnerDisplay } from '@/lib/auth-client';
import { setActivePartner } from '@/lib/active-partner-actions';
import { clearSessionCache } from '@/lib/session-cache';

/**
 * Switch the ACTIVE partner outlet (the httpOnly `active_partner_id` cookie, via the server action) AND drop every
 * cached read — the bell's unread count etc. belong to the previous outlet. The server action is not a /api fetch,
 * so the global write-clear in lib/client-medium.ts never sees it (audit fix 5). Broadcast: the cookie is shared by
 * every tab, so other tabs clear too.
 */
export async function switchActivePartner(partnerId: string | null): Promise<void> {
  try {
    await setActivePartner(partnerId);
  } finally {
    clearSessionCache();
  }
}
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

export function isDeliveryDefaults(v: unknown): v is DeliveryDefaults {
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
  /**
   * True only once a SUCCESSFUL GET /partner/me has settled for the CURRENT active-outlet selection
   * (false while loading, after a failure, and while a post-pick refetch is in flight). Unlike
   * `loading`, a failure does NOT make this true — so a consumer that must name the ACTIVE outlet
   * (e.g. the wallet statement download) can tell a confirmed identity from the stored/seeded one.
   */
  resolved: boolean;
}

/** The pre-/partner/me defaults (also what a failed post-pick refetch resets to — see load()). */
const INITIAL_IDENTITY: PartnerIdentity = {
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
    resolved: false,
};

/**
 * Overlay the stored display identity (getStoredUser) onto `base`'s empty name fields. The header
 * TITLE comes from the stored OUTLET identity (outletName / businessName — the login reply's own
 * outlet, then overwritten by every successful /partner/me and by an outlet pick, so it names the
 * last-known ACTIVE outlet), never the person's user.name, so the title doesn't flip person → outlet
 * on every load. The person name still seeds ownerName (the sub-line). A stored login from BEFORE the
 * backend added those fields has neither → legacy behaviour (person name as the provisional title).
 */
function withStoredSeed(base: PartnerIdentity): PartnerIdentity {
  const stored = getStoredUser();
  if (!stored) return base;
  const personName = stored.name ?? '';
  const loginOutletName = stored.outletName || null;
  const loginTitle = loginOutletName || stored.businessName || '';
  if (!personName && !loginTitle) return base;
  return {
    ...base,
    businessName: base.businessName || (loginTitle ? stored.businessName || loginTitle : personName),
    outletName: base.outletName ?? loginOutletName,
    ownerName: base.ownerName || personName,
  };
}

/** Persist /partner/me's (or a picked outlet's) display names into the stored user for the next paint. */
function rememberDisplay(src: { businessName?: unknown; outletName?: unknown }): void {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  updateStoredPartnerDisplay({ businessName: str(src.businessName), outletName: str(src.outletName) });
}

/**
 * Record the outlet the login is about to ACT AS (picker / switcher / Group Overview → own outlet)
 * in the stored user BEFORE navigating, so the very next paint — including the switcher's hard
 * reload, and the header after a failed post-pick refetch — names the picked outlet, not the
 * previous one. No-op for a missing outlet. /partner/me's own write-back then confirms it.
 */
export function rememberActiveOutletDisplay(
  outlet: Pick<OperableOutlet, 'businessName' | 'outletName'> | null | undefined,
): void {
  if (outlet) rememberDisplay(outlet);
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
  const [identity, setIdentity] = useState<PartnerIdentity>(INITIAL_IDENTITY);

  // Guards the self-heal so the stale `active_partner_id` cookie is cleared AT MOST ONCE
  // per component mount — clearing it triggers no refetch here, but this makes the intent
  // (fire-once, no loop) explicit and robust against any future re-fetch.
  const healedRef = useRef(false);

  // Seed the cached display identity AFTER mount — not during render (that localStorage read
  // during the initial render is what caused the React #418 hydration mismatch). Post-
  // hydration SSR and the first client paint agree (both empty), then this fills the name
  // on the first post-mount commit (≤1 frame later), well before /partner/me resolves. The
  // old code filled it during the first paint but at the cost of the app-wide hydration error.
  // See withStoredSeed for which stored fields seed which identity fields.
  useEffect(() => {
    // /partner/me already settled — its (authoritative) values win; nothing to seed.
    setIdentity((prev) => (prev.loading ? withStoredSeed(prev) : prev));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Monotonic request id: a refetch (after an outlet pick) must never be overwritten by an
    // older in-flight response for the previously-active outlet.
    let seq = 0;
    // `afterPick` = a refetch fired by announceActivePartnerChanged (the cookie now names a
    // DIFFERENT outlet than the current state); `retried` = this is that refetch's one retry.
    const load = (afterPick = false, retried = false) => {
      const mine = ++seq;
      // The current state describes the PREVIOUS outlet until this refetch succeeds — it is no
      // longer a confirmed identity for the active selection.
      if (afterPick && !retried) {
        setIdentity((prev) => (prev.resolved ? { ...prev, resolved: false } : prev));
      }
      fetch('/api/partner/me', { headers: { ...authHeader() } })
      // A non-OK reply is a FAILURE (→ .catch keeps the seeded outlet title), not a resolved
      // "no channel partner" — previously it fell through with d=null and replaced the title
      // with the person's name. (A 200 with data:null is still the resolved no-partner state.)
      .then((r) => {
        if (!r.ok) throw new Error(`partner/me ${r.status}`);
        return r.json();
      })
      .then((res) => {
        if (cancelled || mine !== seq) return;
        const d = res?.data;
        const name = getStoredUser()?.name ?? '';
        // Self-heal: the backend degraded to the login's own outlet because the
        // active_partner_id cookie named a non-operable partner (stale/foreign). Clear the
        // cookie ONCE so every other page/request stops sending the bad id. Guarded by
        // healedRef so it can never loop.
        if (d?.activeSelectorInvalid === true && !healedRef.current) {
          healedRef.current = true;
          void switchActivePartner(null);
        }
        // Write the ACTIVE outlet's authoritative display names back into the stored user, so the
        // next mount/reload paints THIS outlet from the first frame (a sibling selection survives
        // reloads via the 30-day cookie; an admin rename lands here too). Only for a real partner
        // row — a resolved "no channel partner" (d null) leaves the stored user untouched.
        if (d && typeof d === 'object') rememberDisplay(d);
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
          resolved: true,
        }));
      })
      .catch(() => {
        if (cancelled || mine !== seq) return;
        if (!afterPick) {
          // Initial load: keep the seeded (stored / JWT-name) fallback, but settle loading so gates resolve.
          setIdentity((prev) => ({ ...prev, loading: false }));
          return;
        }
        // After a pick the state still holds the PREVIOUS outlet (nav flags, activity, outlets, active
        // id) while the cookie names the new one. Retry once; if that fails too, never present the old
        // outlet's state as the new one's — reset to the defaults + the stored title (which the pick
        // already set to the picked outlet via rememberActiveOutletDisplay).
        if (!retried) {
          load(true, true);
          return;
        }
        setIdentity(withStoredSeed({ ...INITIAL_IDENTITY, loading: false }));
      });
    };
    load();
    // The active outlet is an httpOnly cookie the client can't observe, and the partner LAYOUT
    // stays mounted across a client-side router.push — so a pick on /partner/select would leave
    // the shell header/nav on the pre-pick outlet until a full reload. Callers that change the
    // selection announce it; we re-read /partner/me (now carrying the new cookie).
    const onChanged = () => load(true);
    window.addEventListener(ACTIVE_PARTNER_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(ACTIVE_PARTNER_CHANGED_EVENT, onChanged);
    };
  }, []);

  return identity;
}

/** Window event fired after the `active_partner_id` selection changes without a full reload. */
export const ACTIVE_PARTNER_CHANGED_EVENT = 'gifsy:active-partner-changed';

/**
 * Tell every mounted usePartnerIdentity() (notably the partner layout's header/nav) that the
 * active outlet changed, so it re-fetches /partner/me. Call AFTER `await setActivePartner(...)`
 * when navigating client-side (router.push); a full-page navigation doesn't need it.
 */
export function announceActivePartnerChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ACTIVE_PARTNER_CHANGED_EVENT));
}
