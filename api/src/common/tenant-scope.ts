import { JwtPayload } from './decorators/current-user.decorator';

/**
 * Multi-tenant read-scope predicate (cross-tenant boundary hardening).
 *
 * A GIFSY_ADMIN is the platform operator, but the JWT carries an `assumed` flag when
 * that operator has ASSUMED a tenant (assume-tenant / "Working in <Brand>"): the token
 * then pins `clientId` to the assumed tenant. In that context the operator must be
 * treated as a tenant user for READ scoping — platform-wide reads (all-tenant KYC,
 * cross-tenant 194C totals, another tenant's media) must be pinned to the assumed
 * tenant, never leak sibling tenants.
 *
 * `platformWide` is therefore true ONLY for a Gifsy platform OPERATOR in TRUE platform
 * context (at gifsy home, NOT assumed into a tenant). RBAC Option-X: a GIFSY_STAFF is a
 * platform operator BELOW the owner — un-assumed (staff can never assume-tenant) and
 * permission-limited upstream by @RequirePermission + PermissionGuard (always-on/fail-closed
 * for staff), so a staffer who reached a read route is entitled to the same platform-wide
 * view as the owner for that read. Mirrors the idiom at admin-programs/visibility.service.ts
 * and reports.service.ts.
 *
 * NOTE: this governs READ scoping only. WRITE-authorization keys off isGifsyOperator (below)
 * / role — do NOT route those through this helper.
 */
export function platformWide(user: JwtPayload): boolean {
  return (user.role === 'GIFSY_ADMIN' || user.role === 'GIFSY_STAFF') && !user.assumed;
}

/** The clientId to filter by, or undefined for a platform-wide (un-assumed operator) read. */
export function tenantScope(user: JwtPayload): string | undefined {
  return platformWide(user) ? undefined : user.clientId;
}

/**
 * WRITE-authorization predicate — is this caller a Gifsy platform OPERATOR (owner or staff)?
 *
 * Replaces the bare `user.role === 'GIFSY_ADMIN'` checks on Gifsy-operated write/action gates.
 * WHICH operator may reach a given gate is decided upstream by the route's @RequirePermission
 * (always-on + fail-closed for GIFSY_STAFF in PermissionGuard), so this is only the coarse
 * "is a Gifsy operator" floor. Includes an ASSUMED GIFSY_ADMIN (role is unchanged when assumed;
 * an assumed operator may still act on the assumed tenant); a GIFSY_STAFF is never assumed
 * (assume-tenant is GIFSY_ADMIN-only). Does NOT admit staff to assume-tenant or role-assignment
 * checks — those deliberately keep their own `role === 'GIFSY_ADMIN'` test.
 */
export function isGifsyOperator(user: JwtPayload): boolean {
  return user.role === 'GIFSY_ADMIN' || user.role === 'GIFSY_STAFF';
}
