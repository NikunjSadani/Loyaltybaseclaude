import { Controller } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesImportRunnerService } from './ingest/sales-import-runner.service';

/**
 * Sales Import UPLOAD + READ routes (plan §5.2, tasks I-9 / I-10):
 *   POST   admin/sales-import/uploads                     targets:upload
 *   POST   admin/sales-import/:id/parts/:n                targets:upload (multipart `file`, ≤ SALES_IMPORT_PART_LIMIT_BYTES)
 *   POST   admin/sales-import/:id/complete                targets:upload
 *   POST   admin/sales-import/:id/reprocess               targets:upload
 *   DELETE admin/sales-import/:id                         targets:upload
 *   GET    admin/sales-import                             targets:read
 *   GET    admin/sales-import/:id                         targets:read
 *   GET    admin/sales-import/:id/combos                  targets:read (`:id` may be `latest`)
 *   GET    admin/sales-import/:id/unmatched.csv | errors.xlsx   targets:read
 * OWNER: Lane I. Every handler calls assertSalesImportAccess(...) FIRST; import lookups are always scoped
 * by `clientId: user.clientId` (cross-tenant id → 404).
 * Registered AFTER the config/apply controllers (see SalesImportModule) so `GET :id` cannot shadow
 * `GET profile` / `GET kpis`.
 */
@Controller('admin/sales-import')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesImportController {
  constructor(
    readonly runner: SalesImportRunnerService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
  ) {}
}
