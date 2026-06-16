import { Body, Controller, Get, Put } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * KPI definitions — re-homed from
 * platform/src/app/api/admin/kpi-config/route.ts onto /v1/admin/kpi-config.
 * GIFSY_ADMIN or CLIENT_ADMIN.
 *
 * The PUT body is a raw JSON array of KPI definitions (matches the source); the
 * service validates Array.isArray and stores it as a ProgramSetting blob.
 */
@Controller('admin/kpi-config')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminKpiConfigController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @RequirePermission('reports:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getKpiConfig(user);
  }

  @Put()
  @RequirePermission('reports:manage_scheduled')
  save(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    return this.svc.saveKpiConfig(user, body);
  }
}
