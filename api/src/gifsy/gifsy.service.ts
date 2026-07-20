import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { sniffFileType } from '../common/file-signature';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateClientDto,
  UpdateClientDto,
  UpdateOutletTypeConfigDto,
  UpdateWalletSettingsDto,
} from './dto/gifsy.dto';

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

/**
 * Tenant custom domains are constrained to the platform's own zone: every routed
 * hostname must be a subdomain of `gifsy.in`. Kept as a single constant so the
 * scope can be widened later (e.g. to allow BYO apex domains) in exactly one
 * place. NOTE: `.endsWith(TENANT_DOMAIN_SUFFIX)` also rejects the bare apex
 * `gifsy.in` itself (8 chars, no leading label), which is intended.
 */
const TENANT_DOMAIN_SUFFIX = '.gifsy.in';

/**
 * First-label subdomains a tenant may NOT claim — platform infrastructure
 * hostnames (e.g. `api.gifsy.in`, `app.gifsy.in`). Rejecting these stops a tenant
 * from hijacking a system host by registering it as a custom domain.
 */
const RESERVED_DOMAIN_LABELS = new Set([
  'api',
  'app',
  'www',
  'platform',
  'admin',
  'status',
  'mail',
  'uat',
]);

/**
 * Maps a branding-asset `kind` (upload endpoint) to the branding-blob URL field
 * it fills — also the UpdateClientDto field name, so persistence flows through
 * the existing branding-merge update path.
 */
const BRANDING_ASSET_FIELDS = {
  logo: 'logoUrl',
  wordmarkWhite: 'wordmarkWhiteUrl',
  wordmarkColor: 'wordmarkColorUrl',
  favicon: 'faviconUrl',
} as const;

type BrandingAssetKind = keyof typeof BRANDING_ASSET_FIELDS;

