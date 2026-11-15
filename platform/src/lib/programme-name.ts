import { DEFAULT_CLIENT_CONFIG } from '@/lib/platform/default-client-config';

/**
 * The tenant's name for programme copy ("… consent to enroll in the <name> Loyalty Programme").
 * Returns null when there is no usable tenant name — blank, or the platform DEFAULT config's
 * placeholder (the client config can degrade to DEFAULT before the tenant resolves) — so callers fall
 * back to neutral copy instead of ever showing another tenant's (or the platform's) name.
 * Replaces the hard-coded "Deoleo" programme copy on the shared KYC screens (owner 2026-11-14).
 */
export function programmeOwnerName(displayName: string | null | undefined): string | null {
  const name = (displayName ?? '').trim();
  if (!name || name === DEFAULT_CLIENT_CONFIG.branding.displayName.trim()) return null;
  return name;
}

/** "the Bajaj Consumer Care Ltd Loyalty Programme" / neutral "the Loyalty Programme". */
export function loyaltyProgrammeLabel(displayName: string | null | undefined): string {
  const name = programmeOwnerName(displayName);
  return name ? `the ${name} Loyalty Programme` : 'the Loyalty Programme';
}

/** Self-declaration PDF sub-heading programme name: "Deoleo India Trade Loyalty Programme" / "Trade Loyalty Programme". */
export function tradeLoyaltyProgrammeTitle(displayName: string | null | undefined): string {
  const name = programmeOwnerName(displayName);
  return name ? `${name} Trade Loyalty Programme` : 'Trade Loyalty Programme';
}
