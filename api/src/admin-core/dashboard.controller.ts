import { Controller, Get } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Admin dashboard KPIs — re-homed from
 * platform/src/app/api/admin/dashboard/kpis/route.ts onto
 * /v1/admin/dashboard/kpis. Allowed roles: GIFSY_ADMIN, CLIENT_ADMIN, MIS_USER.
 * All counts are tenant-scoped via relation filters in the service.
 */
@Controller('admin/dashboard')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
export class AdminDashboardController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get('kpis')
  @RequirePermission('reports:read')
  kpis(@CurrentUser() user: JwtPayload) {
    return this.svc.dashboardKpis(user);
  }
}
