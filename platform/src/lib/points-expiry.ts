/* ─── Points Expiry API client ────────────────────────────────────────────────
   Reads the tenant's default points-expiry from GET /api/admin/settings/points-expiry
   and writes it via PUT /api/admin/settings/points-expiry.

   GIFSY_ADMIN only for the WRITE — enforced on the backend (tenancy:write).
   Reads are permitted for GIFSY_ADMIN + CLIENT_ADMIN (tenancy:read).

   `pointsExpiryDays`:
     - null            → points never expire.
     - positive number → earned points expire that many days after they're granted.

   Responses ride the global { success, data } envelope (TransformInterceptor).
──────────────────────────────────────────────────────────────────────────────── */

import { api } from '@/lib/api-client';

export interface PointsExpiry {
  pointsExpiryDays: number | null;
}

/**
 * Reads the current default points-expiry for the caller's tenant.
 * Falls back to { pointsExpiryDays: null } (never expire) if the request fails.
 */
export async function fetchPointsExpiry(): Promise<PointsExpiry> {
  const res = await api.get<PointsExpiry>('/api/admin/settings/points-expiry');
  if (res.success) return { pointsExpiryDays: res.data?.pointsExpiryDays ?? null };
  return { pointsExpiryDays: null };
}

/**
 * Persists the default points-expiry for the caller's tenant.
 * PUT /api/admin/settings/points-expiry — GIFSY_ADMIN only (the backend returns 403
 * for any other role). Returns true on success.
 */
export async function savePointsExpiry(pointsExpiryDays: number | null): Promise<boolean> {
  const res = await api.put('/api/admin/settings/points-expiry', { pointsExpiryDays });
  return res.success;
}
