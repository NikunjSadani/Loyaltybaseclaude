/* ─── National holiday calendar API client ─────────────────────────────────────
   The PLATFORM-global holiday calendar the KYC business-hours SLA clock pauses on.

     READ:  GET  /api/admin/settings/holidays  → { holidays: [{ date, label }] }
     WRITE: PUT  /api/admin/settings/holidays  { holidays: [{ date, label }] }

   GET is permitted for GIFSY_ADMIN + CLIENT_ADMIN (a tenant admin's KYC list needs it to
   age rows correctly). WRITE is GIFSY_ADMIN only (platform-level operator config) — enforced
   on the backend. Responses ride the global { success, data } envelope.
──────────────────────────────────────────────────────────────────────────────── */

import { api } from '@/lib/api-client';
import { parseHolidayDates } from '@/lib/business-hours';

export interface Holiday {
  date: string; // YYYY-MM-DD
  label: string;
}

/**
 * The platform national holiday calendar (stored override, else the gazetted-national code
 * default). Returns [] on failure so a read error never breaks a screen.
 */
export async function fetchHolidays(): Promise<Holiday[]> {
  const res = await api.get<{ holidays?: Holiday[] }>('/api/admin/settings/holidays');
  return res.success && Array.isArray(res.data?.holidays) ? res.data!.holidays : [];
}

/**
 * The holiday DATE set for the SLA clock — the same list reduced to a Set of `YYYY-MM-DD`.
 * Returns an empty set on failure (the clock still excludes weekends).
 */
export async function fetchHolidayDateSet(): Promise<Set<string>> {
  return parseHolidayDates(await fetchHolidays());
}

/**
 * Replace the platform national holiday calendar. PUT /api/admin/settings/holidays —
 * GIFSY_ADMIN only (the backend returns 403 otherwise). Returns true on success.
 */
export async function saveHolidays(holidays: Holiday[]): Promise<boolean> {
  const res = await api.put('/api/admin/settings/holidays', { holidays });
  return res.success;
}
