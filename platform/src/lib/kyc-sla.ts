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

/* ─── KYC review-SLA AGE ───────────────────────────────────────────────────────
   The SLA clock measures how long a submission waited for a reviewer decision, so
   it STOPS once an action has been taken against the line item — a decided row's
   age is frozen at the decision, never counted forward to "now" (otherwise an
   Approved/Rejected row keeps climbing for days and falsely reads SLA-breached).

   A still-pending multi-level row can carry a `reviewedAt` (a lower approval level
   already forwarded it) yet is NOT decided — so we key on the terminal STATUS, not
   on reviewedAt being present.
──────────────────────────────────────────────────────────────────────────────── */

// Raw backend statuses where a reviewer action has been taken (clock frozen). Includes
// the list's RE_KYC_REQUIRED display-override (an approved row re-flagged for re-KYC).
const DECIDED_STATUSES = new Set([
  'APPROVED',
  'REJECTED',
  'RESUBMISSION_REQUIRED',
  'RE_KYC_REQUIRED',
]);

export function kycAgeHrs(
  submittedAt: string | null | undefined,
  status: string,
  decision: { reviewedAt?: string | null; approvedAt?: string | null; updatedAt?: string | null } = {},
): number {
  if (!submittedAt) return 0;
  // Freeze at the decision (approvedAt for an approval; reviewedAt for a reject/resubmit;
  // updatedAt = last-write fallback for a decided row missing both). Pending → live to now.
  const decidedAt = DECIDED_STATUSES.has(status)
    ? decision.approvedAt ?? decision.reviewedAt ?? decision.updatedAt ?? null
    : null;
  const endMs = decidedAt ? new Date(decidedAt).getTime() : Date.now();
  return Math.round(Math.max(0, endMs - new Date(submittedAt).getTime()) / (1000 * 60 * 60));
}
