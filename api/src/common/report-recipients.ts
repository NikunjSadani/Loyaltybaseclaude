/**
 * The platform-global "report recipients" store — the single source of truth for who receives the
 * internal Gifsy Daily Operations Digest. Shared by the settings UI (admin-core
 * getReportRecipients/setReportRecipients) and the scheduled-report runner so the configured list
 * and the send logic can never drift.
 *
 * Storage: ONE programSetting row under the operator client (REPORTS_CLIENT_ID), key
 * REPORT_RECIPIENTS_KEY, value = `{ dailyDigest: string[] }`. Platform-level, not per-tenant.
 * Only a Gifsy operator (GIFSY_ADMIN / permitted GIFSY_STAFF) can read or change it — both the GET
 * and the PUT are Gifsy-only; tenant admins can neither see nor set it.
 *
 * LEGACY FALLBACK (owner-approved 2026-11-13): before the digest there were two emails with their
 * own lists (`creditsPayouts`, `kycActionables`). If the stored row has NO `dailyDigest` key, the
 * digest goes to the UNION of those two legacy lists — so whoever got today's emails keeps getting
 * the digest without anyone re-entering addresses. Once a `dailyDigest` list is saved (even an
 * empty one — an explicit "nobody") it is used as-is and the legacy keys are ignored.
 *
 * INTERNAL-ONLY RULE: the digest summarises every tenant, so it may only go to internal addresses.
 * The allowed domains come from REPORTS_RECIPIENT_DOMAINS (comma-separated, default `gifsy.in`;
 * exact match on the part after '@' — a sub-domain must be listed itself). Enforced on SAVE (the
 * PUT refuses a non-allowed address) and again at SEND (a non-allowed address — e.g. one inherited
 * from a legacy list — is dropped and named in the email footer + the logs).
 *
 * There is no code default — an unset row means "no recipients yet".
 */

import type { PrismaService } from '../prisma/prisma.service';

/** The platform report-recipients store lives on the operator client's settings row. */
export const REPORTS_CLIENT_ID = 'gifsy';
export const REPORT_RECIPIENTS_KEY = 'reportRecipients';
/** Allowed recipient domains when REPORTS_RECIPIENT_DOMAINS is unset/blank. */
export const DEFAULT_RECIPIENT_DOMAINS = ['gifsy.in'];

/** Stable report key — identical to report.types.ts ReportKey. */
export type ReportKey = 'dailyDigest';

/** The digest recipient list: de-duped, lowercased, valid email addresses. */
export interface ReportRecipients {
  dailyDigest: string[];
}

/** Where the effective list came from: a saved digest list, the legacy-lists union, or no row/keys at all. */
export type RecipientsSource = 'saved' | 'legacy' | 'none';

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
 * Normalize a stored settingValue into the effective list + where it came from. `dailyDigest`
 * present (an array) → that list, cleaned ('saved'). Absent → the union of the legacy
 * `creditsPayouts` + `kycActionables` lists (cleaned, de-duped, creditsPayouts order first) —
 * 'legacy' when either legacy key exists, else 'none'.
 */
export function resolveReportRecipients(raw: unknown): ReportRecipients & { source: RecipientsSource } {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (Array.isArray(obj.dailyDigest)) return { dailyDigest: cleanEmails(obj.dailyDigest), source: 'saved' };
  const hasLegacy = 'creditsPayouts' in obj || 'kycActionables' in obj;
  const legacy = [...cleanEmails(obj.creditsPayouts), ...cleanEmails(obj.kycActionables)];
  return { dailyDigest: [...new Set(legacy)], source: hasLegacy ? 'legacy' : 'none' };
}

/** Back-compat shape-only normalizer (no source). */
export function normalizeReportRecipients(raw: unknown): ReportRecipients {
  return { dailyDigest: resolveReportRecipients(raw).dailyDigest };
}

/** The allowed recipient domains (lowercase, no '@'), from REPORTS_RECIPIENT_DOMAINS or the default. */
export function allowedRecipientDomains(env: string | undefined = process.env.REPORTS_RECIPIENT_DOMAINS): string[] {
  const list = (env ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@+/, ''))
    .filter((d) => d.length > 0);
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_RECIPIENT_DOMAINS];
}

/** Exact-domain check on the part after the last '@'. */
export function isAllowedRecipient(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return domains.includes(email.slice(at + 1).trim().toLowerCase());
}

/** Split a list into the allowed addresses and the blocked (non-internal) ones, order kept. */
export function splitRecipientsByDomain(emails: string[], domains: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const e of emails) (isAllowedRecipient(e, domains) ? allowed : blocked).push(e);
  return { allowed, blocked };
}

/**
 * The effective digest recipients for the RUNNER. Reads the single platform row (with the legacy
 * fallback). A read failure THROWS — the runner must report it as a failed run, never mistake a DB
 * error for "no recipients".
 */
export async function loadReportRecipients(prisma: PrismaService): Promise<ReportRecipients & { source: RecipientsSource }> {
  const row = await prisma.programSetting.findFirst({
    where: { clientId: REPORTS_CLIENT_ID, settingKey: REPORT_RECIPIENTS_KEY },
    select: { settingValue: true },
  });
  return resolveReportRecipients(row?.settingValue);
}
