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

/* ─── Capabilities (Employee Rewards) ─────────────────────────────────────────
   The backend resolves a per-tenant CapabilitySet from `loyaltyType` (+ per-client
   overrides) — see api/src/common/loyalty-capabilities.helper.ts — and now returns it
   on /admin/settings/config under `data.capabilities`. The FE reads it (it does NOT
   re-derive it) to gate the admin shell by capability. Fail-safe: anything
   missing/malformed resolves to the TRADE defaults (the live product), so an absent
   value can never flip a tenant into the compliance-off employee posture. ───────── */

export type EarnerModel = 'OUTLET' | 'EMPLOYEE';

export interface Capabilities {
  /** Derived from loyaltyType by the backend; NOT overridable. */
  earnerModel: EarnerModel;
  kyc: boolean;
  gst: boolean;
  tds: boolean;
  payouts: boolean;
  invoicing: boolean;
  vendorMarketplace: boolean;
  celebratoryUx: boolean;
}

/** The boolean capability keys (everything except the derived earnerModel). */
export type CapabilityKey = Exclude<keyof Capabilities, 'earnerModel'>;

/** TRADE defaults — the live product, and the fail-safe target. */
export const TRADE_CAPABILITIES: Capabilities = {
  earnerModel: 'OUTLET',
  kyc: true,
  gst: true,
  tds: true,
  payouts: true,
  invoicing: true,
  vendorMarketplace: false,
  celebratoryUx: false,
};

const CAP_KEYS: readonly CapabilityKey[] = [
  'kyc', 'gst', 'tds', 'payouts', 'invoicing', 'vendorMarketplace', 'celebratoryUx',
];

/**
 * Shape the raw `data.capabilities` blob into a fully-populated Capabilities.
 * Fail-safe: a missing/invalid blob returns TRADE defaults; earnerModel is only
 * 'EMPLOYEE' when explicitly present, otherwise 'OUTLET' (never guessed into the
 * compliance-off posture). Each boolean falls back to its TRADE default when absent.
 */
export function normalizeCapabilities(raw: unknown): Capabilities {
  const c = (raw ?? null) as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return { ...TRADE_CAPABILITIES };
  const out: Capabilities = { ...TRADE_CAPABILITIES };
  out.earnerModel = c.earnerModel === 'EMPLOYEE' ? 'EMPLOYEE' : 'OUTLET';
  for (const k of CAP_KEYS) {
    if (typeof c[k] === 'boolean') out[k] = c[k] as boolean;
  }
  return out;
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
  /** The tenant's resolved capability set (Employee Rewards). TRADE defaults until
      the endpoint settles / for endpoints that don't return it (additive — existing
      consumers that only read `features` are unaffected). */
  capabilities: Capabilities;
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
    capabilities: TRADE_CAPABILITIES,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { headers: { ...authHeader() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (cancelled) return;
        setState({
          features: normalizeFeatures(res?.data?.features),
          capabilities: normalizeCapabilities(res?.data?.capabilities),
          loading: false,
        });
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
