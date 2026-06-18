import { Body, Controller, Get, Put } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Gift catalogue — re-homed from
 * platform/src/app/api/admin/gift-config/route.ts onto /v1/admin/gift-config.
 * GIFSY_ADMIN or CLIENT_ADMIN.
 *
 * The PUT body is a raw JSON array of gift items (matches the source); the
 * service validates Array.isArray and stores it as a ProgramSetting blob.
 */
// DEPRECATED: superseded by /v1/admin/rewards/* (P5.3) — retire with FE in 5.5
@Controller('admin/gift-config')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminGiftConfigController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @RequirePermission('rewards:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getGiftConfig(user);
  }

  @Put()
  @RequirePermission('rewards:manage_inventory')
  save(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    return this.svc.saveGiftConfig(user, body);
  }
}
