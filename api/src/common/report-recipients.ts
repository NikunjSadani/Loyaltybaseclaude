/**
 * The platform-global "report recipients" store — the single source of truth for who receives the
 * internal Gifsy Daily Operations Digest. Shared by the settings UI (admin-core
 * getReportRecipients/setReportRecipients) and the scheduled-report runner so the configured list
 * and the send logic can never drift.
 *
 * Storage: ONE programSetting row under the operator client (REPORTS_CLIENT_ID), key
 * REPORT_RECIPIENTS_KEY, value = `{ dailyDigest: string[] }`. Platform-level, not per-tenant.
 * GIFSY_ADMIN edits it; CLIENT_ADMIN can read it.
 *
 * LEGACY FALLBACK (owner-approved 2026-11-13): before the digest there were two emails with their
 * own lists (`creditsPayouts`, `kycActionables`). If the stored row has NO `dailyDigest` key, the
 * digest goes to the UNION of those two legacy lists — so whoever got today's emails keeps getting
 * the digest without anyone re-entering addresses. Once a `dailyDigest` list is saved (even an
 * empty one — an explicit "nobody") it is used as-is and the legacy keys are ignored.
 *
 * There is no code default — an unset row means "no recipients yet".
 */

import type { PrismaService } from '../prisma/prisma.service';

/** The platform report-recipients store lives on the operator client's settings row. */
export const REPORTS_CLIENT_ID = 'gifsy';
export const REPORT_RECIPIENTS_KEY = 'reportRecipients';

/** Stable report key — identical to report.types.ts ReportKey. */
export type ReportKey = 'dailyDigest';

/** The digest recipient list: de-duped, lowercased, valid email addresses. */
export interface ReportRecipients {
  dailyDigest: string[];
}

/** A simple, tolerant email shape check — enough to drop obvious junk before storing. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pull the valid, lowercased, de-duped emails out of an arbitrary value into a clean list. */
function cleanEmails(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const email = item.trim().toLowerCase();
    if (EMAIL_RE.test(email)) seen.add(email);
  }
  return [...seen];
}

/**
 * Normalize a stored settingValue into the effective ReportRecipients. `dailyDigest` present (an
 * array) → that list, cleaned. Absent → the union of the legacy `creditsPayouts` + `kycActionables`
 * lists (cleaned, de-duped, creditsPayouts order first). A non-object (absent/blank row) → [].
 */
export function normalizeReportRecipients(raw: unknown): ReportRecipients {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (Array.isArray(obj.dailyDigest)) return { dailyDigest: cleanEmails(obj.dailyDigest) };
  const legacy = [...cleanEmails(obj.creditsPayouts), ...cleanEmails(obj.kycActionables)];
  return { dailyDigest: [...new Set(legacy)] };
}

/**
 * The effective digest recipients. Reads the single platform row (with the legacy fallback).
 * Fully defensive — a read failure yields an empty list, never throws into the report runner.
 */
export async function loadReportRecipients(prisma: PrismaService): Promise<ReportRecipients> {
  let raw: unknown;
  try {
    const row = await prisma.programSetting.findFirst({
      where: { clientId: REPORTS_CLIENT_ID, settingKey: REPORT_RECIPIENTS_KEY },
      select: { settingValue: true },
    });
    raw = row?.settingValue;
  } catch {
    raw = undefined; // read failure → empty list (never let it break the runner)
  }
  return normalizeReportRecipients(raw);
}
