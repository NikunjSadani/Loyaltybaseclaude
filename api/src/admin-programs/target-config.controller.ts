import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { TargetConfigService } from './target-config.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Target Config admin — re-homed from
 * platform/src/app/api/admin/target-config/* onto /v1.
 *
 * The PUT body is the raw TargetConfig object (opaque JSON with an `id`),
 * mirroring the source's `await req.json()`; it is validated in the service.
 */
@Controller('admin/target-config')
export class TargetConfigController {
  constructor(private readonly targetConfig: TargetConfigService) {}

  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('targets:read')
  list(@CurrentUser() user: JwtPayload) {
    return this.targetConfig.list(user);
  }

  @Put()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('targets:manage_config')
  upsert(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    return this.targetConfig.upsert(user, body);
  }

  @Delete(':id')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('targets:manage_config')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.targetConfig.remove(user, id);
  }
}
