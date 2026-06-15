/**
 * Task 1.6b-1 — requirePermission helper
 *
 * Server-only: imports the DB-backed config loader (Prisma / Node APIs).
 * Do NOT import this in Edge-runtime code.
 *
 * Return value contract:
 *   null          → caller is ALLOWED to proceed (happy path; most requests).
 *   NextResponse  → caller MUST return this response immediately (denied).
 *
 * Two-level flag (the common OFF case costs nothing — no DB read):
 *   Level 1 — process.env.RBAC_ENFORCEMENT === 'true'   (global master switch)
 *              Default (unset) = OFF. When OFF the function is a complete no-op.
 *   Level 2 — ClientConfig.features.rbacEnforcement     (per-tenant opt-in)
 *              Only consulted when the master switch is ON.
 * Enforcement applies only when BOTH levels are active.
 *
 * Fail-open policy:
 *   If the DB returns no config for the tenant (unknown clientId or DB down),
 *   we treat the tenant as not enforcing and return null. The existing inline
 *   role checks in each route still gate access — RBAC enforcement is an
 *   additive layer that requires an explicit tenant opt-in row.
 *
 * Per-tenant permission OVERRIDES are a future feature (1.6b follow-up).
 * For now can() is called without overrides; the comment below marks where
 * that parameter will be wired in.
 */

// Prevents this module from being bundled into client or Edge code.
import 'server-only';

import { NextResponse } from 'next/server';
import { can } from '@/lib/rbac/can';
import { getClientConfigFromDb } from '@/lib/platform/client-config-db';
import type { Permission } from '@/lib/rbac/permissions';

// ─── Response shape helpers (same ok/err pattern as the admin routes) ─────────

const err = (message: string, status: number) =>
  NextResponse.json({ success: false, error: message }, { status });

// ─────────────────────────────────────────────────────────────────────────────
// requirePermission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether the authenticated user holds the required permission,
 * subject to the two-level flag (master env switch + per-tenant opt-in).
 *
 * @param authUser   The authenticated caller. Pass null if authentication
 *                   already failed — this function will return a 401.
 * @param permission The Permission key required by the calling route
 *                   (e.g. 'users:write', 'credits:upload').
 *
 * @returns null if the caller is allowed to proceed; a NextResponse that the
 *          caller must return immediately if access is denied.
 *
 * Usage in a route handler:
 *   const denied = await requirePermission(authUser, 'users:write');
 *   if (denied) return denied;
 *   // ... proceed with the real route logic
 */
export async function requirePermission(
  authUser: { role: string; clientId: string } | null,
  permission: Permission,
): Promise<NextResponse | null> {
  // ── Defensive: unauthenticated caller → 401 ──────────────────────────────
  // This guard is here as a safety net for routes that call requirePermission
  // before checking for null themselves. The route should already have done
  // its own auth check, but belt-and-suspenders here costs nothing.
  if (!authUser) {
    return err('Unauthorized', 401);
  }

  // ── Level 1: global master switch ────────────────────────────────────────
  // When the master switch is OFF (the common case during rollout), return
  // null immediately — NO DB read, zero overhead, behavior exactly as today.
  if (process.env.RBAC_ENFORCEMENT !== 'true') {
    return null;
  }

  // ── Level 2: per-tenant opt-in ───────────────────────────────────────────
  // Master is ON — now check whether this specific tenant has opted in.
  const cfg = await getClientConfigFromDb(authUser.clientId);

  // Fail-open: no config row (unknown tenant, DB down, etc.) → not enforcing.
  // The existing inline role checks in each route still gate access. This
  // prevents a DB hiccup from locking all users out of an unenrolled tenant.
  if (!cfg?.features?.rbacEnforcement) {
    return null;
  }

  // ── Both levels active: evaluate the permission ───────────────────────────
  // NOTE: per-tenant permission OVERRIDES are deferred to a 1.6b follow-up.
  // When that lands, load the tenant's override map from the DB/config and
  // pass it as the third argument to can():
  //   can(authUser.role, permission, tenantOverrides)
  if (can(authUser.role, permission)) {
    return null; // Allowed
  }

  return err(`Forbidden: missing permission ${permission}`, 403);
}
