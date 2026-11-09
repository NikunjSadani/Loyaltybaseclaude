import { Controller } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesPreviewService } from './apply/sales-preview.service';
import { SalesApplyService } from './apply/sales-apply.service';

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
}
