import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateClientDto, UpdateClientDto, UpdateOutletTypeConfigDto } from './dto/gifsy.dto';

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

/**
 * The module-level feature keys counted as "modules on" in the operator
 * console (mirrors the FE clients-list `features` projection). partnerClasses
 * is intentionally absent — that World-A concept's column was dropped in S2,
 * so the console no longer surfaces a class count.
 */
const MODULE_FEATURE_KEYS = [
  'visibilityInvoiceModule',
  'kycApprovalFlow',
  'walletModule',
  'salesTeamApp',
  'referralModule',
] as const;

/**
 * Slugs a new tenant may NOT claim. `gifsy` is the platform sentinel (a tenant with
 * that slug would let its CLIENT_ADMIN mint GIFSY_ADMIN operators via the
 * platform-context role gate, and collides with the proxy's `gifsy` host handling);
 * the rest are infrastructure hostnames.
 */
const RESERVED_CLIENT_SLUGS = new Set(['gifsy', 'admin', 'api', 'platform', 'www', 'app']);

@Injectable()
export class GifsyService {
  constructor(private readonly prisma: PrismaService) {}

  private assertGifsy(user: JwtPayload): void {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden');
  }

  /**
   * Idempotently upserts an `OutletTypeClientConfig` row for every active
   * `OutletType`, applying the DEFAULT_FLAGS for each.  Accepts a Prisma
   * transaction client so it can be called inside a `$transaction`.
   */
  private async provisionOutletTypeConfigs(
    tx: Prisma.TransactionClient,
    clientId: string,
  ): Promise<void> {
    const allTypes = await tx.outletType.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    for (const ot of allTypes) {
      await tx.outletTypeClientConfig.upsert({
        where: { clientId_outletTypeId: { clientId, outletTypeId: ot.id } },
        update: { isEnabled: DEFAULT_FLAGS.isEnabled },
        create: { clientId, outletTypeId: ot.id, ...DEFAULT_FLAGS },
      });
    }
  }

  /**
   * POST /v1/gifsy/clients — create a new tenant Client row and provision its
   * OutletTypeClientConfig rows in a single transaction. GIFSY_ADMIN only.
   * Throws 409 ConflictException if the slug already exists.
   */
  async createClient(user: JwtPayload, dto: CreateClientDto) {
    this.assertGifsy(user);

    // Reserved slugs: `gifsy` is the PLATFORM sentinel — a tenant with that slug would
    // give its CLIENT_ADMIN a `clientId==='gifsy'`, satisfying the platform-context gate
    // that lets a user mint GIFSY_ADMIN operators (privilege escalation); it also
    // collides with the proxy's special-casing of the `gifsy` host. Block it + a few
    // other infrastructure slugs.
    if (RESERVED_CLIENT_SLUGS.has(dto.slug.toLowerCase())) {
      throw new ConflictException(`Slug "${dto.slug}" is reserved and cannot be used.`);
    }

    const existing = await this.prisma.client.findUnique({ where: { id: dto.slug } });
    if (existing) {
      throw new ConflictException(`Client with slug "${dto.slug}" already exists.`);
    }

    let client;
    try {
      client = await this.prisma.$transaction(async (tx) => {
        const created = await tx.client.create({
          data: {
            id: dto.slug,
            internalName: dto.internalName,
            status: dto.status ?? 'ONBOARDING',
            onboardedAt: new Date(),
            branding: {
              displayName: dto.displayName ?? '',
              primaryColor: dto.primaryColor ?? '#6b7280',
              supportEmail: dto.supportEmail ?? '',
              supportPhone: dto.supportPhone ?? '',
              invoicePrefix: dto.invoicePrefix ?? '',
            } as Prisma.InputJsonValue,
            features: (dto.features ?? {}) as Prisma.InputJsonValue,
            approvalHierarchy: {} as Prisma.InputJsonValue,
            notifications: {} as Prisma.InputJsonValue,
            invoicing: {
              invoicePrefix: dto.invoicePrefix ?? '',
            } as Prisma.InputJsonValue,
            wallet: {} as Prisma.InputJsonValue,
          },
        });

        await this.provisionOutletTypeConfigs(tx, created.id);

        return created;
      });
    } catch (e) {
      // Race: a concurrent POST with the same slug won the unique (PK) constraint
      // between our pre-check and create. Surface the intended 409, not a raw 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Client with slug "${dto.slug}" already exists.`);
      }
      throw e;
    }

