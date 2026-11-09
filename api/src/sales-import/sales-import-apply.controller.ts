import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesPreviewService } from './apply/sales-preview.service';
import { SalesApplyService } from './apply/sales-apply.service';
import { assertSalesImportAccess } from './sales-import-access';
import type { ApplyRequest, ApplyResult, SalesImportPreview } from './sales-import.contract';

/**
 * Sales Import PREVIEW / APPLY routes (plan §5.2):
 *   GET  admin/sales-import/:id/preview   targets:read   → SalesImportPreview (READY only)
 *   POST admin/sales-import/:id/apply     targets:upload → ApplyResult
 * OWNER: Lane K. Every handler calls assertSalesImportAccess(...) FIRST; the import is always looked
 * up WITH `clientId: user.clientId` (cross-tenant id → 404).
 */
@Controller('admin/sales-import')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesImportApplyController {
  constructor(
    readonly preview: SalesPreviewService,
    readonly apply: SalesApplyService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
  ) {}

  @Get(':id/preview')
  @RequirePermission('targets:read')
  async getPreview(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SalesImportPreview> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: false });
    return this.preview.preview(user.clientId, id);
  }

  @Post(':id/apply')
  @HttpCode(200)
  @RequirePermission('targets:upload')
  async postApply(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: ApplyRequest): Promise<ApplyResult> {
    await assertSalesImportAccess(user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    return this.apply.apply(user, id, body);
  }
}
