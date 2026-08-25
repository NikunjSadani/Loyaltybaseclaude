import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { NotificationDeliveryReportService } from './notification-delivery-report.service';
import {
  NotificationDeliveryListQueryDto,
  NotificationDeliverySummaryQueryDto,
} from './dto/notification-delivery-report.dto';

/**
 * Transactional delivery-status report — `/v1/admin/notification-delivery`.
 *
 * `@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')` with NO `@RequirePermission`: the RolesGuard admits
 * GIFSY_ADMIN (super-admin) and CLIENT_ADMIN (allow-list), and 403s every other role — including
 * un-permissioned GIFSY_STAFF (which is only deferred to a `@RequirePermission` route). The service
 * HARD-scopes every read to the caller's tenant via `tenantScope(user)` (D4): a CLIENT_ADMIN sees
 * only their own tenant's data, a GIFSY_ADMIN sees all tenants (or the assumed tenant). No endpoint
 * accepts a clientId param — the tenant filter is derived from the JWT only.
 */
@Controller('admin/notification-delivery')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class NotificationDeliveryReportController {
  constructor(private readonly svc: NotificationDeliveryReportService) {}

  @Get('summary')
  summary(
    @CurrentUser() user: JwtPayload,
    @Query() q: NotificationDeliverySummaryQueryDto,
  ) {
    return this.svc.summary(user, q);
  }

  @Get('export')
  async export(
    @CurrentUser() user: JwtPayload,
    @Query() q: NotificationDeliverySummaryQueryDto,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<StreamableFile> {
    return this.svc.export(user, q);
  }

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query() q: NotificationDeliveryListQueryDto,
  ) {
    return this.svc.list(user, q);
  }
}
