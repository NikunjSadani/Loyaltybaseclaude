'use client';

/* ─── Vendor identity context ──────────────────────────────────────────────────
 * The vendor shell fetches GET /api/vendor/me ONCE and shares the result (identity +
 * the grant's approval policy) with every page via this context, so the catalogue
 * editor can show the correct re-approval note without a second round-trip. Null until
 * loaded (or when the caller is outside the provider). Client-only.
 * ─────────────────────────────────────────────────────────────────────────── */

import { createContext, useContext } from 'react';
import type { VendorMe } from '@/lib/vendor';

const VendorMeContext = createContext<VendorMe | null>(null);

export function VendorMeProvider({
  value,
  children,
}: {
  value: VendorMe | null;
  children: React.ReactNode;
}) {
  return <VendorMeContext.Provider value={value}>{children}</VendorMeContext.Provider>;
}

/** The current vendor identity + approval policy, or null before it has loaded. */
export function useVendorMe(): VendorMe | null {
  return useContext(VendorMeContext);
}
