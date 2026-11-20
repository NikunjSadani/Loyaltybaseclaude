import type { BrandingConfig } from './client-config';

/**
 * The name shown for the tenant's APP (installed-app label + install prompt, browser tab
 * title, sign-in heading, app headers). Uses the optional per-client `appName` (e.g.
 * "Bajaj Loyalty Club") and falls back to `displayName` (the company name) when unset or
 * blank — so a tenant without an appName (Deoleo) renders exactly as before.
 *
 * Company-name surfaces (KYC consent, self-declaration PDF, emails, reports, targets/offer
 * copy) must keep using `branding.displayName` directly — never this helper.
 */
export function appDisplayName(branding: Pick<BrandingConfig, 'displayName' | 'appName'>): string {
  return branding.appName?.trim() || branding.displayName;
}
