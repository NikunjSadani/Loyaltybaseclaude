/* ─── Tenant features (authenticated, DB-backed) ──────────────────────────────
   §A-DOMAIN "P5": per-tenant runtime feature gating is served from the DB via the
   caller's AUTHENTICATED role endpoint — /partner/me, /sales/me,
   /admin/settings/features (flags-only; /admin/settings/config carries the same blob)
   — instead of the in-code CLIENT_REGISTRY. Each endpoint
   returns the raw `clients.features` blob under `data.features`.

   This module is the single FE seam for "the current tenant's features":
     - normalizeFeatures() shapes the raw blob into a fully-populated FeatureFlags
       with conservative defaults, so consumers can read nested keys
       (features.partnerApp.showLeaderboard) without null guards even if the DB blob
       is partial (e.g. a fresh tenant whose features JSON is `{}`).
     - useTenantFeatures(endpoint) fetches the role-appropriate endpoint and returns
       the normalized features + a loading flag.

   Client-only. Backend RBAC/feature enforcement is separate and DB-driven (D-1);
   this only governs FE nav/tab rendering.
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { authHeader } from '@/lib/api-client';
import { getSalesMe, SALES_ME_URL } from '@/lib/cached-reads';
import type { FeatureFlags } from '@/lib/platform/client-config';
import { DEFAULT_CLIENT_CONFIG } from '@/lib/platform/default-client-config';
import { isLocationRequired } from '@/lib/location-required';

/**
 * Conservative default flags — used while the authenticated features load and for
 * any key absent from the DB blob. Sourced from DEFAULT_CLIENT_CONFIG so there is a
 * single definition of "safe defaults".
 */
export const DEFAULT_FEATURES: FeatureFlags = DEFAULT_CLIENT_CONFIG.features;

/**
 * The admin shell's feature-switches read: GET /v1/admin/settings/features → `{ features }` (the same blob
 * /admin/settings/config returns under `features`, and nothing else). Readable by GIFSY_ADMIN, CLIENT_ADMIN
 * and an ASSUMED GIFSY_STAFF holding a grant for the tenant — WITHOUT tenancy:read (owner 2026-11-25), so a
 * staff role like "Project Manager" sees the flag-gated nav. MIS_USER is refused (as /config refuses it) →
 * defaults, unchanged. Use this for anything that only needs the flags; keep /config for the full config.
 */
export const ADMIN_FEATURES_URL = '/api/admin/settings/features';

/** Coerce an unknown value to boolean with a typed fallback (default when absent). */
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Normalize a raw `clients.features` blob into a fully-shaped FeatureFlags. Every
 * key falls back to the DEFAULT_FEATURES value when missing/non-boolean, and the
 * nested `partnerApp` object is always present — so a consumer can safely read
 * `features.partnerApp.showLeaderboard` regardless of how sparse the DB blob is.
 */
