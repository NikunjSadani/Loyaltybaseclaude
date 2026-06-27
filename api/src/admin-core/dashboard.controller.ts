import { Controller, Get, Query } from '@nestjs/common';
import { AdminCoreService } from './admin-core.service';
import { ProgramHealthDashboardService } from './dashboards/program-health-dashboard.service';
import { OperationsDashboardService } from './dashboards/operations-dashboard.service';
import { FinanceDashboardService } from './dashboards/finance-dashboard.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Admin dashboard KPIs — re-homed from
 * platform/src/app/api/admin/dashboard/kpis/route.ts onto
 * /v1/admin/dashboard/kpis. Allowed roles: GIFSY_ADMIN, CLIENT_ADMIN, MIS_USER.
 * All counts are tenant-scoped via relation filters in the service.
 */
@Controller('admin/dashboard')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER')
export class AdminDashboardController {
  constructor(
    private readonly svc: AdminCoreService,
    private readonly programHealth: ProgramHealthDashboardService,
    private readonly operations: OperationsDashboardService,
    private readonly finance: FinanceDashboardService,
  ) {}

  @Get('kpis')
  @RequirePermission('reports:read')
  kpis(@CurrentUser() user: JwtPayload) {
    return this.svc.dashboardKpis(user);
  }

  /**
   * KYC program-health aggregation — replaces a fabricated FE dashboard with real,
   * tenant-scoped data. Same guards/scope as /kpis (GIFSY_ADMIN, CLIENT_ADMIN,
   * MIS_USER; scoped by user.clientId). See AdminCoreService.kycDashboard.
   */
  @Get('kyc')
  @RequirePermission('reports:read')
  kyc(@CurrentUser() user: JwtPayload) {
    return this.svc.kycDashboard(user);
  }

  /** Program Health — brand-admin view (activation, participation, points economy,
   *  target achievement hero, redemptions). Tenant-scoped. */
  @Get('program-health')
  @RequirePermission('reports:read')
  programHealthDashboard(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.programHealth.programHealth(user, period);
  }

  /** Operations — Gifsy operator view (payout health, ticket SLA, visibility, settlement). */
  @Get('operations')
  @RequirePermission('reports:read')
  operationsDashboard(@CurrentUser() user: JwtPayload) {
    return this.operations.operations(user);
  }

  /** Finance & Liability — MIS view (points liability, breakage, TDS, fund reconciliation). */
  @Get('finance')
  @RequirePermission('reports:read')
  financeDashboard(@CurrentUser() user: JwtPayload, @Query('fy') fy?: string) {
    return this.finance.finance(user, fy);
  }
}
