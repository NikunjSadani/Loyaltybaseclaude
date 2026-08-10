/**
 * The platform-global national holiday calendar — the single source of truth for which
 * dates the KYC business-hours SLA clock PAUSES on. Shared by every SLA engine (admin-core
 * kycDashboard + kyc.service slaMetrics) so the seeded defaults and the read logic can never
 * drift between them.
 *
 * Storage: ONE programSetting row under the operator client (HOLIDAY_CLIENT_ID), key
 * NATIONAL_HOLIDAYS_KEY, value = Holiday[]. Platform-level, not per-tenant: one national list
 * for all tenants. GIFSY_ADMIN edits it from the admin settings page; CLIENT_ADMIN reads it.
 *
 * DEFAULT_NATIONAL_HOLIDAYS seeds it in code (like SETTINGS_DEFAULTS) so prod shows the gazetted
 * national holidays with no DB seed; a saved override fully replaces the default.
 */

import type { PrismaService } from '../prisma/prisma.service';
import { isValidIsoDate } from './business-hours';

/** The platform holiday calendar lives on the operator client's settings row. */
export const HOLIDAY_CLIENT_ID = 'gifsy';
export const NATIONAL_HOLIDAYS_KEY = 'nationalHolidays';

export interface Holiday {
  date: string;
  label: string;
}

/**
 * Gazetted national holidays seeded in code — only the three constitutionally-national
 * holidays (certain, fixed dates). Movable festival/regional holidays are the owner's to add
 * via the settings UI (we do not guess movable dates). Year-specific; the owner curates annually.
 */
export const DEFAULT_NATIONAL_HOLIDAYS: Holiday[] = [
  { date: '2026-01-26', label: 'Republic Day' },
  { date: '2026-08-15', label: 'Independence Day' },
  { date: '2026-10-02', label: 'Gandhi Jayanti' },
];

/**
 * Normalize a stored settingValue into a clean, de-duped (by date), date-sorted Holiday[].
 * Anything that is not a real calendar date is dropped; a non-array (absent/blank row) yields
 * the code default. A blank/missing label falls back to the date string.
 */
export function normalizeHolidays(raw: unknown): Holiday[] {
  if (!Array.isArray(raw)) return [...DEFAULT_NATIONAL_HOLIDAYS];
  const byDate = new Map<string, string>();
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const date = (item as { date?: unknown }).date;
      const label = (item as { label?: unknown }).label;
      if (typeof date === 'string' && isValidIsoDate(date)) {
        byDate.set(date, typeof label === 'string' && label.trim() ? label.trim() : date);
      }
    }
  }
  return [...byDate.entries()]
    .map(([date, label]) => ({ date, label }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The holiday DATE set the SLA clock pauses on. Reads the single platform row and falls back
 * to the code default. Fully defensive — a read failure yields the default set, never throws
 * into a metric.
 */
export async function loadHolidaySet(prisma: PrismaService): Promise<Set<string>> {
  let raw: unknown;
  try {
    const row = await prisma.programSetting.findFirst({
      where: { clientId: HOLIDAY_CLIENT_ID, settingKey: NATIONAL_HOLIDAYS_KEY },
      select: { settingValue: true },
    });
    raw = row?.settingValue;
  } catch {
    raw = undefined; // read failure → defaults (never let it break the metric)
  }
  // Derive the date set from the SAME normalizer the settings UI (getNationalHolidays) uses,
  // so the SLA clock and the displayed calendar can never disagree — even on a corrupt
  // (non-array) stored value, where both now fall back to the gazetted defaults.
  return new Set(normalizeHolidays(raw).map((h) => h.date));
}
