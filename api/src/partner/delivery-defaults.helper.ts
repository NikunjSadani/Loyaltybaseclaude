/**
 * Delivery-address pre-fill for the partner physical-gift redeem form (PLATFORM-WIDE, owner-approved
 * 2026-11-06 — see platform/docs/plans/DELIVERY-ADDRESS-PREFILL-PLAN.md).
 *
 * Source is the ACTIVE partner's primary OUTLET address only (owner D3 = C — never a previous
 * order's address). Pure: no Nest/Prisma imports, so every rule is unit-tested in isolation.
 */

/** What the redeem form may pre-fill. Any field may be null (not on file → partner types it). */
export interface DeliveryDefaults {
  /** Street: Outlet.addressLine1 + addressLine2 joined with ", " (line2 skipped if already in line1). */
  line1: string | null;
  city: string | null;
  state: string | null;
  /** Only a pincode the redeem endpoint would accept (same rule as rewards assertValidPincode). */
  pincode: string | null;
}

export interface OutletAddress {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
}

// Mirrors RewardsService.assertValidPincode for PHYSICAL_GIFT — never pre-fill a value the
// redeem would reject (legacy/imported data can hold "0", 5 digits, a leading 0, …).
const VALID_PINCODE = /^[1-9]\d{5}$/;

// Placeholder junk seen in imported/legacy master data. WHOLE-value matches only, so a real value
// that merely contains these characters/words ('A-1 Road', 'N/A Road', 'Goa') is never dropped.
const JUNK_CHARS_ONLY = /^[\s\-.,/_0]*$/;
const JUNK_WORDS = new Set(['na', 'n/a', 'nil', 'null', 'none', 'unknown', 'not available']);

/** Trim, collapse inner whitespace (incl. newlines) to single spaces; junk/blank → null. */
function clean(v: string | null | undefined): string | null {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!t || JUNK_CHARS_ONLY.test(t) || JUNK_WORDS.has(t.toLowerCase())) return null;
  return t;
}

/** Street line: addressLine1 + addressLine2, skipping a line2 that repeats (or is inside) line1. */
function joinStreet(line1: string | null, line2: string | null): string | null {
  if (!line1 || !line2) return line1 ?? line2;
  return line1.toLowerCase().includes(line2.toLowerCase()) ? line1 : `${line1}, ${line2}`;
}

/** Normalise the outlet's address into form defaults; null when nothing usable is on file. */
export function pickDeliveryDefaults(outlet: OutletAddress | null | undefined): DeliveryDefaults | null {
  if (!outlet) return null;
  const street = joinStreet(clean(outlet.addressLine1), clean(outlet.addressLine2));
  const pincode = clean(outlet.pincode);
  const res: DeliveryDefaults = {
    line1: street,
    city: clean(outlet.city),
    state: clean(outlet.state),
    pincode: pincode && VALID_PINCODE.test(pincode) ? pincode : null,
  };
  return res.line1 || res.city || res.state || res.pincode ? res : null;
}
