import { JwtPayload } from './decorators/current-user.decorator';

/**
 * Multi-tenant read-scope predicate (cross-tenant boundary hardening).
 *
 * A Gifsy operator's JWT carries an `assumed` flag when they have ASSUMED a tenant
 * (assume-tenant / "Working in <Brand>"): the token then pins `clientId` to the assumed
 * tenant. In that context the operator is treated as a tenant user for READ scoping — reads
 * are pinned to the assumed tenant, never leaking sibling tenants.
 *
 * `platformWide` is true ONLY for the OWNER (`GIFSY_ADMIN`) in TRUE platform context (at gifsy
 * home, NOT assumed). RBAC Option-X (P5) — DENY-BY-DEFAULT for staff: a GIFSY_STAFF is NEVER
 * platform-wide. A staff works on a tenant only by ASSUMING one they hold a grant for
 * (GifsyStaffTenantGrant → GifsyTenantGrantService; enforced in auth.service.assumeTenant), at
 * which point they are `assumed` and this returns false → their reads pin to that one tenant.
 * An UN-assumed staff has no tenant context: `tenantScope` pins them to their home clientId
 * ('gifsy'), which owns no tenant business data → they see nothing until they assume. This
 * closes the cross-tenant read exposure a platform-wide staff default would open the moment a
 * 2nd tenant onboards. (A future explicit "all tenants" staff capability would be a distinct
 * grant checked here — deliberately NOT built yet; see RBAC-OPTION-X-STAFF.md.)
 *
 * NOTE: this governs READ scoping only. WRITE-authorization keys off isGifsyOperator (below)
 * / role — do NOT route those through this helper.
 */
export function platformWide(user: JwtPayload): boolean {
  return user.role === 'GIFSY_ADMIN' && !user.assumed;
}

/** The clientId to filter by, or undefined for a platform-wide (un-assumed OWNER) read. */
export function tenantScope(user: JwtPayload): string | undefined {
  return platformWide(user) ? undefined : user.clientId;
}

/**
 * WRITE-authorization predicate — is this caller a Gifsy platform OPERATOR (owner or staff)?
 *
 * Replaces the bare `user.role === 'GIFSY_ADMIN'` checks on Gifsy-operated write/action gates.
 * WHICH operator may reach a given gate is decided upstream by the route's @RequirePermission
 * (always-on + fail-closed for GIFSY_STAFF in PermissionGuard); WHICH tenant they may act on is
 * pinned by the assumed `clientId` (a scoped staff reaches an operator write only while assumed
 * into a granted tenant — RBAC Option-X P5). So this is only the coarse "is a Gifsy operator"
 * floor. Includes an ASSUMED GIFSY_ADMIN and an ASSUMED GIFSY_STAFF (role is unchanged when
 * assumed; both may act on the assumed tenant, scoped by the service's clientId filter). Does
 * NOT itself authorize assume-tenant or role-assignment — those keep their own checks
 * (assume-tenant validates the staff's grant; role-assignment stays owner-only).
 */
export function isGifsyOperator(user: JwtPayload): boolean {
  return user.role === 'GIFSY_ADMIN' || user.role === 'GIFSY_STAFF';
}
