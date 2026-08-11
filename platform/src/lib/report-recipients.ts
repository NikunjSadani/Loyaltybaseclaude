/* ─── Report recipients API client ─────────────────────────────────────────────
   The per-report email distribution lists for the scheduled internal reports (the
   daily Mon–Sat operator digests).

     READ:  GET  /api/admin/settings/report-recipients
              → { recipients: { creditsPayouts: string[], kycActionables: string[] } }
     WRITE: PUT  /api/admin/settings/report-recipients
              { creditsPayouts: string[], kycActionables: string[] }

   GET is permitted for GIFSY_ADMIN + CLIENT_ADMIN (a tenant admin may view who receives
   the digests). WRITE is GIFSY_ADMIN only (a Gifsy-operated setting) — enforced on the
   backend, which validates each entry is a real email and caps each list at 50.
   Responses ride the global { success, data } envelope.
──────────────────────────────────────────────────────────────────────────────── */

import { api } from '@/lib/api-client';

export interface ReportRecipients {
  creditsPayouts: string[];
  kycActionables: string[];
}

/**
 * The report-recipient distribution lists. Returns empty lists on failure so a read
 * error never breaks the settings screen.
 */
export async function fetchReportRecipients(): Promise<ReportRecipients> {
  const res = await api.get<{ recipients?: Partial<ReportRecipients> }>(
    '/api/admin/settings/report-recipients',
  );
  const r = res.success ? res.data?.recipients : undefined;
  return {
    creditsPayouts: Array.isArray(r?.creditsPayouts) ? r!.creditsPayouts : [],
    kycActionables: Array.isArray(r?.kycActionables) ? r!.kycActionables : [],
  };
}

/**
 * Replace the report-recipient lists. PUT /api/admin/settings/report-recipients —
 * GIFSY_ADMIN only (the backend returns 403 otherwise). Returns true on success.
 */
export async function saveReportRecipients(r: ReportRecipients): Promise<boolean> {
  const res = await api.put('/api/admin/settings/report-recipients', {
    creditsPayouts: r.creditsPayouts,
    kycActionables: r.kycActionables,
  });
  return res.success;
}
