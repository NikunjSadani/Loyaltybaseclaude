/* ─── Report recipients API client ─────────────────────────────────────────────
   The email distribution list for the internal Gifsy Daily Operations Digest (the
   one daily Mon–Sat operator email — an all-tenant summary + one section per tenant).

     READ:  GET  /api/admin/settings/report-recipients
              → { recipients: { dailyDigest: string[] },
                  source: 'saved' | 'legacy' | 'none',
                  allowedDomains: string[],     // e.g. ['gifsy.in']
                  blocked: string[] }           // listed, but NOT sent the digest (domain not allowed)
     WRITE: PUT  /api/admin/settings/report-recipients
              { dailyDigest: string[] }  → same shape as the READ;
              400 (message names the addresses) if any address's domain is not allowed.

   `source`: 'saved' = a digest list was saved (used as-is, even if empty); 'legacy' = nothing
   saved yet, so the list is inherited from the two retired daily emails' lists (Credits/Payouts +
   KYC actionables); 'none' = nothing saved and nothing to inherit.

   Both calls return a discriminated result — a failure is NEVER turned into an empty list, so
   the settings card can show the error and refuse to save over a list it never loaded.

   Both GET and PUT are GIFSY_ADMIN only — enforced on the backend, which validates each
   entry is a real email on an allowed domain and caps the list at 50. Responses ride the
   global { success, data } envelope.
──────────────────────────────────────────────────────────────────────────────── */

import { api } from '@/lib/api-client';

export interface ReportRecipients {
  dailyDigest: string[];
}

export type RecipientsSource = 'saved' | 'legacy' | 'none';

export interface ReportRecipientsState extends ReportRecipients {
  source: RecipientsSource;
  allowedDomains: string[];
  blocked: string[];
}

export type ReportRecipientsResult =
  | { ok: true; data: ReportRecipientsState }
  | { ok: false; error: string };

export const DEFAULT_ALLOWED_DOMAINS = ['gifsy.in'];

interface RawRecipientsResponse {
  recipients?: Partial<ReportRecipients>;
  source?: unknown;
  allowedDomains?: unknown;
  blocked?: unknown;
}

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;

/** Normalise the envelope payload; null when the required list is missing/malformed. */
function parseState(raw: RawRecipientsResponse | undefined | null): ReportRecipientsState | null {
  const list = stringList(raw?.recipients?.dailyDigest);
  if (!list) return null;
  const source: RecipientsSource =
    raw?.source === 'saved' || raw?.source === 'legacy' || raw?.source === 'none' ? raw.source : 'none';
  const domains = stringList(raw?.allowedDomains)?.map((d) => d.trim().toLowerCase()).filter(Boolean);
  return {
    dailyDigest: list,
    source,
    allowedDomains: domains && domains.length > 0 ? domains : DEFAULT_ALLOWED_DOMAINS,
    blocked: stringList(raw?.blocked) ?? [],
  };
}

const errorText = (e: unknown, fallback: string): string =>
  typeof e === 'string' && e.trim() !== '' ? e : fallback;

/** The digest distribution list + where it came from + the domain rule. */
export async function fetchReportRecipients(): Promise<ReportRecipientsResult> {
  const res = await api.get<RawRecipientsResponse>('/api/admin/settings/report-recipients');
  if (!res.success) return { ok: false, error: errorText(res.error, 'the server returned an error') };
  const data = parseState(res.data);
  if (!data) return { ok: false, error: 'the server returned an unexpected response' };
  return { ok: true, data };
}

/**
 * Replace the digest distribution list. PUT /api/admin/settings/report-recipients —
 * GIFSY_ADMIN only. On failure the backend's message (e.g. the 400 naming non-allowed
 * addresses) is surfaced as `error`.
 */
export async function saveReportRecipients(r: ReportRecipients): Promise<ReportRecipientsResult> {
  const res = await api.put<RawRecipientsResponse>('/api/admin/settings/report-recipients', {
    dailyDigest: r.dailyDigest,
  });
  if (!res.success) return { ok: false, error: errorText(res.error, 'the server returned an error') };
  // A bodyless success still means the list was saved as sent.
  const data = parseState(res.data) ?? {
    dailyDigest: r.dailyDigest,
    source: 'saved' as const,
    allowedDomains: DEFAULT_ALLOWED_DOMAINS,
    blocked: [],
  };
  return { ok: true, data };
}

/** The part after the last '@', lowercased ('' when there is no '@'). */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}
