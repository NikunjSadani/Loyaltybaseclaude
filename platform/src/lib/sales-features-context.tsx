'use client';

/* ─── Sales-shell tenant features (no extra request) ─────────────────────────
   The sales layout already fetches /api/sales/me (name + employee code), and that
   response carries the tenant's `features` blob. The layout publishes the normalized
   flags through this context so a sales page (e.g. Profile's "Help & videos" entry)
   can gate on a flag WITHOUT issuing its own request. `null` = not loaded yet / no
   provider (tests, or a failed /sales/me) → callers treat every flag as OFF.
─────────────────────────────────────────────────────────────────────────────── */

import { createContext, useContext } from 'react';
import type { FeatureFlags } from '@/lib/platform/client-config';

export const SalesFeaturesContext = createContext<FeatureFlags | null>(null);

export function useSalesFeatures(): FeatureFlags | null {
  return useContext(SalesFeaturesContext);
}
