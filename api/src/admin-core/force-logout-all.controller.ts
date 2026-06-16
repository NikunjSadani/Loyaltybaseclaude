import { Controller, Post } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * GIFSY kill-switch — re-homed from
 * platform/src/app/api/admin/force-logout-all/route.ts onto
 * /v1/admin/force-logout-all.
 *
 * Platform-wide force logout: revokes EVERY active session across ALL users and
 * ALL tenants, then writes a platform-scope ('ALL') audit log. GIFSY_ADMIN ONLY
 * — this is a cross-tenant operation and CLIENT_ADMIN is explicitly excluded.
 */
@Controller('admin/force-logout-all')
@Roles('GIFSY_ADMIN')
export class AdminForceLogoutAllController {
  constructor(private readonly svc: AdminCoreService) {}

  @Post()
  forceLogoutAll(@CurrentUser() user: JwtPayload) {
    return this.svc.forceLogoutAll(user);
  }
}
