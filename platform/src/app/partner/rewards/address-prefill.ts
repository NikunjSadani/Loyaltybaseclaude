/* ─── Gift delivery-address pre-fill (PLATFORM-WIDE, owner-approved 2026-11-06) ───────────
   The redeem form pre-fills from the ACTIVE outlet's address on file (identity.deliveryDefaults).
   Hard rule: the pre-fill NEVER overwrites what the partner typed or deliberately cleared —
   including when /partner/me resolves after they started typing. Encoded once, here. */

import type { DeliveryDefaults } from '@/lib/partner-identity';

export type AddressForm = { line1: string; city: string; state: string; pincode: string };
export type TouchedFields = Partial<Record<keyof AddressForm, boolean>>;

const KEYS: (keyof AddressForm)[] = ['line1', 'city', 'state', 'pincode'];

/** Fill ONLY fields that are empty AND untouched; returns the same object if nothing changes. */
export function applyAddressPrefill(
  form: AddressForm,
  touched: TouchedFields,
  defaults: DeliveryDefaults | null | undefined,
): AddressForm {
  if (!defaults) return form;
  let next: AddressForm | null = null;
  for (const k of KEYS) {
    const v = defaults[k];
    if (v && !touched[k] && !form[k]) {
      next = next ?? { ...form };
      next[k] = v;
    }
  }
  return next ?? form;
}
