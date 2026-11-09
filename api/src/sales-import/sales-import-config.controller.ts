import { Controller } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesProfileService } from './kpi/sales-profile.service';
import { SalesKpiDefService } from './kpi/sales-kpi-def.service';

/**
 * Sales Import CONFIG routes (plan §5.2): column mapping + importer-owned KPI definitions.
 *   GET/PUT      admin/sales-import/profile     targets:read / targets:manage_config
 *   GET/POST     admin/sales-import/kpis        targets:read / targets:manage_config
 *   PATCH/DELETE admin/sales-import/kpis/:id    targets:manage_config
 *   POST         admin/sales-import/kpis/test   targets:read
 * OWNER: Lane K. Every handler calls assertSalesImportAccess(user, {tenant, prisma}, {write}) FIRST.
 * Registered BEFORE SalesImportController in SalesImportModule so the static `profile` / `kpis`
 * segments win over Lane I's `GET admin/sales-import/:id`.
 */
@Controller('admin/sales-import')
@Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
export class SalesImportConfigController {
  constructor(
    readonly profiles: SalesProfileService,
    readonly kpis: SalesKpiDefService,
    readonly tenant: TenantService,
    readonly prisma: PrismaService,
  ) {}
}
