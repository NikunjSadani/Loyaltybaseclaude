import { BadRequestException } from '@nestjs/common';

/**
 * Per-client "Ticket remarks email" (owner-approved 2026-11-20, TENANT-SCOPED).
 *
 * When a client has this address set, Gifsy's "Ask client admin for remarks" email goes ONLY to it
 * (the client's shared ticket-remarks inbox) — not to the chosen admin's personal email. The chosen
 * admin still gets the in-app bell and still replies in the portal; the email names them. Unset →
 * exactly the previous behaviour (the chosen admin's own email).
 *
 * Storage: one ProgramSetting row per tenant, key TICKET_REMARKS_EMAIL_KEY, value `{ email }`.
 * Written ONLY via the GIFSY_ADMIN-only Gifsy-console endpoint (the generic settings PUT refuses
 * the key); every change is audit-logged (entityType TICKET_REMARKS_EMAIL_AUDIT, entityId = slug).
 */
export const TICKET_REMARKS_EMAIL_KEY = 'ticketRemarksEmail';
export const TICKET_REMARKS_EMAIL_AUDIT = 'TICKET_REMARKS_EMAIL';

const MAX_LEN = 254;
// One address, printable-ASCII only: local part = letters, digits and . _ % + ' -; domain = labels of
// letters, digits and '-' separated by dots, ending in a 2+ letter TLD. Refuses spaces, lists (, ;),
// quotes, backslashes, colons, angle brackets, control chars (\p{Cc}) and invisible format chars
// (\p{Cf}, e.g. U+200B zero-width space) — anything that could hide a second/different address.
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/u;

/** The stored address, or null when unset / unreadable. */
export function readTicketRemarksEmail(settingValue: unknown): string | null {
  const v = settingValue && typeof settingValue === 'object' && !Array.isArray(settingValue)
    ? (settingValue as Record<string, unknown>).email
    : undefined;
  if (typeof v !== 'string') return null;
  const email = v.trim().toLowerCase();
  return email && EMAIL_RE.test(email) ? email : null;
}

/**
 * Validates the console input: trimmed; '' / null / undefined → unset (null); otherwise exactly ONE
 * valid address (≤ 254 chars), lowercased. Anything else → 400 with a clear message.
 */
export function parseTicketRemarksEmailInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new BadRequestException('Ticket remarks email must be text.');
  // trim() strips ASCII/Unicode whitespace but NOT zero-width chars — those are refused below.
  const email = input.trim().toLowerCase();
  if (!email) return null;
  if (INVISIBLE_RE.test(input)) {
    throw new BadRequestException('The email address contains invisible or control characters — retype it.');
  }
  if (/[,;\s]/.test(email)) {
    throw new BadRequestException('Enter ONE email address — a list of addresses is not allowed.');
  }
  if (email.length > MAX_LEN || !EMAIL_RE.test(email)) {
    throw new BadRequestException(`"${input.trim()}" is not a valid email address.`);
  }
  return email;
}
