import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { UpdateOutletTypeConfigDto } from './dto/gifsy.dto';

/**
 * GIFSY platform-operator domain — ported from
 * platform/src/app/api/gifsy/clients/*. All routes are GIFSY_ADMIN-only
 * (platform super-admin) and legitimately span tenants: the client registry
 * lists every tenant, and outlet-type configs are addressed by the path slug,
 * NOT by the caller's own clientId. Role is enforced by @Roles on the
 * controller; re-checked here to preserve the source's explicit 403 guard.
 *
 * Business logic lives here; the controller is a thin HTTP adapter.
 */

const DEFAULT_FLAGS = {
  isEnabled: true,
  displayName: null as string | null,
  loyaltyEnabled: true,
  schemesEnabled: true,
  visibilityEnabled: true,
  payoutsEnabled: true,
  leaderboardEnabled: true,
  targetsEnabled: true,
  kycRequired: true,
};

const CONFIG_FIELDS = [
  'isEnabled',
  'displayName',
  'loyaltyEnabled',
  'schemesEnabled',
  'visibilityEnabled',
  'payoutsEnabled',
  'leaderboardEnabled',
  'targetsEnabled',
  'kycRequired',
] as const;

@Injectable()
export class GifsyService {
  constructor(private readonly prisma: PrismaService) {}

  private assertGifsy(user: JwtPayload): void {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden');
  }

  /**
   * GET /v1/gifsy/clients — lists every tenant from the canonical `Client` table
   * (the DB is the source of truth post-split; branding/features are JSON blobs).
   */
  async listClients(user: JwtPayload) {
    this.assertGifsy(user);

    const rows = await this.prisma.client.findMany({ orderBy: { onboardedAt: 'asc' } });
    const clients = rows.map((c) => {
      const branding = (c.branding ?? {}) as Record<string, unknown>;
      const features = (c.features ?? {}) as Record<string, unknown>;
      return {
        id: c.id,
        slug: c.id, // id IS the tenant slug
        internalName: c.internalName,
        status: c.status,
        onboardedAt: c.onboardedAt,
        displayName: branding.displayName,
        primaryColor: branding.primaryColor,
        logoUrl: branding.logoUrl,
        supportEmail: branding.supportEmail,
        productBrands: branding.productBrands,
        features: {
          visibilityInvoiceModule: features.visibilityInvoiceModule,
          kycApprovalFlow: features.kycApprovalFlow,
          walletModule: features.walletModule,
          salesTeamApp: features.salesTeamApp,
          referralModule: features.referralModule,
        },
      };
    });

    return { clients };
  }

  /**
   * GET /v1/gifsy/clients/:slug/outlet-type-configs — all outlet-type configs
   * for the given client slug. Missing rows fall back to all-default values.
   */
  async getOutletTypeConfigs(user: JwtPayload, slug: string) {
    this.assertGifsy(user);

    const [types, rows] = await Promise.all([
      this.prisma.outletType.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.outletTypeClientConfig.findMany({ where: { clientId: slug } }),
    ]);

    const rowMap = new Map(rows.map((r) => [r.outletTypeId, r]));

    return types.map((type) => {
      const row = rowMap.get(type.id);
      return {
        clientId: slug,
        outletTypeCode: type.code,
        outletTypeName: type.name,
        isEnabled: row?.isEnabled ?? DEFAULT_FLAGS.isEnabled,
        displayName: row?.displayName ?? DEFAULT_FLAGS.displayName,
        loyaltyEnabled: row?.loyaltyEnabled ?? DEFAULT_FLAGS.loyaltyEnabled,
        schemesEnabled: row?.schemesEnabled ?? DEFAULT_FLAGS.schemesEnabled,
        visibilityEnabled:
          row?.visibilityEnabled ?? DEFAULT_FLAGS.visibilityEnabled,
        payoutsEnabled: row?.payoutsEnabled ?? DEFAULT_FLAGS.payoutsEnabled,
        leaderboardEnabled:
          row?.leaderboardEnabled ?? DEFAULT_FLAGS.leaderboardEnabled,
        targetsEnabled: row?.targetsEnabled ?? DEFAULT_FLAGS.targetsEnabled,
        kycRequired: row?.kycRequired ?? DEFAULT_FLAGS.kycRequired,
      };
    });
  }

  /**
   * PUT /v1/gifsy/clients/:slug/outlet-type-configs/:code — upsert the config
   * for one outlet type (by stable code). Only fields explicitly present in the
   * body are written; omitted flags keep their existing value (or the all-true
   * default on create).
   */
  async updateOutletTypeConfig(
    user: JwtPayload,
    slug: string,
    code: string,
    body: UpdateOutletTypeConfigDto,
  ) {
    this.assertGifsy(user);

    const outletType = await this.prisma.outletType.findFirst({
      where: { code, isActive: true },
    });

    if (!outletType) {
      throw new NotFoundException(`Outlet type "${code}" not found.`);
    }

    const createData: Record<string, unknown> = { ...DEFAULT_FLAGS };
    const updateData: Record<string, unknown> = {};

    for (const field of CONFIG_FIELDS) {
      const value = body[field];
      // Mirror the source's `field in body` check: only write supplied fields.
      if (value !== undefined) {
        createData[field] = value;
        updateData[field] = value;
      }
    }

    const row = await this.prisma.outletTypeClientConfig.upsert({
      where: {
        clientId_outletTypeId: {
          clientId: slug,
          outletTypeId: outletType.id,
        },
      },
      create: { clientId: slug, outletTypeId: outletType.id, ...createData },
      update: updateData,
    });

    return {
      clientId: row.clientId,
      outletTypeCode: outletType.code,
      outletTypeName: outletType.name,
      isEnabled: row.isEnabled,
      displayName: row.displayName,
      loyaltyEnabled: row.loyaltyEnabled,
      schemesEnabled: row.schemesEnabled,
      visibilityEnabled: row.visibilityEnabled,
      payoutsEnabled: row.payoutsEnabled,
      leaderboardEnabled: row.leaderboardEnabled,
      targetsEnabled: row.targetsEnabled,
      kycRequired: row.kycRequired,
    };
  }
}
