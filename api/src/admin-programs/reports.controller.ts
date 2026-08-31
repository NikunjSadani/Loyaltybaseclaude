import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ReportsService } from './reports.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PointsLedgerQueryDto, TargetVsSalesQueryDto, TicketAgingQueryDto } from './dto/reports.dto';

/**
 * Reports admin — re-homed from
 * platform/src/app/api/admin/reports/* onto /v1.
 *
 * points-ledger and ticket-aging default to JSON and return an xlsx
 * StreamableFile download when `format=xlsx`. outlet-master is always xlsx.
 */
@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('outlet-master')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('reports:export')
  outletMaster(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    return this.reports.outletMaster(user, req);
  }

  @Get('points-ledger')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('reports:export')
  pointsLedger(@CurrentUser() user: JwtPayload, @Query() query: PointsLedgerQueryDto) {
    return this.reports.pointsLedger(user, query);
  }

  @Get('ticket-aging')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('reports:export')
  ticketAging(@CurrentUser() user: JwtPayload, @Query() query: TicketAgingQueryDto) {
    return this.reports.ticketAging(user, query);
  }

  /**
   * GET /v1/admin/reports/target-vs-sales?fromMonth=YYYY-MM&toMonth=YYYY-MM[&format=xlsx]
   * Target-vs-actual per outlet × month × KPI over an inclusive month range
   * (max 15). Reuses the targets pace join; scoped by the caller's clientId, so
   * it carries the targets:read permission (not reports:export) — matching getPace.
   */
  @Get('target-vs-sales')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('targets:read')
  targetVsSales(@CurrentUser() user: JwtPayload, @Query() query: TargetVsSalesQueryDto) {
    return this.reports.targetVsSales(user, query);
  }
}
