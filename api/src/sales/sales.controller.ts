import { Controller, Get, Param, Query } from '@nestjs/common';
import { SalesService } from './sales.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

/**
 * Sales Organization API — re-homed from platform/src/app/api/sales/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated). Responses are enveloped globally by the
 * TransformInterceptor.
 *
 * Only the real sales-org routes are exposed here. The World-A invoice/SKU/target
 * routes (upload, returns, invoices, last-upload, leaderboard) are not ported —
 * they depend on dropped models.
 */
@Controller('sales')
@Roles('SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('team')
  @RequirePermission('sales_org:read')
  getTeam(@CurrentUser() user: JwtPayload) {
    return this.sales.getTeam(user);
  }

  // Redesigned Team screen: filters (outletType/program/kpi) + per-direct-report KPI-achievement
  // league table. Optional memberId drills into that member's team (auth-scoped to the caller).
  @Get('team-view')
  @RequirePermission('sales_org:read')
  getTeamView(
    @CurrentUser() user: JwtPayload,
    @Query('memberId') memberId?: string,
    @Query('outletType') outletType?: string,
    @Query('program') program?: string,
    @Query('kpi') kpi?: string,
  ) {
    return this.sales.getTeamView(user, { memberId, outletType, program, kpi });
  }

  @Get('outlets')
  @RequirePermission('sales_org:read')
  getMyOutlets(@CurrentUser() user: JwtPayload) {
    return this.sales.getMyOutlets(user);
  }

  // The caller's own sales-org identity (header employee ID + profile). Self-info.
  @Get('me')
  getMe(@CurrentUser() user: JwtPayload) {
    return this.sales.getMe(user);
  }

  // Real target vs achievement for the caller's assigned outlets (dashboard card + chart).
  // Optional outletType scopes the card to one Outlet.outletType.code (RLP/BSC toggle); omitted →
  // unchanged (Deoleo byte-identical).
  @Get('targets')
  @RequirePermission('targets:read')
  getTargets(
    @CurrentUser() user: JwtPayload,
    @Query('period') period?: string,
    @Query('outletType') outletType?: string,
  ) {
    return this.sales.getTargets(user, period, outletType);
  }

  // Trade-comparison card: current / last-month / last-3-month-average monthly-sale + target-met for
  // the caller's subtree, scoped by outletType/program, optional memberId drill. Optional `kpi`
  // (a KpiDef code) selects which KPI the comparison is computed for — omitted → the primary default
  // (unchanged). SO-and-above only — the method-level @Roles DROPS SALES_ISR (the leaf XSR),
  // overriding the controller floor.
  @Get('trade-comparison')
  @Roles('SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO')
  @RequirePermission('targets:read')
  getTradeComparison(
    @CurrentUser() user: JwtPayload,
    @Query('outletType') outletType?: string,
    @Query('program') program?: string,
    @Query('memberId') memberId?: string,
    @Query('kpi') kpi?: string,
  ) {
    return this.sales.getTradeComparison(user, { outletType, program, memberId, kpi });
  }

  // Real per-outlet × per-KPI target vs achievement (the Outlets list page).
  @Get('outlet-targets')
  @RequirePermission('targets:read')
  getOutletTargets(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.sales.getOutletTargets(user, period);
  }

  // Target-vs-achievement 6-month trend for a chosen KPI (default primary). Dashboard view:
  // optional program (default all), roll-up aware. Outlet-detail view: pass `outlet` for a single
  // outlet's raw monthly series (program ignored, always SUM).
  @Get('target-trend')
  @RequirePermission('targets:read')
  getTargetTrend(
    @CurrentUser() user: JwtPayload,
    @Query('kpi') kpi?: string,
    @Query('program') program?: string,
    @Query('outlet') outlet?: string,
    @Query('outletType') outletType?: string,
  ) {
    return this.sales.getTargetTrend(user, kpi, program, outlet, outletType);
  }

  // Sales team leaderboard — ranks the caller against same-level peers (scope
  // widens the net: rm | state | national), each scored by their own team's
  // primary-KPI achievement. Entries come back sorted best-first.
  @Get('leaderboard')
  @RequirePermission('sales_org:read')
  getLeaderboard(
    @CurrentUser() user: JwtPayload,
    @Query('scope') scope?: string,
    @Query('period') period?: string,
  ) {
    return this.sales.getLeaderboard(user, scope, period);
  }

  @Get('team/:memberId')
  @RequirePermission('sales_org:read')
  getMember(@CurrentUser() user: JwtPayload, @Param('memberId') memberId: string) {
    return this.sales.getMember(user, memberId);
  }

  @Get('team/:memberId/outlets')
  @RequirePermission('sales_org:read')
  getMemberOutlets(@CurrentUser() user: JwtPayload, @Param('memberId') memberId: string) {
    return this.sales.getMemberOutlets(user, memberId);
  }

  @Get('team/:memberId/outlet-targets')
  @RequirePermission('sales_org:read')
  getMemberOutletTargets(
    @CurrentUser() user: JwtPayload,
    @Param('memberId') memberId: string,
    @Query('period') period?: string,
  ) {
    return this.sales.getMemberOutletTargets(user, memberId, period);
  }
}
