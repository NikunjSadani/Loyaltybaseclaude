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
 * `platformWide` is therefore true ONLY for a GIFSY_ADMIN in TRUE platform context
 * (at gifsy home, NOT assumed into a tenant). Mirrors the idiom already used at
 * admin-programs/visibility.service.ts and reports.service.ts.
 *
 * NOTE: this governs READ scoping only. WRITE-authorization (an assumed operator is
 * still a Gifsy operator and may act on the assumed tenant) still keys off role /
 * isGifsyAdmin / isAdmin — do NOT route those through this helper.
 */
export function platformWide(user: JwtPayload): boolean {
  return user.role === 'GIFSY_ADMIN' && !user.assumed;
}

/** The clientId to filter by, or undefined for a platform-wide (un-assumed GIFSY) read. */
export function tenantScope(user: JwtPayload): string | undefined {
  return platformWide(user) ? undefined : user.clientId;
}
