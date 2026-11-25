import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantService } from '../tenant/tenant.service';
import { GifsyTenantGrantService } from '../common/rbac/gifsy-tenant-grant.service';

/**
 * GET /v1/admin/settings/features — the caller's tenant FEATURE SWITCHES only (owner-approved
 * 2026-11-25, platform-wide). The admin nav + per-page feature gates need the on/off switches, but
 * the full GET /admin/settings/config is gated on `tenancy:read`, which a GIFSY_STAFF role such as
 * "Project Manager" does not hold → 403 → every flag-gated nav item hidden. This narrow read lets
 * any Gifsy staff member working inside a client read ONLY that client's feature switches.
 *
 * Response: `{ features }` — the tenant's `clients.features` blob, exactly what /admin/settings/config
 * returns under `features` and what /partner/me + /sales/me already hand to field users. Nothing else
 * (no slug/branding/status, no program settings, no conversion rate).
 *
 * Access (no @RequirePermission on purpose — the switches are not a permission-gated resource; the
 * role list below is the whole gate, plus the staff tenant check in the handler):
 *   - GIFSY_ADMIN — any context (un-assumed → the platform tenant's switches, same as /config);
 *   - CLIENT_ADMIN — its own tenant (JWT clientId; the route takes NO tenant input);
 *   - GIFSY_STAFF — ONLY while ASSUMED into a tenant they currently hold a grant for (authoritative,
 *     uncached grant check — deny-by-default, assume-to-work). Un-assumed staff → 403, matching the
 *     rule that un-assumed staff have no tenant context (common/tenant-scope.ts);
 *   - MIS_USER and every other role — 403 (unchanged: /config already refuses MIS_USER, so the admin
 *     nav keeps rendering its defaults for MIS exactly as before).
 *
 * RolesGuard admits GIFSY_STAFF here because the role is LISTED (not via the permission-defer branch,
 * which needs a @RequirePermission). Separate controller (same `admin/settings` prefix) so the
 * existing settings controller and its consumers are untouched.
 */
@Controller('admin/settings')
export class AdminFeatureFlagsController {
  constructor(
    private readonly tenant: TenantService,
    private readonly grants: GifsyTenantGrantService,
  ) {}

  @Get('features')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'GIFSY_STAFF')
  async getFeatures(@CurrentUser() user: JwtPayload): Promise<{ features: Record<string, unknown> }> {
    if (user.role === 'GIFSY_STAFF') {
      if (user.assumed !== true) {
        throw new ForbiddenException('Choose a client to work in first.');
      }
      if (!(await this.grants.hasGrantUncached(user.sub, user.clientId))) {
        throw new ForbiddenException('You do not have access to this client.');
      }
    }
    const config = await this.tenant.resolveClient(user.clientId);
    return { features: { ...((config.features ?? {}) as unknown as Record<string, unknown>) } };
  }
}
