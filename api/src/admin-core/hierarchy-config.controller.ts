import { Body, Controller, Get, Put } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { HierarchyConfigDto } from './dto/config.dto';

/**
 * Employee-hierarchy config — re-homed from
 * platform/src/app/api/admin/hierarchy-config/route.ts onto
 * /v1/admin/hierarchy-config. GIFSY_ADMIN or CLIENT_ADMIN.
 *
 * GET returns the denormalized JSON snapshot. PUT stores the snapshot AND
 * persists the authoritative relational tree (levels + Users + SalesUsers).
 */
@Controller('admin/hierarchy-config')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class AdminHierarchyConfigController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @RequirePermission('sales_org:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getHierarchyConfig(user);
  }

  @Put()
  @RequirePermission('sales_org:manage_hierarchy')
  save(@CurrentUser() user: JwtPayload, @Body() dto: HierarchyConfigDto) {
    return this.svc.saveHierarchyConfig(user, dto);
  }
}
