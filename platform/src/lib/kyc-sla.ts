/* ─── KYC SLA Target API client ───────────────────────────────────────────────
   Reads/writes the tenant's KYC SLA target (max working hours from submission to
   approval/rejection) via the generic program-settings endpoints:

     READ:  GET  /api/admin/settings           → settings.slaTargetHours
     WRITE: PUT  /api/admin/settings            → { key: 'slaTargetHours', value }

   The SLA target drives the breach count on the KYC SLA KPI dashboard (backend
   kyc.service.ts slaMetrics()). GIFSY_ADMIN only for the WRITE — enforced on the
   backend (tenancy:write, settings PUT is Gifsy-Admin-only). Reads are permitted
   for GIFSY_ADMIN + CLIENT_ADMIN (tenancy:read).

   Responses ride the global { success, data } envelope (TransformInterceptor).
──────────────────────────────────────────────────────────────────────────────── */

import { api } from '@/lib/api-client';

/** The programSetting key the backend stores/reads/enforces the SLA target under. */
export const KYC_SLA_SETTING_KEY = 'slaTargetHours';

/** Default fallback when no stored value exists — mirrors SETTINGS_DEFAULTS.slaTargetHours. */
export const KYC_SLA_DEFAULT_HOURS = 48;

/** Sane bounds for the SLA target, matched on the backend guard. */
export const KYC_SLA_MIN_HOURS = 1;
export const KYC_SLA_MAX_HOURS = 168;

/**
 * Reads the current KYC SLA target (working hours) for the caller's tenant.
 * Falls back to the default (48) if the request fails or the value is absent/invalid.
 */
export async function fetchKycSlaHours(): Promise<number> {
  const res = await api.get<{ settings?: Record<string, unknown> }>('/api/admin/settings');
  if (res.success) {
    const raw = res.data?.settings?.[KYC_SLA_SETTING_KEY];
    const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= KYC_SLA_MIN_HOURS && n <= KYC_SLA_MAX_HOURS) return n;
  }
  return KYC_SLA_DEFAULT_HOURS;
}

/**
 * Persists the KYC SLA target for the caller's tenant via the settings upsert.
 * PUT /api/admin/settings { key: 'slaTargetHours', value } — GIFSY_ADMIN only
 * (the backend returns 403 for any other role). Returns true on success.
 */
export async function saveKycSlaHours(hours: number): Promise<boolean> {
  const res = await api.put('/api/admin/settings', {
    key: KYC_SLA_SETTING_KEY,
    value: hours,
    category: 'kyc',
    description: 'KYC SLA target (working hours from submission to approval/rejection)',
  });
  return res.success;
}
