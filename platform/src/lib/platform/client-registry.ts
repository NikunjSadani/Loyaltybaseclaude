/**
 * Client registry — a MINIMAL in-code fallback seed for onboarded tenants.
 *
 * §A-DOMAIN "P5": the registry no longer carries rich per-tenant `features`,
 * `partnerClasses`, invoicing, notifications, approval hierarchy or wallet config.
 * Those are served from the DB — feature gating via the AUTHENTICATED per-role
 * endpoints (read on the FE with `useTenantFeatures` / `usePartnerIdentity`), and
 * per-tenant BRANDING via the DB routing snapshot overlaid by `applyDbBranding`.
 *
 * Each entry here is `DEFAULT_CLIENT_CONFIG` spread with only:
 *   - slug / internalName / status / onboardedAt — tenant identity,
 *   - domains — the branded domain→slug seed (`REGISTRY_DOMAIN_TO_SLUG`) so the
 *     kill-switch / cold-start domain fallback still resolves before the DB routing
 *     map warms,
 *   - branding — a cold-start branding fallback (the DB overlay wins once warm).
 *
 * The registry remains the source of the KNOWN-slug set, so `resolveClientConfig`
 * still returns `null` for a genuinely unknown slug with no DB branding → the proxy
 * fail-closes to 404 (an unknown tenant must never render default branding).
 *
 * Adding a new client no longer requires a rich object here — a DB `clients` row
 * (features/branding) + a `client_domains` entry is sufficient. A slug is added
 * here only when it needs an in-code cold-start branding/domain fallback.
 */

import type { ClientConfig } from './client-config';
import { DEFAULT_CLIENT_CONFIG } from './default-client-config';

// ─────────────────────────────────────────────────────────────────────────────
// Deoleo India — minimal cold-start fallback (real config is DB-served)
// ─────────────────────────────────────────────────────────────────────────────

export const DEOLEO_CONFIG: ClientConfig = {
  ...DEFAULT_CLIENT_CONFIG,
  slug: 'deoleo',
  // Branded customer-facing domain (≠ the slug) → resolves to clientId `deoleo`.
  domains: ['deoleoloyalty.gifsy.in'],
  internalName: 'Deoleo India Pvt. Ltd.',
  status: 'ACTIVE',
  onboardedAt: '2025-01-01',

  branding: {
    ...DEFAULT_CLIENT_CONFIG.branding,
    displayName: 'Deoleo India',
    primaryColor: '#16a34a',
    logoUrl: '/logos/deoleo.svg',
    wordmarkWhiteUrl: '/brand/deoleo-wordmark-white.png', // white wordmark for the navy sales header + desktop sidebar
    wordmarkColorUrl: '/brand/deoleo-wordmark-color.png', // colour wordmark for the white partner/outlet header
    faviconUrl: '/favicons/deoleo.ico',
    supportEmail: 'support@deoleo.gifsy.in',
    supportPhone: '+91-1800-000-0001',
    productBrands: ['Bertolli', 'Figaro'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Demo Client B (placeholder — a differently-branded cold-start fallback)
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_B_CONFIG: ClientConfig = {
  ...DEFAULT_CLIENT_CONFIG,
  slug: 'clientb',
  internalName: 'Client B (Demo)',
  status: 'ONBOARDING',
  onboardedAt: '2026-06-01',

  branding: {
    ...DEFAULT_CLIENT_CONFIG.branding,
    displayName: 'Client B Loyalty',
    primaryColor: '#2563eb',          // blue — different from Deoleo
    logoUrl: '/logos/clientb.svg',
    faviconUrl: '/favicons/clientb.ico',
    supportEmail: 'support@clientb.gifsy.in',
    supportPhone: '+91-1800-000-0002',
    productBrands: [],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry map — slug → minimal config
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_REGISTRY: Record<string, ClientConfig> = {
  [DEOLEO_CONFIG.slug]:   DEOLEO_CONFIG,
  [CLIENT_B_CONFIG.slug]: CLIENT_B_CONFIG,
};
