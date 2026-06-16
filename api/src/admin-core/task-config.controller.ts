import { Body, Controller, Get, Put } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { TaskConfigDto } from './dto/config.dto';

/**
 * Sales-dashboard task config — re-homed from
 * platform/src/app/api/admin/task-config/route.ts onto /v1/admin/task-config.
 *
 * GET: all authenticated admin + sales roles may read; partner roles
 * (SSS / WHOLESALER / SUB_STOCKIST) are blocked. The source used a blocklist;
 * here the equivalent allow-list of non-partner roles is enumerated on @Roles.
 * PUT: GIFSY_ADMIN or CLIENT_ADMIN only.
 */
@Controller('admin/task-config')
export class AdminTaskConfigController {
  constructor(private readonly svc: AdminCoreService) {}

  @Get()
  @Roles(
    'GIFSY_ADMIN',
    'CLIENT_ADMIN',
    'MIS_USER',
    'SALES_HO',
    'SALES_STATE_HEAD',
    'SALES_ASM',
    'SALES_SO',
    'SALES_ISR',
  ) // everyone except partner roles (SSS / WHOLESALER / SUB_STOCKIST)
  @RequirePermission('sales_org:read')
  get(@CurrentUser() user: JwtPayload) {
    return this.svc.getTaskConfig(user);
  }

  @Put()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('sales_org:manage_tasks')
  save(@CurrentUser() user: JwtPayload, @Body() dto: TaskConfigDto) {
    return this.svc.saveTaskConfig(user, dto);
  }
}
