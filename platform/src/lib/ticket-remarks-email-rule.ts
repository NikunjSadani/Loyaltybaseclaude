/**
 * The Gifsy console's pre-check for one "Ticket remarks email" address — an EXACT copy of the API rule
 * in api/src/tickets/ticket-remarks-inbox.ts (EMAIL_RE / INVISIBLE_RE / MAX_LEN), so an address the
 * console accepts is never refused by the server and vice versa. Pinned by
 * src/lib/__tests__/ticket-remarks-email-rule.test.ts, which reads the API source: change both together.
 */
export const MAX_TO = 5;
export const MAX_CC = 10;

export const MAX_LEN = 254;
export const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
export const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/u;

/**
 * Validates one entry (already split on , ; whitespace). Returns the normalised address, or an error
 * message worded like the server's.
 */
export function checkRemarksEmail(raw: string): { email: string } | { error: string } {
  if (INVISIBLE_RE.test(raw)) return { error: `"${raw.trim()}" contains invisible or control characters — retype it.` };
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_LEN || !EMAIL_RE.test(email)) return { error: `"${raw.trim()}" is not a valid email address.` };
  return { email };
}
