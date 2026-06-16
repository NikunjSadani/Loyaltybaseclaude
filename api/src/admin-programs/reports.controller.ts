import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PointsLedgerQueryDto, TicketAgingQueryDto } from './dto/reports.dto';

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
  outletMaster(@CurrentUser() user: JwtPayload) {
    return this.reports.outletMaster(user);
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
}