/**
 * RFC-1123 hostname shape (lower-cased): dot-separated labels, each 1-63 chars of
 * [a-z0-9-] not starting/ending with a hyphen; total ≤ 253 chars.
 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

@Injectable()
export class GifsyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    // Reused to delegate the tenant-targeted wallet-settings write to the SAME
    // per-tenant settings stores the tenant Settings panel uses (never re-implemented).
    private readonly adminCore: AdminCoreService,
    private readonly tenantSettings: TenantSettingsService,
    // @Global TenantService — used to bust the resolveClient feature/status cache
    // after a console edit so a stale 5-min-cached config can't be served.
    private readonly tenant: TenantService,
  ) {}

  private assertGifsy(user: JwtPayload): void {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden');
  }

  // ════════════════════════════════════════════════════════════════════════
  // WALLET SETTINGS — GIFSY-operator, tenant-TARGETED money-path config
  // (conversion rate / points-expiry / redemption floors) for :slug
  // ════════════════════════════════════════════════════════════════════════

  /** Conversion-rate ceiling — mirrors the tenant Settings panel's fat-finger guard. */
  private static readonly MAX_CONVERSION_RATE = 100000;

  /**
   * The client-detail page edits a tenant the operator is NOT assumed into, so the
   * caller-scoped `/v1/admin/settings/*` endpoints (which key off `user.clientId`)
   * can't target it. This builds a payload that re-points those SAME service methods
   * at the target tenant `slug` while preserving the operator's `sub` for audit
   * attribution. Only ever used with a GIFSY_ADMIN caller (assertGifsy gates entry).
   */
  private targetedPayload(user: JwtPayload, slug: string): JwtPayload {
    return { ...user, clientId: slug };
  }

  /** Confirm the target tenant exists (404 otherwise) — shared by GET + PUT. */
  private async assertClientExists(slug: string): Promise<void> {
    const client = await this.prisma.client.findUnique({
      where: { id: slug },
      select: { id: true },
    });
    if (!client) throw new NotFoundException(`Client "${slug}" not found.`);
  }

  /**
   * GET /v1/gifsy/clients/:slug/wallet-settings — the target tenant's REAL wallet
   * money settings, read from the same stores the money path enforces:
   *   - conversionRate / minBankTransferAmount / minVoucherFreeAmount ← TenantSettingsService
   *     (program_settings overlaid on typed defaults)
   *   - pointsExpiryDays ← the active default PointExpiryConfig row (AdminCoreService)
   * GIFSY_ADMIN only.
   */
  async getWalletSettings(user: JwtPayload, slug: string) {
    this.assertGifsy(user);
    await this.assertClientExists(slug);

    const settings = await this.tenantSettings.getEffectiveSettings(slug);
    const { pointsExpiryDays } = await this.adminCore.getPointsExpiry(
      this.targetedPayload(user, slug),
    );

    return {
      slug,
      conversionRate: settings.conversionRate,
      pointsExpiryDays,
      minBankTransferAmount: settings.minBankTransferAmount,
      minVoucherFreeAmount: settings.minVoucherFreeAmount,
    };
  }

  /**
   * PUT /v1/gifsy/clients/:slug/wallet-settings — write the target tenant's wallet
   * money settings by DELEGATING to the exact same service methods the tenant
   * Settings panel uses:
   *   - conversionRate / minBankTransferAmount / minVoucherFreeAmount → AdminCoreService.upsertSetting
   *     (program_settings upsert + audit + TenantSettingsService cache-bust)
   *   - pointsExpiryDays → AdminCoreService.setPointsExpiry (PointExpiryConfig default row)
   * No copy of the money logic lives here; the rate-freeze semantics (the money path
   * snapshots conversionRateCenti at order time) are preserved because the real write
   * is used. GIFSY_ADMIN only.
   *
   * Money-path validation (defence-in-depth over the DTO shape check):
   *   - conversionRate must be finite and within [MIN_RATE 0.005, 100000] — a 0/negative
   *     rate is a divide-by-zero in redemption math, and a sub-MIN_RATE rate is silently
   *     dropped by the read layer (a "save" that no-ops). Snapped to the centi grid the
   *     money path enforces so the stored/displayed rate can never drift from the enforced one.
   *   - the ₹ floors must be non-negative (also enforced by the DTO).
   */
  async updateWalletSettings(user: JwtPayload, slug: string, dto: UpdateWalletSettingsDto) {
    this.assertGifsy(user);
    await this.assertClientExists(slug);

    // ── Conversion rate — hard money-path validation ──
    const rate = dto.conversionRate;
    if (
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      rate < TenantSettingsService.MIN_RATE ||
      rate > GifsyService.MAX_CONVERSION_RATE
    ) {
      throw new BadRequestException(
        `Conversion rate must be a number between ${TenantSettingsService.MIN_RATE} and ${GifsyService.MAX_CONVERSION_RATE} (1 = 1 point → ₹1).`,
      );
    }
    // Snap to the centi grid the money path snapshots (Math.round(rate*100)) so the
    // displayed/stored rate is exactly the rate redemptions will freeze — no drift.
    const snappedRate = Math.round(rate * 100) / 100;

    // ── ₹ floors — non-negative finite (belt-and-braces over the DTO @Min(0)) ──
    for (const [label, v] of [
      ['minBankTransferAmount', dto.minBankTransferAmount],
      ['minVoucherFreeAmount', dto.minVoucherFreeAmount],
    ] as const) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new BadRequestException(`${label} must be a non-negative number.`);
      }
    }

    // ── Points expiry — null (never expire) OR a positive integer of days.
    // Service-level guard matching the money fields above; without it, a 0 would
    // slip past as `expiryDays: 0` (instant expiry) if the DTO were ever bypassed.
    const expiry = dto.pointsExpiryDays;
    if (
      expiry !== null &&
      (typeof expiry !== 'number' || !Number.isInteger(expiry) || expiry < 1 || expiry > 36500)
    ) {
      throw new BadRequestException(
        'pointsExpiryDays must be null (never expire) or an integer between 1 and 36500.',
      );
    }

    const targeted = this.targetedPayload(user, slug);

    // Delegate each write to the REAL settings service (same store, audit, cache-bust).
    // No `category` — byte-identical to the tenant Settings panel's saveGifsySettings
    // path (which PUTs { key, value }), so the same key can't be created with divergent
    // metadata depending on which UI wrote first.
    await this.adminCore.upsertSetting(targeted, {
      key: 'conversionRate',
      value: snappedRate,
    });
    await this.adminCore.upsertSetting(targeted, {
      key: 'minBankTransferAmount',
      value: dto.minBankTransferAmount,
    });
    await this.adminCore.upsertSetting(targeted, {
      key: 'minVoucherFreeAmount',
      value: dto.minVoucherFreeAmount,
    });
    // Points expiry via the PointExpiryConfig default-row write (null = never expire).
    await this.adminCore.setPointsExpiry(targeted, {
      pointsExpiryDays: dto.pointsExpiryDays,
    });

    // Return the freshly-read authoritative values (cache was busted by upsertSetting).
    return this.getWalletSettings(user, slug);
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
   * Validate one domain's SHAPE + POLICY (not uniqueness). Throws
   * BadRequestException on a malformed hostname, a non-`.gifsy.in` domain, or a
   * reserved first label. Input is assumed already normalised (lower-cased).
   */
  private validateDomainFormat(domain: string): void {
    if (!HOSTNAME_RE.test(domain)) {
      throw new BadRequestException(`"${domain}" is not a valid hostname.`);
    }
    if (!domain.endsWith(TENANT_DOMAIN_SUFFIX)) {
      throw new BadRequestException(
        `Domain "${domain}" must be a subdomain of ${TENANT_DOMAIN_SUFFIX.slice(1)}.`,
      );
    }
    const firstLabel = domain.split('.')[0];
    if (RESERVED_DOMAIN_LABELS.has(firstLabel)) {
      throw new BadRequestException(
        `"${firstLabel}" is a reserved subdomain and cannot be assigned to a tenant.`,
      );
    }
  }

  /**
   * Validate + reconcile a tenant's custom-domain set inside a transaction.
   *
   * Steps: normalise (lower-case/trim) + dedupe → per-domain format/policy check →
   * GLOBAL cross-tenant uniqueness (case-insensitive; a domain maps to exactly one
   * tenant platform-wide) → reconcile the stored rows to match the input (delete
   * removed, create added, preserving existing rows) → guarantee EXACTLY ONE
   * primary. The unique-index race (two tenants claiming one domain concurrently)
   * surfaces as P2002 → re-wrapped as ConflictException.
   */
  private async validateAndWriteDomains(
    tx: Prisma.TransactionClient,
    clientId: string,
    rawDomains: string[],
  ): Promise<void> {
    // Normalise + dedupe (preserve first-seen order for primary selection).
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const raw of rawDomains) {
      const d = (raw ?? '').trim().toLowerCase();
      if (!d) continue;
      this.validateDomainFormat(d);
      if (!seen.has(d)) {
        seen.add(d);
        domains.push(d);
      }
    }

    // GLOBAL uniqueness: a domain may not belong to a DIFFERENT tenant. Prisma
    // can't express LOWER() in a where, so match case-insensitively.
    for (const d of domains) {
      const clash = await tx.clientDomain.findFirst({
        where: {
          domain: { equals: d, mode: 'insensitive' },
          clientId: { not: clientId },
        },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(`Domain ${d} is already assigned to another tenant`);
      }
    }

    // Reconcile: delete removed, create added — keep untouched rows (so isPrimary
    // survives across a PATCH that doesn't reorder).
    const existing = await tx.clientDomain.findMany({ where: { clientId } });
    const existingByDomain = new Map(existing.map((r) => [r.domain.toLowerCase(), r]));
    const target = new Set(domains);

    const toDelete = existing.filter((r) => !target.has(r.domain.toLowerCase()));
    if (toDelete.length) {
      await tx.clientDomain.deleteMany({ where: { id: { in: toDelete.map((r) => r.id) } } });
    }

    for (const d of domains) {
      if (!existingByDomain.has(d)) {
        try {
          await tx.clientDomain.create({ data: { clientId, domain: d, isPrimary: false } });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException(`Domain ${d} is already assigned to another tenant`);
          }
          throw e;
        }
      }
    }

    await this.ensureExactlyOnePrimary(tx, clientId, domains);
  }

  /**
   * Guarantee a client's domain rows have EXACTLY ONE primary. Preference order:
   * an existing primary (if still present) → the canonical `<slug>.gifsy.in` →
   * the first domain in the supplied order → the first row. Everyone else is
   * demoted. No-op for a client with zero domains.
   */
  private async ensureExactlyOnePrimary(
    tx: Prisma.TransactionClient,
    clientId: string,
    orderedDomains: string[],
  ): Promise<void> {
    const rows = await tx.clientDomain.findMany({ where: { clientId } });
    if (rows.length === 0) return;

    const canonical = `${clientId}${TENANT_DOMAIN_SUFFIX}`;
    // First explicitly-supplied domain in input order (skip the canonical, which
    // create/update append). A branded domain, when supplied, should be primary —
    // mirroring the Deoleo backfill where `deoleoloyalty.gifsy.in` is primary.
    const firstBranded = orderedDomains.find((d) => d.toLowerCase() !== canonical);
    const winner =
      rows.find((r) => r.isPrimary) ??
      (firstBranded ? rows.find((r) => r.domain.toLowerCase() === firstBranded) : undefined) ??
      rows.find((r) => r.domain.toLowerCase() === canonical) ??
      rows[0];

    for (const r of rows) {
      const shouldBePrimary = r.id === winner.id;
      if (r.isPrimary !== shouldBePrimary) {
        await tx.clientDomain.update({
          where: { id: r.id },
          data: { isPrimary: shouldBePrimary },
        });
      }
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
    // Reserved slugs are a SUPERSET of the reserved DOMAIN labels: a slug seeds the
    // canonical `<slug>.gifsy.in` domain, so a slug like `status`/`mail`/`uat` (domain-
    // reserved but not slug-reserved) would fail deep inside the create transaction with
    // a confusing 400 rollback. Reject it cleanly up front instead.
    const slugLc = dto.slug.toLowerCase();
    if (RESERVED_CLIENT_SLUGS.has(slugLc) || RESERVED_DOMAIN_LABELS.has(slugLc)) {
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

        // Always seed the canonical `<slug>.gifsy.in` (deduped against any
        // explicitly-supplied domains) so a new tenant is immediately routable.
        const canonical = `${created.id}${TENANT_DOMAIN_SUFFIX}`;
        await this.validateAndWriteDomains(tx, created.id, [
          ...(dto.domains ?? []),
          canonical,
        ]);

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

    // Bust the resolveClient cache so the new tenant's features/status resolve
    // immediately rather than after the 5-min TTL.
    this.tenant.invalidateCache(client.id);

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
      'logoUrl',
      'wordmarkWhiteUrl',
      'wordmarkColorUrl',
      'faviconUrl',
      'productBrands',
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

    // Notifications: deep-merge the provided keys over the existing blob. The
    // nested `templateIds` is itself deep-merged so unspecified template ids —
    // and any msg91-related keys already on the row — are never dropped. No
    // WhatsApp send path is touched; this is persistence only.
    if (dto.notifications !== undefined) {
      const existingNotif = (existing.notifications ?? {}) as Record<string, unknown>;
      const incoming = dto.notifications as Record<string, unknown>;
      const notifications: Record<string, unknown> = { ...existingNotif, ...incoming };
      const incomingTemplateIds = incoming.templateIds;
      if (
        incomingTemplateIds &&
        typeof incomingTemplateIds === 'object' &&
        !Array.isArray(incomingTemplateIds)
      ) {
        notifications.templateIds = {
          ...((existingNotif.templateIds as Record<string, unknown>) ?? {}),
          ...(incomingTemplateIds as Record<string, unknown>),
        };
      }
      data.notifications = notifications as Prisma.InputJsonValue;
    }

    // Domains reconcile needs a transaction (multi-row delete/create + primary
    // invariant); the scalar/JSON update rides in the same tx so a domain clash
    // rolls the whole PATCH back. Without domains, keep the plain single update.
    const client =
      dto.domains !== undefined
        ? await this.prisma.$transaction(async (tx) => {
            const updated = await tx.client.update({ where: { id: slug }, data });
            // Always keep the canonical `<slug>.gifsy.in` in the set so a PATCH can
            // never leave a tenant with zero domains (unroutable). Deduped downstream.
            const canonical = `${slug}${TENANT_DOMAIN_SUFFIX}`;
            await this.validateAndWriteDomains(tx, slug, [...dto.domains!, canonical]);
            return updated;
          })
        : await this.prisma.client.update({ where: { id: slug }, data });

    // Bust the resolveClient cache so an edited feature flag / status / branding
    // takes effect immediately rather than after the 5-min TTL.
    this.tenant.invalidateCache(slug);

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
   * POST /v1/gifsy/clients/:slug/branding-asset — upload a branding image (logo /
   * white wordmark / colour wordmark / favicon) to object storage and persist its
   * URL onto the client's branding blob. GIFSY_ADMIN only.
   *
   * Safety mirrors the KYC document upload (AF-10): null/empty check, 5 MB cap, and
   * a magic-byte sniff — but here the allowlist is IMAGES ONLY, so a PDF (valid for
   * KYC) as well as any SVG/HTML/script masquerade is rejected. Persistence flows
   * through updateClient so the URL rides the existing branding-merge path.
   */
  async uploadBrandingAsset(
    user: JwtPayload,
    slug: string,
    file: Express.Multer.File,
    kind: BrandingAssetKind,
  ): Promise<{ url: string }> {
    this.assertGifsy(user);

    const field = BRANDING_ASSET_FIELDS[kind];
    if (!field) {
      throw new BadRequestException(`Unknown branding asset kind "${kind}".`);
    }

    const existing = await this.prisma.client.findFirst({ where: { id: slug } });
    if (!existing) {
      throw new NotFoundException('Client not found');
    }

    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.buffer?.length) throw new BadRequestException('Empty file');

    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a logo/favicon is far smaller
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File too large (max 5 MB)');
    }

    // Untrusted client mimetype: derive the REAL type from the bytes and require
    // an image (rejects PDF, and any SVG/HTML/script payload labelled image/*).
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed || !sniffed.mime.startsWith('image/')) {
      throw new BadRequestException(
        'Unsupported or corrupt file. Upload a PNG, JPG, WEBP, or GIF image.',
      );
    }

    const key = this.storage.generateKey(
      `branding/${slug}`,
      file.originalname || `${kind}.${sniffed.ext}`,
    );
    const url = await this.storage.uploadFile(file.buffer, key, sniffed.mime);

    // Persist through the existing branding-merge update path.
    await this.updateClient(user, slug, { [field]: url } as UpdateClientDto);

    return { url };
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

    // Custom domains ordered primary-first (then alphabetical) so the console
    // edit form can display the set and highlight the routable primary.
    const domainRows = await this.prisma.clientDomain.findMany({
      where: { clientId: slug },
      orderBy: [{ isPrimary: 'desc' }, { domain: 'asc' }],
    });
    const domains = domainRows.map((r) => r.domain);

    return {
      slug: c.id,
      internalName: c.internalName,
      status: c.status,
      onboardedAt: c.onboardedAt,

      domains,

      branding: {
        displayName: (branding.displayName as string) ?? c.internalName,
        primaryColor: (branding.primaryColor as string) ?? '#6b7280',
        logoUrl: (branding.logoUrl as string) ?? '',
        wordmarkWhiteUrl: (branding.wordmarkWhiteUrl as string) ?? '',
        wordmarkColorUrl: (branding.wordmarkColorUrl as string) ?? '',
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
