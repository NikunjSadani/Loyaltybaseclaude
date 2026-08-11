/**
 * The platform-global "report recipients" store — the single source of truth for which email
 * addresses receive each Gifsy-configured scheduled report. Shared by the settings UI (admin-core
 * getReportRecipients/setReportRecipients) and the scheduled-report runner so the configured list
 * and the send logic can never drift.
 *
 * Storage: ONE programSetting row under the operator client (REPORTS_CLIENT_ID), key
 * REPORT_RECIPIENTS_KEY, value = ReportRecipients. Platform-level, not per-tenant: one recipient
 * map for all reports. GIFSY_ADMIN edits it from the admin settings page; CLIENT_ADMIN reads it.
 *
 * There is no code default — an unset row means "no recipients yet" (each key defaults to []).
 */

import type { PrismaService } from '../prisma/prisma.service';

/** The platform report-recipients store lives on the operator client's settings row. */
export const REPORTS_CLIENT_ID = 'gifsy';
export const REPORT_RECIPIENTS_KEY = 'reportRecipients';

/** Stable report keys — identical to report.types.ts ReportKey (the reports the runner sends). */
export type ReportKey = 'creditsPayouts' | 'kycActionables';

/** Per-report recipient lists. Each key holds a de-duped list of lowercased email addresses. */
export interface ReportRecipients {
  creditsPayouts: string[];
  kycActionables: string[];
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
 * Normalize a stored settingValue into a clean ReportRecipients. Tolerant: accepts an object with
 * the two array keys; keeps only valid, lowercased, de-duped email strings; defaults each key to
 * `[]`. A non-object (absent/blank row) yields two empty lists.
 */
export function normalizeReportRecipients(raw: unknown): ReportRecipients {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    creditsPayouts: cleanEmails(obj.creditsPayouts),
    kycActionables: cleanEmails(obj.kycActionables),
  };
}

/**
 * The per-report recipient lists. Reads the single platform row and falls back to empty lists.
 * Fully defensive — a read failure yields empty lists, never throws into the report runner.
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
    raw = undefined; // read failure → empty lists (never let it break the runner)
  }
  return normalizeReportRecipients(raw);
}
