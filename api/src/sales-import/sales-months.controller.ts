import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesMonthsService } from './months/sales-months.service';
import { SalesApplyService } from './apply/sales-apply.service';
import { assertSalesImportAccess } from './sales-import-access';
import type {
  FocusAcceptanceList,
  FocusAcceptanceRequest,
  SalesMonthRebuildProductListResult,
  SalesMonthRecalcPreview,
  SalesMonthRecalcRequest,
  SalesMonthRecalcResult,
  SalesMonthReopenRequest,
  SalesMonthReopenResult,
  SalesMonthRow,
} from './sales-import.contract';
import { HeavyOp } from '../common/heavy-op-limiter';

/**
 * Sales month state routes (plan §5.2, §7.3):
 *   GET  admin/sales-months                 targets:read   ?from=YYYY-MM&to=YYYY-MM (default: last 6, newest first)
 *   POST admin/sales-months/:month/close    targets:upload
 *   POST admin/sales-months/:month/reopen   method-level @Roles('GIFSY_ADMIN') + must be ASSUMED. RolesGuard
 *                                           uses getAllAndOverride, so the method roles REPLACE the class roles.
 *                                           An un-assumed GIFSY_ADMIN → 400 (access gate + service re-check).
 *   GET  admin/sales-months/:month/recalculate/preview   targets:read   → SalesMonthRecalcPreview (from stored history)
 *   POST admin/sales-months/:month/recalculate           targets:upload → SalesMonthRecalcResult (month OPEN, month lock)
 *   POST admin/sales-months/:month/rebuild-product-list  targets:upload → SalesMonthRow (OPEN or CLOSED; month lock;
 *                                                        rebuilds the stored product list only — no figures change; §10c)
 *   POST   admin/sales-months/:month/focus-acceptances   targets:upload → FocusAcceptanceList (FOCUS-FROM-TARGETS: accept an
 *                                                        UNMATCHED focus token as "not sold yet"; month OPEN; month lock)
 *   DELETE admin/sales-months/:month/focus-acceptances?kpiCode=&key=   targets:upload → FocusAcceptanceList (undo)
 * OWNER: Lane K.
 */
@Controller('admin/sales-months')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesMonthsController {
  constructor(
    readonly months: SalesMonthsService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
    readonly apply: SalesApplyService,
  ) {}

  @Get()
  @RequirePermission('targets:read')
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<SalesMonthRow[]> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: false });
    return this.months.list(user.clientId, from || undefined, to || undefined);
  }

  @Get(':month/recalculate/preview')
  @RequirePermission('targets:read')
  @HeavyOp()
  async recalcPreview(@CurrentUser() user: JwtPayload, @Param('month') month: string): Promise<SalesMonthRecalcPreview> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: false });
    return this.apply.recalcPreview(user.clientId, month);
  }

  @Post(':month/recalculate')
  @HttpCode(200)
  @RequirePermission('targets:upload')
  @HeavyOp()
  async recalculate(
    @CurrentUser() user: JwtPayload,
    @Param('month') month: string,
    @Body() body: SalesMonthRecalcRequest,
  ): Promise<SalesMonthRecalcResult> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.apply.recalculate(user, month, body);
  }

  @Post(':month/rebuild-product-list')
  @HttpCode(200)
  @RequirePermission('targets:upload')
  async rebuildProductList(@CurrentUser() user: JwtPayload, @Param('month') month: string): Promise<SalesMonthRebuildProductListResult> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.months.rebuildProductList(user, month);
  }

  @Post(':month/focus-acceptances')
  @HttpCode(200)
  @RequirePermission('targets:upload')
  async acceptFocus(
    @CurrentUser() user: JwtPayload,
    @Param('month') month: string,
    @Body() body: FocusAcceptanceRequest,
  ): Promise<FocusAcceptanceList> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.months.accept(user, month, body);
  }

  @Delete(':month/focus-acceptances')
  @HttpCode(200)
  @RequirePermission('targets:upload')
  async unacceptFocus(
    @CurrentUser() user: JwtPayload,
    @Param('month') month: string,
    @Query('kpiCode') kpiCode?: string,
    @Query('key') key?: string,
  ): Promise<FocusAcceptanceList> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.months.unaccept(user, month, kpiCode, key);
  }

  @Post(':month/close')
  @HttpCode(200)
  @RequirePermission('targets:upload')
  async close(@CurrentUser() user: JwtPayload, @Param('month') month: string): Promise<SalesMonthRow> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.months.close(user, month);
  }

  @Post(':month/reopen')
  @HttpCode(200)
  @Roles('GIFSY_ADMIN')
  @RequirePermission('targets:upload')
  async reopen(
    @CurrentUser() user: JwtPayload,
    @Param('month') month: string,
    @Body() body?: SalesMonthReopenRequest,
  ): Promise<SalesMonthReopenResult> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.months.reopen(user, month, body ?? {});
  }
}
