/* ─── KYC SLA Target API client (two-stage) ───────────────────────────────────
   Reads/writes the tenant's TWO KYC review-SLA targets — the Field SLA and the
   Gifsy SLA — via the generic program-settings endpoints:

     READ:  GET  /api/admin/settings   → settings.fieldSlaTargetHours (24)
                                          settings.gifsySlaTargetHours (96)
     WRITE: PUT  /api/admin/settings   → { key, value }  (one PUT per key)

   Both targets are business-hours clocks (see @/lib/kyc-sla-stage):
     • FIELD SLA — submission → the KYC reaching Gifsy (sales-chain owned; default 24)
     • GIFSY SLA — latest PENDING_GIFSY entry → decision (Gifsy owned; default 96)

   They REPLACE the old single `slaTargetHours` (48). The WRITE is GIFSY_ADMIN-only
   (settings PUT enforces tenancy:write + Gifsy-Admin); reads are permitted for
   GIFSY_ADMIN + CLIENT_ADMIN (tenancy:read). Responses ride the global
   { success, data } envelope (TransformInterceptor). The keys/defaults/bounds are
   the single source of truth in kyc-sla-stage.ts — imported here, not re-declared.
──────────────────────────────────────────────────────────────────────────────── */

import { api } from '@/lib/api-client';
import {
  KYC_FIELD_SLA_KEY,
  KYC_GIFSY_SLA_KEY,
  KYC_FIELD_SLA_DEFAULT,
  KYC_GIFSY_SLA_DEFAULT,
  KYC_SLA_MIN_HOURS,
  KYC_SLA_MAX_HOURS,
} from '@/lib/kyc-sla-stage';

export interface KycSlaTargets {
  fieldHrs: number;
  gifsyHrs: number;
}

/** A stored setting value coerced to a whole number in the 1–168 bound, else the default. */
function readBounded(raw: unknown, def: number): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= KYC_SLA_MIN_HOURS && n <= KYC_SLA_MAX_HOURS) return n;
  return def;
}

/**
 * Reads the tenant's two KYC SLA targets (business hours). Falls back to the
 * defaults (24 / 96) if the request fails or either value is absent/out of bounds.
 */
export async function fetchKycSlaTargets(): Promise<KycSlaTargets> {
  const res = await api.get<{ settings?: Record<string, unknown> }>('/api/admin/settings');
  const settings = res.success ? res.data?.settings : undefined;
  return {
    fieldHrs: readBounded(settings?.[KYC_FIELD_SLA_KEY], KYC_FIELD_SLA_DEFAULT),
    gifsyHrs: readBounded(settings?.[KYC_GIFSY_SLA_KEY], KYC_GIFSY_SLA_DEFAULT),
  };
}

/**
 * Persists both KYC SLA targets for the caller's tenant via two settings upserts
 * (PUT /api/admin/settings { key, value } — GIFSY_ADMIN only; the backend returns
 * 403 for any other role). Returns true only if BOTH writes succeed.
 */
export async function saveKycSlaTargets(t: KycSlaTargets): Promise<boolean> {
  const [field, gifsy] = await Promise.all([
    api.put('/api/admin/settings', {
      key: KYC_FIELD_SLA_KEY,
      value: t.fieldHrs,
      category: 'kyc',
      description: 'KYC Field SLA target (business hours from submission to reaching Gifsy)',
    }),
    api.put('/api/admin/settings', {
      key: KYC_GIFSY_SLA_KEY,
      value: t.gifsyHrs,
      category: 'kyc',
      description: 'KYC Gifsy SLA target (business hours from the latest Gifsy entry to the decision)',
    }),
  ]);
  return field.success && gifsy.success;
}