export function normalizeFeatures(raw: unknown): FeatureFlags {
  const f = (raw ?? {}) as Record<string, unknown>;
  const pa = (f.partnerApp ?? {}) as Record<string, unknown>;
  const d = DEFAULT_FEATURES;
  return {
    visibilityInvoiceModule: bool(f.visibilityInvoiceModule, d.visibilityInvoiceModule),
    kycApprovalFlow:         bool(f.kycApprovalFlow,         d.kycApprovalFlow),
    kycAddressProofWaiver:   bool(f.kycAddressProofWaiver,   d.kycAddressProofWaiver),
    soDeclarationKyc:        bool(f.soDeclarationKyc,        d.soDeclarationKyc),
    outletMasterGeo:         bool(f.outletMasterGeo,         d.outletMasterGeo),
    allowPayoutWithoutPan:   bool(f.allowPayoutWithoutPan,   d.allowPayoutWithoutPan),
    gifsyRejectFastTrack:    bool(f.gifsyRejectFastTrack,    d.gifsyRejectFastTrack),
    // Default ON (owner 2026-11-21): only an explicit false turns it off — the shared helper, never `bool(...)`.
    requireLocation:         isLocationRequired(f),
    campaignEnrollmentForm:  bool(f.campaignEnrollmentForm,  d.campaignEnrollmentForm),
    salesTeamApp:            bool(f.salesTeamApp,            d.salesTeamApp),
    walletModule:            bool(f.walletModule,            d.walletModule),
    referralModule:          bool(f.referralModule,          d.referralModule),
    selfEnrollmentAllowed:   bool(f.selfEnrollmentAllowed,   d.selfEnrollmentAllowed),
    nonKycOutletCampaigns:   bool(f.nonKycOutletCampaigns,   d.nonKycOutletCampaigns),
    multiLevelApproval:      bool(f.multiLevelApproval,      d.multiLevelApproval),
    rbacEnforcement:         bool(f.rbacEnforcement,         d.rbacEnforcement),
    hubbleVoucherEnabled:    bool(f.hubbleVoucherEnabled,    d.hubbleVoucherEnabled),
    rlpBscView:              bool(f.rlpBscView,              d.rlpBscView),
    catalogueMrpSlash:       bool(f.catalogueMrpSlash,       d.catalogueMrpSlash),
    partnerDashboardV2:      bool(f.partnerDashboardV2,      d.partnerDashboardV2),
    captureBankAtRedemption: bool(f.captureBankAtRedemption, d.captureBankAtRedemption),
    offerTiles:              bool(f.offerTiles,              d.offerTiles),
    salesImport:             bool(f.salesImport,             d.salesImport),
    wholesalerPayoutInclActivation: bool(f.wholesalerPayoutInclActivation, d.wholesalerPayoutInclActivation),
    helpVideos:              bool(f.helpVideos,              d.helpVideos),
    partnerApp: {
      showSchemes:     bool(pa.showSchemes,     d.partnerApp.showSchemes),
      showInvoices:    bool(pa.showInvoices,    d.partnerApp.showInvoices),
      showWallet:      bool(pa.showWallet,      d.partnerApp.showWallet),
      showTeam:        bool(pa.showTeam,        d.partnerApp.showTeam),
      showLeaderboard: bool(pa.showLeaderboard, d.partnerApp.showLeaderboard),
    },
  };
}

export interface TenantFeaturesState {
  /** Fully-shaped features. DEFAULT_FEATURES until the endpoint settles. */
  features: FeatureFlags;
  /** True until the endpoint resolves OR errors — gate feature-off UI on this. */
  loading: boolean;
  /** True when the features could NOT be read (non-2xx / network) — `features` are then the conservative defaults. */
  error?: boolean;
  /**
   * WHY the read failed (unset while loading / on success):
   *   'forbidden'   — HTTP 403: this role may not read the flags (e.g. MIS_USER on the admin read). A definite answer;
   *                   the defaults are expected, so callers stay quiet.
   *   'unavailable' — network error, 5xx, any other non-2xx, or an unreadable body: the flags are UNKNOWN and the
   *                   defaults are a guess — callers must say so visibly (owner rule: no silent fallback) and offer retry().
   */
  failure?: 'forbidden' | 'unavailable';
  /** Read the flags again (e.g. a "Retry" next to the 'unavailable' notice). */
  retry?: () => void;
  /**
   * Phone clock minus the server clock (ms), from the response's `Date` header (null when absent). Used ONLY by the
   * location gate to notice a phone whose date/time is wrong (LOCATION-GATE.md). Same single request as before.
   */
  serverSkewMs?: number | null;
  /** Location gate pages: re-read the server clock (no-store) — resolves the new skew. */
  refetchClock?: () => Promise<number | null>;
}

/**
 * Fetch the current tenant's features from an authenticated role endpoint (one of
 * /api/partner/me, /api/sales/me, ADMIN_FEATURES_URL). Returns
 * DEFAULT_FEATURES while loading and on error (settles loading either way, so a
 * consumer that gates on the flags can resolve without hanging).
 */