    const branding = (client.branding ?? {}) as Record<string, unknown>;
    const features = (client.features ?? {}) as Record<string, unknown>;
    return {
      id: client.id,
      slug: client.id,
      internalName: client.internalName,
      status: client.status,
      onboardedAt: client.onboardedAt,
      displayName: branding.displayName,
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
      invoicePrefix: branding.invoicePrefix,
      productBrands: branding.productBrands,
      features: {
        visibilityInvoiceModule: features.visibilityInvoiceModule,
        kycApprovalFlow: features.kycApprovalFlow,
        walletModule: features.walletModule,
        salesTeamApp: features.salesTeamApp,
        referralModule: features.referralModule,
      },
    };
  }

  /**
   * PATCH /v1/gifsy/clients/:slug — edit an existing tenant. GIFSY_ADMIN only.
   * A partial update: only fields present in the DTO are written. Branding and
   * feature fields are MERGED into the existing JSON blobs (never overwritten
   * wholesale — that would wipe logoUrl/faviconUrl/productBrands and unlisted
   * flags). Returns the same projection as createClient/listClients. 404 if the
   * slug has no client row.
   */
  async updateClient(user: JwtPayload, slug: string, dto: UpdateClientDto) {
    this.assertGifsy(user);

    const existing = await this.prisma.client.findFirst({ where: { id: slug } });
    if (!existing) {
      throw new NotFoundException('Client not found');
    }

    const data: Prisma.ClientUpdateInput = {};

    // Top-level scalar columns — only written when explicitly provided.
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.internalName !== undefined) data.internalName = dto.internalName;

    // Branding: merge only the provided fields over the existing blob so
    // logoUrl/faviconUrl/productBrands and any other keys survive the PATCH.
    const brandingKeys = [
      'displayName',
      'primaryColor',
      'supportEmail',
      'supportPhone',
      'invoicePrefix',
    ] as const;
    if (brandingKeys.some((k) => dto[k] !== undefined)) {
      const branding = { ...((existing.branding ?? {}) as Record<string, unknown>) };
      for (const k of brandingKeys) {
        if (dto[k] !== undefined) branding[k] = dto[k];
      }
      data.branding = branding as Prisma.InputJsonValue;
    }

    // Features: merge the provided keys over the existing blob (never drop
    // unlisted flags). `features.partnerApp` is a NESTED object (showSchemes/
    // showInvoices/showWallet/showTeam/showLeaderboard), so a shallow spread of a
    // partial `partnerApp` would wipe its sibling flags — deep-merge it explicitly.
    if (dto.features !== undefined) {
      const existingFeatures = (existing.features ?? {}) as Record<string, unknown>;
      const incoming = dto.features as Record<string, unknown>;
      const features: Record<string, unknown> = { ...existingFeatures, ...incoming };
      const incomingPartnerApp = incoming.partnerApp;
      if (
        incomingPartnerApp &&
        typeof incomingPartnerApp === 'object' &&
        !Array.isArray(incomingPartnerApp)
      ) {
        features.partnerApp = {
          ...((existingFeatures.partnerApp as Record<string, unknown>) ?? {}),
          ...(incomingPartnerApp as Record<string, unknown>),
        };
      }
      data.features = features as Prisma.InputJsonValue;
    }

    const client = await this.prisma.client.update({ where: { id: slug }, data });

    const branding = (client.branding ?? {}) as Record<string, unknown>;
    const features = (client.features ?? {}) as Record<string, unknown>;
    return {
      id: client.id,
      slug: client.id,
      internalName: client.internalName,
      status: client.status,
      onboardedAt: client.onboardedAt,
      displayName: branding.displayName,
      primaryColor: branding.primaryColor,
      logoUrl: branding.logoUrl,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
      invoicePrefix: branding.invoicePrefix,
      productBrands: branding.productBrands,
      features: {
        visibilityInvoiceModule: features.visibilityInvoiceModule,
        kycApprovalFlow: features.kycApprovalFlow,
        walletModule: features.walletModule,
        salesTeamApp: features.salesTeamApp,
        referralModule: features.referralModule,
      },
    };
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
        supportPhone: branding.supportPhone,
        invoicePrefix: branding.invoicePrefix,
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
   * GET /v1/gifsy/overview — operator dashboard aggregates over the canonical
   * `Client` table. Cross-tenant by design (GIFSY oversight mode): every tenant
   * is counted. Returns the status tallies for the stat strip plus a lightweight
   * card row per client (status, brand colour, "modules on" count).
   */
  async getOverview(user: JwtPayload) {
    this.assertGifsy(user);

    const rows = await this.prisma.client.findMany({
      orderBy: { onboardedAt: 'asc' },
    });

    const clients = rows.map((c) => {
      const branding = (c.branding ?? {}) as Record<string, unknown>;
      const features = (c.features ?? {}) as Record<string, unknown>;
      const enabledFeatureCount = MODULE_FEATURE_KEYS.filter(
        (k) => !!features[k],
      ).length;
      return {
        slug: c.id, // id IS the tenant slug
        internalName: c.internalName,
        status: c.status,
        onboardedAt: c.onboardedAt,
        displayName: (branding.displayName as string) ?? c.internalName,
        primaryColor: (branding.primaryColor as string) ?? '#6b7280',
        enabledFeatureCount,
        moduleCount: MODULE_FEATURE_KEYS.length,
      };
    });

    const countBy = (status: string) =>
      rows.filter((c) => c.status === status).length;

    return {
      totalClients: rows.length,
      active: countBy('ACTIVE'),
      onboarding: countBy('ONBOARDING'),
      inactive: countBy('INACTIVE'),
      clients,
    };
  }

  /**
   * GET /v1/gifsy/clients/:slug — full per-client detail for the operator
   * config page. Cross-tenant (addressed by path slug, not the caller's own
   * clientId). The nested config blocks are JSON columns; each is spread over a
   * conservative default so the FE editor always receives a complete shape even
   * for a freshly-onboarded tenant whose blobs are still empty. msg91AuthKey is
   * deliberately never returned (it is not stored on the row).
   */
  async getClientDetail(user: JwtPayload, slug: string) {
    this.assertGifsy(user);

    const c = await this.prisma.client.findUnique({ where: { id: slug } });
    if (!c) {
      throw new NotFoundException(`Client "${slug}" not found.`);
    }

    const branding = (c.branding ?? {}) as Record<string, unknown>;
    const features = (c.features ?? {}) as Record<string, unknown>;
    const partnerApp = (features.partnerApp ?? {}) as Record<string, unknown>;
    const approvalHierarchy = (c.approvalHierarchy ?? {}) as Record<
      string,
      unknown
    >;
    const notifications = (c.notifications ?? {}) as Record<string, unknown>;
    const templateIds = (notifications.templateIds ?? {}) as Record<
      string,
      unknown
    >;
    const invoicing = (c.invoicing ?? {}) as Record<string, unknown>;
    const wallet = (c.wallet ?? {}) as Record<string, unknown>;

    return {
      slug: c.id,
      internalName: c.internalName,
      status: c.status,
      onboardedAt: c.onboardedAt,

      branding: {
        displayName: (branding.displayName as string) ?? c.internalName,
        primaryColor: (branding.primaryColor as string) ?? '#6b7280',
        logoUrl: (branding.logoUrl as string) ?? '',
        faviconUrl: (branding.faviconUrl as string) ?? '',
        supportEmail: (branding.supportEmail as string) ?? '',
        supportPhone: (branding.supportPhone as string) ?? '',
        productBrands: (branding.productBrands as string[]) ?? [],
      },

      features: {
        visibilityInvoiceModule: !!features.visibilityInvoiceModule,
        kycApprovalFlow: !!features.kycApprovalFlow,
        campaignEnrollmentForm: !!features.campaignEnrollmentForm,
        salesTeamApp: !!features.salesTeamApp,
        walletModule: !!features.walletModule,
        referralModule: !!features.referralModule,
        selfEnrollmentAllowed: !!features.selfEnrollmentAllowed,
        nonKycOutletCampaigns: !!features.nonKycOutletCampaigns,
        multiLevelApproval: !!features.multiLevelApproval,
        rbacEnforcement: !!features.rbacEnforcement,
        partnerApp: {
          showSchemes: partnerApp.showSchemes !== false,
          showInvoices: !!partnerApp.showInvoices,
          showWallet: !!partnerApp.showWallet,
          showTeam: partnerApp.showTeam !== false,
          showLeaderboard: !!partnerApp.showLeaderboard,
        },
      },

      // partnerClasses is no longer a first-class persisted concept (the column
      // was dropped in S2). If a tenant's features blob still carries a legacy
      // list, pass it through; otherwise surface an empty list so the FE section
      // renders its "none" state rather than crashing.
      partnerClasses: (features.partnerClasses as unknown[]) ?? [],

      approvalHierarchy: {
        levels: (approvalHierarchy.levels as unknown[]) ?? [],
        requireGifsyFinalApproval: !!approvalHierarchy.requireGifsyFinalApproval,
        ...(approvalHierarchy.kycAutoApproveBelowCreditLimit !== undefined
          ? {
              kycAutoApproveBelowCreditLimit:
                approvalHierarchy.kycAutoApproveBelowCreditLimit,
            }
          : {}),
      },

      notifications: {
        whatsappSenderId: (notifications.whatsappSenderId as string) ?? '',
        smsSenderId: (notifications.smsSenderId as string) ?? '',
        templateIds: {
          schemePublished: (templateIds.schemePublished as string) ?? '',
          enrollmentConfirm: (templateIds.enrollmentConfirm as string) ?? '',
          otpVerification: (templateIds.otpVerification as string) ?? '',
          kycApproved: (templateIds.kycApproved as string) ?? '',
          kycRejected: (templateIds.kycRejected as string) ?? '',
          payoutGenerated: (templateIds.payoutGenerated as string) ?? '',
        },
      },

      invoicing: {
        sellerLegalName:
          (invoicing.sellerLegalName as string) ??
          'Tech Gifsy Solutions Limited',
        sellerGstin: (invoicing.sellerGstin as string) ?? '',
        sellerState: (invoicing.sellerState as string) ?? '',
        sellerAddress: (invoicing.sellerAddress as string) ?? '',
        sellerPan: (invoicing.sellerPan as string) ?? '',
        bankName: (invoicing.bankName as string) ?? '',
        bankAccountNumber: (invoicing.bankAccountNumber as string) ?? '',
        bankIfsc: (invoicing.bankIfsc as string) ?? '',
        bankBranch: (invoicing.bankBranch as string) ?? '',
        invoicePrefix: (invoicing.invoicePrefix as string) ?? '',
        sacCode: (invoicing.sacCode as string) ?? '',
      },

      wallet: {
        defaultHoldingPeriodDays:
          (wallet.defaultHoldingPeriodDays as number) ?? 0,
        pointsExpiryDays: (wallet.pointsExpiryDays as number | null) ?? null,
        minRedemptionAmount: (wallet.minRedemptionAmount as number) ?? 0,
        redemptionModes: (wallet.redemptionModes as string[]) ?? [],
        pointsToRupeeRatio: (wallet.pointsToRupeeRatio as number) ?? 1,
      },
    };
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
