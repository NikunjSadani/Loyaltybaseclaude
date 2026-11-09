import { Controller } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesMonthsService } from './months/sales-months.service';

/**
 * Sales month state routes (plan §5.2, §7.3):
 *   GET  admin/sales-months                 targets:read
 *   POST admin/sales-months/:month/close    targets:upload
 *   POST admin/sales-months/:month/reopen   method-level @Roles('GIFSY_ADMIN') + must be ASSUMED. RolesGuard
 *                                           uses getAllAndOverride, so the method roles REPLACE the class roles.
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
}
