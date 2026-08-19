/**
 * RBAC Option-X — Reserved permission set (Owner-only sensitive).
 *
 * These are the money-execution, tenancy, and role-management keys that a
 * self-service Gifsy role editor must GREY OUT by default and only allow to be
 * granted through an explicit warning acknowledgement (Flavour B, design doc
 * "Reserved set"). The constant is the single source of truth shared by:
 *   - the P1 role-editor CRUD backend (reject a reserved grant unless the
 *     request carries the explicit `allowReserved: true` override — "Lock 1"),
 *   - the P3 frontend editor (grey + warn-to-grant, which sets that override),
 *   - and the surfacing API (GET /v1/gifsy/permissions marks these `reserved`).
 *
 * ENFORCEMENT (owner-locked 2026-08-18 — LOCK 1 ONLY): being reserved gates the
 * GRANT (conscious override required), NOT the use. Once the owner knowingly
 * grants a reserved key to a custom role, a GIFSY_STAFF holding that role can
 * fully USE it — the earlier route-level owner-only hard-block ("Lock 2") was
 * DROPPED (a delegated power must actually work). Safety then rests on the
 * conscious-override grant gate + GIFSY_STAFF permission enforcement, which P2
 * makes ALWAYS-ON / fail-closed and independent of the per-tenant enforcement
 * flag (in P1 the guard is still flag-gated and DORMANT — but no route admits a
 * GIFSY_STAFF yet, so nothing is exposed; see RBAC-OPTION-X-STAFF.md P2).
 * Read-only finance (credits:read,
 * payouts:read/view_tds, invoices:read) is deliberately NOT reserved — the
 * Project Manager seed role holds it.
 *
 * Pure, zero-I/O module. Keep in sync with the design doc's Reserved set.
 */

import type { Permission } from './permissions';

export const RESERVED_PERMISSIONS: Permission[] = [
  // Wallet — direct points manipulation / expiry policy.
  'wallet:adjust',
  'wallet:manage_expiry',
  // Awards & Credits (Finance — push): the whole money-execution path except read.
  'credits:upload',
  'credits:confirm_payout',
  'credits:download_bank_file',
  'credits:mark_paid',
  'credits:request_reversal',
  'credits:approve_reversal',
  'credits:manage_fields',
  // Redemption Payouts & Fund (Finance — pull): fund + batch execution.
  'payouts:manage_fund',
  'payouts:process_batch',
  'payouts:reconcile',
  // Invoicing — generation / upload (read is not reserved).
  'invoices:manage',
  'invoices:upload',
  // Tenancy & platform configuration.
  'tenancy:read',
  'tenancy:write',
  // Tenant financial config (conversion rate, points expiry, caps/floors) — split
  // out of tenancy:write (D-B2) so it is separately, consciously grantable.
  'tenancy:write_finance',
  'tenancy:manage_flags',
  // Role management + destructive user lifecycle (staff/role admin surface). users:delete is
  // reserved alongside users:manage_roles: deactivating/soft-deleting operator users is a
  // sensitive lifecycle power that must require the conscious allowReserved override to grant
  // (P2 red-team Finding 1 — it is GIFSY-operated + not in any seed role, so it is otherwise
  // lightly delegable without intent).
  'users:manage_roles',
  'users:delete',
];

const _RESERVED_SET = new Set<string>(RESERVED_PERMISSIONS);

/**
 * True iff `p` is an Owner-only reserved permission.
 * Accepts any string (so it can validate untrusted keys straight from the DB /
 * an editor payload) — a non-reserved or unknown key returns false.
 */
export function isReserved(p: string): boolean {
  return _RESERVED_SET.has(p);
}
