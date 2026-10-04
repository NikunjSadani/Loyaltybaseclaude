import { Controller, Get } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Employee cockpit — tenant-scoped roster metrics on /v1/admin/people/overview.
 * GIFSY_ADMIN / CLIENT_ADMIN / MIS_USER. Read-only (sales_org:read).
 */
@Controller('admin/people')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
export class AdminPeopleController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get('overview')
  @RequirePermission('sales_org:read')
  overview(@CurrentUser() user: JwtPayload) {
    return this.svc.peopleOverview(user);
  }
}
