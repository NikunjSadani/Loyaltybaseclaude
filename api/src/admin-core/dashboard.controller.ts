import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AdminCoreService } from './admin-core.service';
import { ProgramHealthDashboardService } from './dashboards/program-health-dashboard.service';
import { OperationsDashboardService } from './dashboards/operations-dashboard.service';
import { FinanceDashboardService } from './dashboards/finance-dashboard.service';
import { BillingProgressDashboardService } from './dashboards/billing-progress-dashboard.service';
import { BILLING_PROGRESS_OUTLETS_KIND_ID } from '../exports/kinds/batch2/billing-progress.kind';
import { BillingComparisonDashboardService } from './dashboards/billing-comparison-dashboard.service';
import { BILLING_COMPARISON_SLOWER_KIND_ID } from '../exports/kinds/batch2/billing-comparison.kind';
import { ExportsService } from '../exports/exports.service';
import { VisibilityMonthQueryDto } from '../visibility/dto/visibility-report.dto';
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
    private readonly billingProgress: BillingProgressDashboardService,
    private readonly exports: ExportsService,
    private readonly billingComparisonSvc: BillingComparisonDashboardService,
  ) {}

  /**
   * Overview tiles + Payout Summary. Optional `program` (exact Outlet.programName; '' / absent = all) and
   * `visibilityMonth` (YYYY-MM, default current IST month — the Pending Visibility Approvals tile).
   */
  @Get('kpis')
  @RequirePermission('reports:read')
  kpis(
    @CurrentUser() user: JwtPayload,
    @Query('program') program?: unknown,
    @Query('visibilityMonth') visibilityMonth?: unknown,
  ) {
    return this.svc.dashboardKpis(user, program, visibilityMonth);
  }

  /**
   * KYC program-health aggregation — replaces a fabricated FE dashboard with real,
   * tenant-scoped data. Same guards/scope as /kpis (GIFSY_ADMIN, CLIENT_ADMIN,
   * MIS_USER; scoped by user.clientId). See AdminCoreService.kycDashboard.
   *
   * Optional `programName` scopes the ENTIRE dashboard (headline, funnel, SLA,
   * buckets, quality/rejection AND coverageBy) to one program. Empty / 'ALL' /
   * omitted = no filter (unchanged behaviour).
   */
  @Get('kyc')
  @RequirePermission('reports:read')
  kyc(@CurrentUser() user: JwtPayload, @Query('programName') programName?: string) {
    return this.svc.kycDashboard(user, programName);
  }

  /** Program Health — brand-admin view (activation, participation, points economy,
   *  target achievement hero, redemptions). Tenant-scoped. */
  @Get('program-health')
  @RequirePermission('reports:read')
  programHealthDashboard(
    @CurrentUser() user: JwtPayload,
    @Query('period') period?: string,
    @Query('program') program?: unknown,
  ) {
    return this.programHealth.programHealth(user, period, program);
  }

  /**
   * Billing progress — outlets bucketed by achievement of the tenant's PRIMARY KPI for a month.
   * Query: month=YYYY-MM (default current IST month) · program · outletType · managerId.
   */
  @Get('billing-progress')
  @RequirePermission('reports:read')
  billingProgressSummary(@CurrentUser() user: JwtPayload, @Query() q: Record<string, unknown>) {
    return this.billingProgress.summary(user, q);
  }

  /** The outlets behind one tile: same filters + bucket=<key>|BEHIND_PACE|NO_TARGET · page · pageSize (≤200). */
  @Get('billing-progress/outlets')
  @RequirePermission('reports:read')
  billingProgressOutlets(@CurrentUser() user: JwtPayload, @Query() q: Record<string, unknown>) {
    return this.billingProgress.outlets(user, q);
  }

  /** Excel of one tile's FULL list (export kind 'billing-progress-outlets'; streams instantly). */
  @Get('billing-progress/outlets/export')
  @RequirePermission('reports:read')
  billingProgressOutletsExport(
    @CurrentUser() user: JwtPayload,
    @Query() q: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.exports.respond(res, user, BILLING_PROGRESS_OUTLETS_KIND_ID, q);
  }

  /** MTD vs last month / 3-month average to the same day (same filters as billing-progress). */
  @Get('billing-progress/comparison')
  @RequirePermission('reports:read')
  billingComparison(@CurrentUser() user: JwtPayload, @Query() q: Record<string, unknown>) {
    return this.billingComparisonSvc.summary(user, q);
  }

  /** Outlets billing slower than usual (< 80% of their own last-month MTD to the same day): filters · page · pageSize. */
  @Get('billing-progress/comparison/slower-outlets')
  @RequirePermission('reports:read')
  billingComparisonSlower(@CurrentUser() user: JwtPayload, @Query() q: Record<string, unknown>) {
    return this.billingComparisonSvc.slowerOutlets(user, q);
  }

  /** Excel of the full slower-than-usual list (export kind 'billing-comparison-slower'; streams instantly). */
  @Get('billing-progress/comparison/slower-outlets/export')
  @RequirePermission('reports:read')
  billingComparisonSlowerExport(
    @CurrentUser() user: JwtPayload,
    @Query() q: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.exports.respond(res, user, BILLING_COMPARISON_SLOWER_KIND_ID, q);
  }

  /** Operations — Gifsy operator view (payout health, ticket SLA, visibility, settlement). */
  @Get('operations')
  @RequirePermission('reports:read')
  operationsDashboard(@CurrentUser() user: JwtPayload, @Query('visibilityMonth') visibilityMonth?: unknown) {
    return this.operations.operations(user, visibilityMonth);
  }

  /** The Visibility Program Funnel for one month (`month=YYYY-MM`, default current IST month). */
  @Get('operations/visibility')
  @RequirePermission('reports:read')
  operationsVisibility(@CurrentUser() user: JwtPayload, @Query('month') month?: unknown) {
    return this.operations.visibilityFunnel(user, month);
  }

  /** The captures behind "Flagged" (duplicate photo / outside the fence) for a month, paged (pageSize ≤ 200). */
  @Get('operations/visibility/flags')
  @RequirePermission('reports:read')
  operationsVisibilityFlags(@CurrentUser() user: JwtPayload, @Query() q: VisibilityMonthQueryDto) {
    return this.operations.visibilityFlags(user, q.month, q.page, q.pageSize);
  }

  /** Finance & Liability — MIS view (points liability, breakage, TDS, fund reconciliation). */
  @Get('finance')
  @RequirePermission('reports:read')
  financeDashboard(@CurrentUser() user: JwtPayload, @Query('fy') fy?: string) {
    return this.finance.finance(user, fy);
  }
}
