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
  @Get('targets')
  @RequirePermission('targets:read')
  getTargets(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.sales.getTargets(user, period);
  }

  // Real per-outlet × per-KPI target vs achievement (the Outlets list page).
  @Get('outlet-targets')
  @RequirePermission('targets:read')
  getOutletTargets(@CurrentUser() user: JwtPayload, @Query('period') period?: string) {
    return this.sales.getOutletTargets(user, period);
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
