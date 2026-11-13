/* ─── Report recipients API client ─────────────────────────────────────────────
   The email distribution list for the internal Gifsy Daily Operations Digest (the
   one daily Mon–Sat operator email — an all-tenant summary + one section per tenant).

     READ:  GET  /api/admin/settings/report-recipients
              → { recipients: { dailyDigest: string[] } }
     WRITE: PUT  /api/admin/settings/report-recipients
              { dailyDigest: string[] }

   The READ returns the EFFECTIVE list: if no digest list was ever saved, the backend
   returns the union of the two retired per-report lists (Credits/Payouts + KYC
   actionables), so the people who got those emails keep getting the digest. Saving
   stores the digest list (from then on it is used as-is, even if empty).

   Both GET and PUT are GIFSY_ADMIN only — enforced on the backend, which validates
   each entry is a real email and caps the list at 50. Responses ride the global
   { success, data } envelope.
──────────────────────────────────────────────────────────────────────────────── */

import { api } from '@/lib/api-client';

export interface ReportRecipients {
  dailyDigest: string[];
}

/**
 * The digest distribution list. Returns an empty list on failure so a read error
 * never breaks the settings screen.
 */
export async function fetchReportRecipients(): Promise<ReportRecipients> {
  const res = await api.get<{ recipients?: Partial<ReportRecipients> }>(
    '/api/admin/settings/report-recipients',
  );
  const r = res.success ? res.data?.recipients : undefined;
  return { dailyDigest: Array.isArray(r?.dailyDigest) ? r!.dailyDigest : [] };
}

/**
 * Replace the digest distribution list. PUT /api/admin/settings/report-recipients —
 * GIFSY_ADMIN only (the backend returns 403 otherwise). Returns true on success.
 */
export async function saveReportRecipients(r: ReportRecipients): Promise<boolean> {
  const res = await api.put('/api/admin/settings/report-recipients', { dailyDigest: r.dailyDigest });
  return res.success;
}
