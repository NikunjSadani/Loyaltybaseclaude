import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator, tenantScope } from '../common/tenant-scope';
import { GiftDisbursalQueryDto } from './dto/vendor.dto';
import {
  buildDisbursalReport,
  buildDisbursalXlsx,
  DisbursalOrderRow,
  DisbursalReport,
} from './gift-disbursal.helper';

/**
 * Gift Disbursal report (Gift Catalogue & Dispatch §6). Tenant-accessible: a
 * CLIENT_ADMIN reads their OWN tenant's disbursals (force-scoped); a Gifsy operator
 * reads all tenants (and may narrow by clientId / vendorId). Pure reporting — NO
 * settlement / commission / vendor payout anywhere.
 *
 * VALUE == 194R BASIS: the ₹ value disbursed sums the FROZEN `valuePaise` over
 * DELIVERED orders only — the same basis 194R Source-2 uses — so the report total
 * reconciles exactly with the tenant's 194R base.
 */
@Injectable()
export class GiftDisbursalService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the effective tenant scope. A non-platform-wide caller (CLIENT_ADMIN, or an
   * ASSUMED operator) is FORCE-scoped to their own clientId — a `clientId` query param
   * that differs is ignored (cannot read another tenant). A platform-wide OWNER reads
   * all tenants, optionally narrowed by `clientId`.
   */
  private async buildWhere(
    user: JwtPayload,
    q: GiftDisbursalQueryDto,
  ): Promise<Prisma.RedemptionOrderWhereInput> {
    const scope = tenantScope(user); // undefined for platform-wide OWNER
    const effectiveClientId = scope ?? (q.clientId || undefined);

    const where: Prisma.RedemptionOrderWhereInput = {};
    if (effectiveClientId) where.partner = { clientId: effectiveClientId };
    if (q.vendorId) where.fulfilledByVendorId = q.vendorId;

    // Window on `deliveredAt` — the SAME basis 194R Source-2 uses (tds.service) — so an
    // FY/date-ranged disbursal report ties out to the 194R base for boundary orders
    // (Wave-2 audit MED#5). A non-DELIVERED order has a null `deliveredAt` and so falls
    // outside any date window — correct, since only DELIVERED value is disbursed.
    const deliveredAt: Prisma.DateTimeNullableFilter = {};
    if (q.from) deliveredAt.gte = new Date(q.from);
    if (q.to) {
      // inclusive upper bound → end of the given day
      const to = new Date(q.to);
      to.setHours(23, 59, 59, 999);
      deliveredAt.lte = to;
    }
    if (deliveredAt.gte || deliveredAt.lte) where.deliveredAt = deliveredAt;

    return where;
  }

  async report(user: JwtPayload, q: GiftDisbursalQueryDto): Promise<DisbursalReport> {
    // Only a Gifsy operator or a CLIENT_ADMIN may read this (route @Roles enforces it;
    // defence-in-depth here). A CLIENT_ADMIN is force-scoped by buildWhere/tenantScope.
    if (!isGifsyOperator(user) && user.role !== 'CLIENT_ADMIN') {
      throw new ForbiddenException('Gift disbursal report is not available to this role');
    }
    const where = await this.buildWhere(user, q);

    const orders = await this.prisma.redemptionOrder.findMany({
      where,
      select: {
        status: true,
        valuePaise: true,
        fulfilledByVendorId: true,
        partner: { select: { clientId: true } },
      },
    });

    const rows: DisbursalOrderRow[] = orders.map((o) => ({
      clientId: o.partner.clientId,
      vendorId: o.fulfilledByVendorId,
      status: o.status,
      valuePaise: o.valuePaise,
    }));

    const clientIds = [...new Set(rows.map((r) => r.clientId))];
    const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((v): v is string => !!v))];
    const [clients, vendors] = await Promise.all([
      clientIds.length
        ? this.prisma.client.findMany({
            where: { id: { in: clientIds } },
            select: { id: true, internalName: true },
          })
        : Promise.resolve([]),
      vendorIds.length
        ? this.prisma.vendor.findMany({
            where: { id: { in: vendorIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const clientNames = new Map(clients.map((c) => [c.id, c.internalName] as [string, string]));
    const vendorNames = new Map(vendors.map((v) => [v.id, v.name] as [string, string]));

    return buildDisbursalReport(rows, clientNames, vendorNames);
  }

  async exportXlsx(user: JwtPayload, q: GiftDisbursalQueryDto): Promise<Buffer> {
    const report = await this.report(user, q);
    return buildDisbursalXlsx(report);
  }
}
