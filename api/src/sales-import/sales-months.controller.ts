import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesMonthsService } from './months/sales-months.service';
import { assertSalesImportAccess } from './sales-import-access';
import type { SalesMonthRow } from './sales-import.contract';

/**
 * Sales month state routes (plan §5.2, §7.3):
 *   GET  admin/sales-months                 targets:read   ?from=YYYY-MM&to=YYYY-MM (default: last 6, newest first)
 *   POST admin/sales-months/:month/close    targets:upload
 *   POST admin/sales-months/:month/reopen   method-level @Roles('GIFSY_ADMIN') + must be ASSUMED. RolesGuard
 *                                           uses getAllAndOverride, so the method roles REPLACE the class roles.
 *                                           An un-assumed GIFSY_ADMIN → 400 (access gate + service re-check).
 * OWNER: Lane K.
 */
@Controller('admin/sales-months')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesMonthsController {
  constructor(
    readonly months: SalesMonthsService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
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
  async reopen(@CurrentUser() user: JwtPayload, @Param('month') month: string): Promise<SalesMonthRow> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.months.reopen(user, month);
  }
}
