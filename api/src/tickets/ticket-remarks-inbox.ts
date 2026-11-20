import { BadRequestException } from '@nestjs/common';

/**
 * Per-client "Ticket remarks email" (owner-approved 2026-11-20, TENANT-SCOPED; extended to To + CC
 * lists 2026-11-21, platform-wide approved — blank = the previous behaviour exactly).
 *
 * Recipients of Gifsy's "Ask client admin for remarks" email:
 *   - To list set   → one email To all of them, Cc the CC list (the chosen admin is named in the body,
 *                     still gets the in-app bell and replies in the portal — NOT emailed unless listed).
 *   - To blank, CC set → To the chosen admin's own email (the previous behaviour), Cc the CC list.
 *   - Both blank    → exactly the previous behaviour (the chosen admin's own email, no Cc).
 *
 * Storage: one ProgramSetting row per tenant, key TICKET_REMARKS_EMAIL_KEY, value
 * `{ to: string[], cc: string[], email?: to[0] }`. `email` is written only when To is non-empty, so a
 * rolled-back reader (which only knows `{ email }`) still sends to the first To address and never
 * mistakes a CC-only config for an inbox. A legacy `{ email }` row reads as To = [email], CC = [].
 * Written ONLY via the GIFSY_ADMIN-only Gifsy-console endpoint (the generic settings PUT refuses the
 * key); every change is audit-logged (entityType TICKET_REMARKS_EMAIL_AUDIT, entityId = slug).
 */
export const TICKET_REMARKS_EMAIL_KEY = 'ticketRemarksEmail';
export const TICKET_REMARKS_EMAIL_AUDIT = 'TICKET_REMARKS_EMAIL';

export const MAX_TO = 5;
export const MAX_CC = 10;

const MAX_LEN = 254;
// One address, printable-ASCII only: local part = letters, digits and . _ % + ' -; domain = labels of
// letters, digits and '-' separated by dots, ending in a 2+ letter TLD. Refuses spaces, lists (, ;),
// quotes, backslashes, colons, angle brackets, control chars (\p{Cc}) and invisible format chars
// (\p{Cf}, e.g. U+200B zero-width space) — anything that could hide a second/different address.
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/u;

export interface TicketRemarksRecipients {
  to: string[];
  cc: string[];
}

function cleanStored(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const email = v.trim().toLowerCase();
  return email && EMAIL_RE.test(email) ? email : null;
}

function cleanStoredList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const e = cleanStored(raw);
    if (e && !out.includes(e) && out.length < max) out.push(e);
  }
  return out;
}

/**
 * The stored To + CC lists (both [] when unset / unreadable). Reads the new `{ to, cc }` shape and the
 * legacy single-address `{ email }` shape (→ To = [email]). Invalid stored entries are dropped; an
 * address in both lists stays only in To.
 */
export function readTicketRemarksRecipients(settingValue: unknown): TicketRemarksRecipients {
  const obj = settingValue && typeof settingValue === 'object' && !Array.isArray(settingValue)
    ? (settingValue as Record<string, unknown>)
    : null;
  if (!obj) return { to: [], cc: [] };
  const hasLists = Array.isArray(obj.to) || Array.isArray(obj.cc);
  const to = hasLists ? cleanStoredList(obj.to, MAX_TO) : (() => { const e = cleanStored(obj.email); return e ? [e] : []; })();
  const cc = hasLists ? cleanStoredList(obj.cc, MAX_CC).filter((e) => !to.includes(e)) : [];
  return { to, cc };
}

/** The first stored To address, or null when unset / unreadable (kept for single-address callers). */
export function readTicketRemarksEmail(settingValue: unknown): string | null {
  return readTicketRemarksRecipients(settingValue).to[0] ?? null;
}

/** The ProgramSetting value to store (see the header: `email` only when To is non-empty). */
export function ticketRemarksSettingValue(r: TicketRemarksRecipients): { to: string[]; cc: string[]; email?: string } {
  return { to: r.to, cc: r.cc, ...(r.to[0] ? { email: r.to[0] } : {}) };
}

/**
 * Validates ONE console address: trimmed; '' / null / undefined → null (blank); otherwise exactly ONE
 * valid address (≤ 254 chars), lowercased. Anything else → 400 with a clear message (prefixed with
 * `label`, e.g. 'CC address 2', when given).
 */
export function parseTicketRemarksEmailInput(input: unknown, label?: string): string | null {
  const p = label ? `${label}: ` : '';
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new BadRequestException(`${p}Ticket remarks email must be text.`);
  // trim() strips ASCII/Unicode whitespace but NOT zero-width chars — those are refused below.
  const email = input.trim().toLowerCase();
  if (!email) return null;
  if (INVISIBLE_RE.test(input)) {
    throw new BadRequestException(`${p}The email address contains invisible or control characters — retype it.`);
  }
  if (/[,;\s]/.test(email)) {
    throw new BadRequestException(`${p}Enter ONE email address per entry — "${input.trim()}" looks like a list.`);
  }
  if (email.length > MAX_LEN || !EMAIL_RE.test(email)) {
    throw new BadRequestException(`${p}"${input.trim()}" is not a valid email address.`);
  }
  return email;
}

function parseList(input: unknown, name: 'To' | 'CC', max: number): string[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new BadRequestException(`The ${name} list must be a list of email addresses.`);
  const out: string[] = [];
  input.forEach((raw, i) => {
    const e = parseTicketRemarksEmailInput(raw, `${name} address ${i + 1}`);
    if (e && !out.includes(e)) out.push(e); // blanks skipped, duplicates collapsed
  });
  if (out.length > max) {
    throw new BadRequestException(`At most ${max} ${name} addresses are allowed (got ${out.length}).`);
  }
  return out;
}

/**
 * Validates the console body `{ to?, cc?, email? }` into the lists to store.
 *   - `to` / `cc`: arrays of addresses — trimmed, lowercased, deduped; blanks ignored; To ≤ 5, CC ≤ 10.
 *   - A key that is ABSENT (undefined) leaves that stored list unchanged (`{ to }` alone never wipes CC,
 *     `{ cc }` alone never wipes To); `[]` / null clears it.
 *   - An address in BOTH lists (after merging with the unchanged one) → 400 naming it.
 *   - Legacy `{ email }` (no `to` / `cc` keys) → To = [email] (or [] when blank), CC = current CC
 *     unchanged (minus the new To) — an old single-address client never silently wipes the CC list.
 */
export function parseTicketRemarksRecipientsInput(
  body: { to?: unknown; cc?: unknown; email?: unknown },
  current: TicketRemarksRecipients = { to: [], cc: [] },
): TicketRemarksRecipients {
  const usesLists = body.to !== undefined || body.cc !== undefined;
  let to: string[];
  let cc: string[];
  if (usesLists) {
    if (body.email !== undefined && body.email !== null && body.email !== '') {
      throw new BadRequestException('Send either `email` (legacy) or `to` / `cc` lists, not both.');
    }
    to = body.to === undefined ? [...current.to] : parseList(body.to, 'To', MAX_TO);
    cc = body.cc === undefined ? [...current.cc] : parseList(body.cc, 'CC', MAX_CC);
  } else {
    const e = parseTicketRemarksEmailInput(body.email);
    to = e ? [e] : [];
    cc = current.cc.filter((x) => !to.includes(x));
  }
  const both = to.filter((e) => cc.includes(e));
  if (both.length) {
    throw new BadRequestException(`${both.join(', ')} cannot be in both To and CC — keep it in one list.`);
  }
  return { to, cc };
}
