/* ─── Tenant features (authenticated, DB-backed) ──────────────────────────────
   §A-DOMAIN "P5": per-tenant runtime feature gating is served from the DB via the
   caller's AUTHENTICATED role endpoint — /partner/me, /sales/me,
   /admin/settings/config — instead of the in-code CLIENT_REGISTRY. Each endpoint
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

import { useState, useEffect } from 'react';
import { authHeader } from '@/lib/api-client';
import type { FeatureFlags } from '@/lib/platform/client-config';
import { DEFAULT_CLIENT_CONFIG } from '@/lib/platform/default-client-config';

/**
 * Conservative default flags — used while the authenticated features load and for
 * any key absent from the DB blob. Sourced from DEFAULT_CLIENT_CONFIG so there is a
 * single definition of "safe defaults".
 */
export const DEFAULT_FEATURES: FeatureFlags = DEFAULT_CLIENT_CONFIG.features;

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
    campaignEnrollmentForm:  bool(f.campaignEnrollmentForm,  d.campaignEnrollmentForm),
    salesTeamApp:            bool(f.salesTeamApp,            d.salesTeamApp),
    walletModule:            bool(f.walletModule,            d.walletModule),
    referralModule:          bool(f.referralModule,          d.referralModule),
    selfEnrollmentAllowed:   bool(f.selfEnrollmentAllowed,   d.selfEnrollmentAllowed),
    nonKycOutletCampaigns:   bool(f.nonKycOutletCampaigns,   d.nonKycOutletCampaigns),
    multiLevelApproval:      bool(f.multiLevelApproval,      d.multiLevelApproval),
    rbacEnforcement:         bool(f.rbacEnforcement,         d.rbacEnforcement),
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
}

/**
 * Fetch the current tenant's features from an authenticated role endpoint (one of
 * /api/partner/me, /api/sales/me, /api/admin/settings/config). Returns
 * DEFAULT_FEATURES while loading and on error (settles loading either way, so a
 * consumer that gates on the flags can resolve without hanging).
 */
export function useTenantFeatures(endpoint: string): TenantFeaturesState {
  const [state, setState] = useState<TenantFeaturesState>({
    features: DEFAULT_FEATURES,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { headers: { ...authHeader() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (cancelled) return;
        setState({ features: normalizeFeatures(res?.data?.features), loading: false });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  return state;
}
