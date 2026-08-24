import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface JwtPayload {
  sub:      string;   // user ID
  role:     string;
  clientId: string;
  phone:    string;
  name:     string;
  /**
   * True when this is an OPERATOR-CONTEXT (assume-tenant) token: a GIFSY_ADMIN
   * working inside a tenant's context (A2/#51). `sub` stays the real operator
   * (audit attribution); `clientId` is the assumed tenant. The FE shows a
   * "Working in <Brand>" banner when this is set. A normal session omits it.
   */
  assumed?: boolean;
  /**
   * Session-binding claim (#auth-hardening): the id of the UserSession this token
   * was minted against. jwt.strategy matches the bearer token to THIS session row,
   * so revoking/rotating the session invalidates the access token on its next
   * request (not after a 7-day TTL). Optional for backward-compat: tokens issued
   * before this change have no `sid` and fall back to the legacy (user+tenant) match.
   */
  sid?:     string;
  /**
   * RBAC Option-X — for a GIFSY_STAFF user, the id of their assigned GifsyRole.
   * Carried on the token so PermissionGuard can resolve the staff member's
   * effective permission set without an extra DB user lookup. Present only when
   * the user has a role assigned (omitted otherwise); every non-staff role
   * ignores it.
   */
  gifsyRoleId?: string;
  /**
   * Gift Catalogue & Dispatch (Wave 2) — for a VENDOR-role user, the id of the
   * Vendor entity this login belongs to. Carried on the token (mirroring gifsyRoleId)
   * so the vendor portal can HARD-scope every query by vendorId without an extra user
   * lookup. Present only for a VENDOR user; every other role omits it. The vendor
   * portal additionally scopes by `clientId` (the vendor's single pinned tenant,
   * decision #12) so a vendor never sees another vendor's or another tenant's data.
   */
  vendorId?: string;
  iat?:     number;
  exp?:     number;
}

/** Injects the decoded JWT payload into a controller parameter */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

/** Injects the clientId from the JWT — shorthand for the common case */
export const ClientId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.clientId;
  },
);
