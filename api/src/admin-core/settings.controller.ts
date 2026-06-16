import { Body, Controller, Get, Put } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { UpsertSettingDto } from './dto/settings.dto';

/**
 * Tenant program settings + non-secret tenant config — re-homed from
 * platform/src/app/api/admin/settings/* onto /v1/admin/settings.
 *
 * GET (settings + config): GIFSY_ADMIN or CLIENT_ADMIN.
 * PUT (settings upsert):   GIFSY_ADMIN only (matches the source role check).
 */
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('tenancy:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getSettings(user);
  }

  @Put()
  @Roles('GIFSY_ADMIN') // settings PUT is Gifsy-Admin-only in the source route
  @RequirePermission('tenancy:write')
  upsert(@CurrentUser() user: JwtPayload, @Body() dto: UpsertSettingDto) {
    return this.svc.upsertSetting(user, dto);
  }

  @Get('config')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('tenancy:read')
  getConfig(@CurrentUser() user: JwtPayload) {
    return this.svc.getTenantConfig(user);
  }
}
