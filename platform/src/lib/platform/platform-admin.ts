/**
 * Platform admin helpers — pure functions used by the GIFSY super-admin UI.
 *
 * Key rule enforced here:
 *   CLIENT_ADMIN cannot modify any ClientConfig field.
 *   Only GIFSY_ADMIN can call applyFeatureFlagUpdate / any config mutation.
 */

import type { ClientConfig, FeatureKey } from './client-config';

export type AdminRole = 'GIFSY_ADMIN' | 'CLIENT_ADMIN';

// ─────────────────────────────────────────────────────────────────────────────
// Reserved slugs
// ─────────────────────────────────────────────────────────────────────────────

const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'status', 'mail', 'gifsy',
  'platform', 'support', 'help', 'billing', 'auth', 'login',
]);

// ─────────────────────────────────────────────────────────────────────────────
// validateNewClientSlug
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a proposed slug for a new client.
 * Returns an array of human-readable error strings; empty = valid.
 */
export function validateNewClientSlug(
  slug: string,
  existingSlugs: readonly string[],
): string[] {
  const errors: string[] = [];

  if (!/^[a-z0-9-]+$/.test(slug)) {
    errors.push('Slug must be lowercase alphanumeric with hyphens only (e.g. "client-b").');
  }

  if (slug.length < 3) {
    errors.push('Slug must be at least 3 characters long.');
  }

  if (slug.length > 30) {
    errors.push('Slug must be no more than 30 characters long.');
  }

  if (RESERVED_SLUGS.has(slug)) {
    errors.push(`"${slug}" is a reserved platform slug and cannot be used.`);
  }

  if (existingSlugs.includes(slug)) {
    errors.push(`Slug "${slug}" already exists. Choose a unique identifier.`);
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant custom domains (§A-DOMAIN)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every routed tenant hostname must be a subdomain of this zone. Mirrors the
 * backend `TENANT_DOMAIN_SUFFIX` (gifsy.service.ts).
 */
export const TENANT_DOMAIN_SUFFIX = '.gifsy.in';

/**
 * First-label subdomains a tenant may NOT claim — platform-infrastructure hosts.
 * Mirrors the backend `RESERVED_DOMAIN_LABELS`; kept in sync so the console blocks
 * a clash BEFORE the round-trip (the backend remains the authoritative guard).
 */
export const RESERVED_DOMAIN_LABELS = new Set([
  'api', 'app', 'www', 'platform', 'admin', 'status', 'mail', 'uat',
]);

/** RFC-1123 hostname shape (lower-cased) — mirrors the backend HOSTNAME_RE. */
const DOMAIN_HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Lower-case + trim a domain to the canonical form the backend stores/compares. */
export function normalizeTenantDomain(domain: string): string {
  return (domain ?? '').trim().toLowerCase();
}

/**
 * Client-side validation of one branded tenant domain. Returns a human-readable
 * error string, or null when the domain is acceptable. Uniqueness across tenants
 * is NOT checked here — that is the backend 409 (surfaced in the console).
 */
export function validateTenantDomain(domain: string): string | null {
  const d = normalizeTenantDomain(domain);
  if (!d) return 'Enter a domain.';
  if (!d.endsWith(TENANT_DOMAIN_SUFFIX)) {
    return 'Domain must be a subdomain of gifsy.in (e.g. brand.gifsy.in).';
  }
  if (d === TENANT_DOMAIN_SUFFIX.slice(1)) {
    return 'Enter a subdomain of gifsy.in, not the bare gifsy.in.';
  }
  if (!DOMAIN_HOSTNAME_RE.test(d)) {
    return `"${d}" is not a valid hostname.`;
  }
  const firstLabel = d.split('.')[0];
  if (RESERVED_DOMAIN_LABELS.has(firstLabel)) {
    return `"${firstLabel}" is a reserved subdomain and cannot be assigned to a tenant.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyFeatureFlagUpdate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a new ClientConfig with the specified feature flag updated.
 * Throws if the caller is not GIFSY_ADMIN — CLIENT_ADMIN cannot change flags.
 * Does NOT mutate the original config.
 */
export function applyFeatureFlagUpdate(
  config: ClientConfig,
  key: FeatureKey,
  value: boolean,
  callerRole: AdminRole,
): ClientConfig {
  if (callerRole !== 'GIFSY_ADMIN') {
    throw new Error(
      `Permission denied: only GIFSY_ADMIN can modify feature flags. ` +
      `Attempted by ${callerRole}.`,
    );
  }

  return {
    ...config,
    features: {
      ...config.features,
      [key]: value,
      // Keep partnerApp flags in sync with their parent module flags
      partnerApp: {
        ...config.features.partnerApp,
        showInvoices:
          key === 'visibilityInvoiceModule' ? value : config.features.partnerApp.showInvoices,
        showWallet:
          key === 'walletModule' ? value : config.features.partnerApp.showWallet,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// canClientAdminModify
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns whether a CLIENT_ADMIN is allowed to modify a given config path.
 *
 * The answer is always false — CLIENT_ADMIN cannot modify any part of the
 * ClientConfig.  This function exists as an explicit contract so every
 * access-control check reads clearly in code rather than being a bare `false`.
 */
export function canClientAdminModify(_configPath: string): false {
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ClientSummary — lightweight view for the client list
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientSummary {
  slug: string;
  displayName: string;
  internalName: string;
  status: ClientConfig['status'];
  primaryColor: string;
  enabledFeatureCount: number;
  partnerClassCount: number;
  onboardedAt: string;
}

/**
 * Builds a lightweight summary row for display in the GIFSY client list.
 */
export function buildClientSummary(config: ClientConfig): ClientSummary {
  const { features } = config;
  const featureKeys: FeatureKey[] = [
    'visibilityInvoiceModule',
    'kycApprovalFlow',
    'campaignEnrollmentForm',
    'salesTeamApp',
    'walletModule',
    'referralModule',
    'selfEnrollmentAllowed',
    'nonKycOutletCampaigns',
    'multiLevelApproval',
  ];

  const enabledFeatureCount = featureKeys.filter(
    (k) => !!(features as unknown as Record<string, boolean>)[k],
  ).length;

  return {
    slug:               config.slug,
    displayName:        config.branding.displayName,
    internalName:       config.internalName,
    status:             config.status,
    primaryColor:       config.branding.primaryColor,
    enabledFeatureCount,
    partnerClassCount:  config.partnerClasses.length,
    onboardedAt:        config.onboardedAt,
  };
}
