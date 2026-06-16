import { Controller, Get, Param } from '@nestjs/common';
import { SalesService } from './sales.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
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
}