/**
 * Phone clock − server clock (ms) from a response: `Date` header minus any `Age` (a cached response's Date is older
 * than "now" by Age seconds). null when the header is absent / unreadable. Defensive: a proxy may add or strip either.
 */
export function serverSkewFromResponse(r: { headers?: { get?: (h: string) => string | null } } | null | undefined, nowMs: number = Date.now()): number | null {
  try {
    const d = Date.parse(r?.headers?.get?.('date') ?? '');
    if (!Number.isFinite(d)) return null;
    const ageSec = Number(r?.headers?.get?.('age') ?? '');
    const age = Number.isFinite(ageSec) && ageSec > 0 ? ageSec * 1000 : 0;
    return nowMs - (d + age);
  } catch {
    return null;
  }
}

/**
 * Fetch the current tenant's features from an authenticated role endpoint (one of
 * /api/partner/me, /api/sales/me, ADMIN_FEATURES_URL). Returns
 * DEFAULT_FEATURES while loading and on error (settles loading either way, so a
 * consumer that gates on the flags can resolve without hanging).
 *
 * `opts.clock` (location gate pages only — KYC wizard, visibility capture): the SAME original request (no extra option)
 * is read PASSIVELY for its `Date` / `Age` headers → `serverSkewMs`. `refetchClock()` is a separate `cache: 'no-store'`
 * confirmation the location gate makes ONLY when it is enabled and the passive skew looks > 24 h (and on the clock
 * guide's Test again). Switch-off tenants therefore send exactly the original request and never the confirmation.
 */
export function useTenantFeatures(endpoint: string, opts: { clock?: boolean } = {}): TenantFeaturesState {
  const clock = opts.clock === true;
  const [state, setState] = useState<TenantFeaturesState>({
    features: DEFAULT_FEATURES,
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    let cancelled = false;
    let serverSkewMs: number | null = null;
    let status: number | null = null; // HTTP status of a direct fetch (null for the cached /sales/me read)
    // /api/sales/me without the clock read is session-cached (lib/cached-reads.ts; shared with the sales layout).
    // The location-gate pages (`clock`) still make their own request: they need THIS response's Date header.
    const load: Promise<{ data?: { features?: unknown } } | null> =
      !clock && endpoint === SALES_ME_URL
        ? (getSalesMe<{ features?: unknown }>() as Promise<{ data?: { features?: unknown } } | null>)
        : fetch(endpoint, { headers: { ...authHeader() } }).then((r) => {
            serverSkewMs = clock ? serverSkewFromResponse(r) : null;
            status = r.status;
            return r.ok ? r.json() : null;
          });
    load
      .then((res) => {
        if (cancelled) return;
        const failure: TenantFeaturesState['failure'] = res ? undefined : status === 403 ? 'forbidden' : 'unavailable';
        setState({ features: normalizeFeatures(res?.data?.features), loading: false, error: !res, failure, serverSkewMs });
      })
      .catch(() => {
        // Network error / unreadable body — the flags are unknown (never a quiet default).
        if (!cancelled) setState((prev) => ({ ...prev, loading: false, error: true, failure: 'unavailable' }));
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, clock, attempt]);

  /**
   * Confirmation read of the server clock (`cache: 'no-store'`); updates `serverSkewMs`. A failed / header-less
   * confirmation resolves null and clears the skew — the phone then never blocks on the clock (the server still refuses
   * a wrong clock with its own message).
   */
  const refetchClock = useCallback(async (): Promise<number | null> => {
    let skew: number | null = null;
    try {
      const r = await fetch(endpoint, { headers: { ...authHeader() }, cache: 'no-store' });
      skew = serverSkewFromResponse(r);
    } catch {
      skew = null;
    }
    setState((prev) => ({ ...prev, serverSkewMs: skew }));
    return skew;
  }, [endpoint]);

  return { ...state, refetchClock, retry };
}
