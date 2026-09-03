import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GiftApprovalPolicy, Prisma, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventKey } from '../notification-templates/notification-templates.config';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { assertVendorPriceBounds, VendorPriceError } from './vendor-pricing.helper';
import { applyVendorPiiRetention } from './vendor-pii.helper';
import {
  parseVendorUploadBuffer,
  buildVendorUploadTemplateBuffer,
} from './vendor-catalogue-upload.helper';
import {
  VendorCreateCatalogueDto,
  VendorFulfilmentDto,
  VendorTransitionDto,
  VendorUpdateCatalogueDto,
} from './dto/vendor.dto';

/** Resolved vendor identity for a request — the HARD scope on every query. */
interface VendorScope {
  vendorId: string;
  clientId: string;
  approvalPolicy: GiftApprovalPolicy;
  vendorName: string;
  vendorStatus: string;
}

/**
 * Order fields a vendor is allowed to see — its OWN orders + the delivery
 * name/address/phone it needs to ship (decision #15) + fulfilment fields. It
 * DELIBERATELY excludes the member's wider record (wallet, points, other orders) and
 * the frozen valuePaise (194R/cost basis) — scope-level minimisation (decision #15).
 */
const VENDOR_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  redemptionMode: true,
  quantity: true,
  fulfilmentChannel: true,
  logisticsPartner: true,
  supplierOrderRef: true,
  trackingNumber: true,
  trackingUrl: true,
  voucherCode: true,
  voucherProvider: true,
  podUrl: true,
  dispatchedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  deliveryName: true,
  deliveryPhone: true,
  deliveryAddressLine1: true,
  deliveryAddressLine2: true,
  deliveryCity: true,
  deliveryState: true,
  deliveryPincode: true,
  reward: { select: { id: true, name: true, imageUrls: true } },
  // Terminal transitions ONLY — the STABLE retention-clock source (vendor-pii MED#4).
  statusHistory: {
    where: {
      toStatus: {
        in: [RedemptionStatus.DELIVERED, RedemptionStatus.CANCELLED, RedemptionStatus.FAILED],
      },
    },
    select: { toStatus: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.RedemptionOrderSelect;

/** The raw vendor order row shape (VENDOR_ORDER_SELECT projection). */
type VendorOrderRow = Prisma.RedemptionOrderGetPayload<{ select: typeof VENDOR_ORDER_SELECT }>;
/** The same row AFTER {@link applyVendorPiiRetention} (adds `piiWithheld`; nulls PII when withheld). */
type VendorOrderRowRetained = VendorOrderRow & { piiWithheld: boolean };

/**
 * Terminal (closed) order states. A vendor may neither transition NOR patch fulfilment on
 * an order in one of these states (Wave-2 audit MED#4b) — this also keeps `updatedAt` from
 * being bumped on a terminal order, which the PII retention clock relies on.
 */
const VENDOR_TERMINAL_STATUSES: RedemptionStatus[] = [
  RedemptionStatus.DELIVERED,
  RedemptionStatus.RETURNED,
  RedemptionStatus.FAILED,
  RedemptionStatus.CANCELLED,
];

/**
 * VENDOR PORTAL (Gift Catalogue & Dispatch, Wave 2) — /v1/vendor/*.
 *
 * HARD-scoped at the DATA BOUNDARY by BOTH `user.vendorId` AND `user.clientId` on EVERY
 * query — a vendor never sees another vendor's or another tenant's data. `resolveScope`
 * additionally re-checks (on EVERY request) that the vendor is ACTIVE and holds an
 * ACTIVE grant for its tenant, so a suspend/revoke takes effect immediately on the
 * portal side (independent of the token TTL). Vendor transitions NEVER touch the wallet
 * (review CRITICAL #4): the restricted edge map excludes every refund edge.
 */
@Injectable()
export class VendorPortalService {
  private readonly logger = new Logger(VendorPortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Resolve + AUTHORIZE the vendor scope for this request. Throws Forbidden unless the
   * caller is a VENDOR whose Vendor is ACTIVE and holds an ACTIVE grant for its pinned
   * clientId (deny-by-default). This is the immediate suspend/revoke enforcement.
   */
  private async resolveScope(user: JwtPayload): Promise<VendorScope> {
    if (user.role !== 'VENDOR' || !user.vendorId) {
      throw new ForbiddenException('Vendor portal is for vendor logins only');
    }
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: user.vendorId },
      select: { id: true, name: true, status: true },
    });
    if (!vendor || vendor.status !== 'ACTIVE') {
      throw new ForbiddenException('This vendor account is suspended');
    }
    const grant = await this.prisma.vendorTenantGrant.findFirst({
      where: { vendorId: user.vendorId, clientId: user.clientId, status: 'ACTIVE' },
      select: { approvalPolicy: true },
    });
    if (!grant) {
      throw new ForbiddenException('This vendor is not authorised for this brand');
    }
    return {
      vendorId: vendor.id,
      clientId: user.clientId,
      approvalPolicy: grant.approvalPolicy,
      vendorName: vendor.name,
      vendorStatus: vendor.status,
    };
  }

  /** Points from a ₹ selling price. value(₹) = points ÷ rate, so points = ₹ × rate. */
  private derivePointsCost(sellingValuePaise: number, rate: number): number {
    if (!rate || rate <= 0) return 0;
    return Math.round((sellingValuePaise / 100) * rate);
  }

  /** AUTO_LIVE → APPROVED; every other policy requires approval → PENDING (v1). */
  private moderationFor(policy: GiftApprovalPolicy): 'APPROVED' | 'PENDING' {
    return policy === GiftApprovalPolicy.AUTO_LIVE ? 'APPROVED' : 'PENDING';
  }

  private assertPrice(sellingValuePaise: number | null | undefined, mrpPaise: number | null | undefined) {
    try {
      assertVendorPriceBounds({ sellingValuePaise, mrpPaise });
    } catch (e) {
      if (e instanceof VendorPriceError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Mirror a platform GiftCategory into a per-tenant RewardCategory (matched by code). */
  private async ensureTenantRewardCategory(
    clientId: string,
    giftCat: { code: string; name: string; imageUrl: string | null; sortOrder: number },
  ): Promise<string> {
    const existing = await this.prisma.rewardCategory.findFirst({
      where: { clientId, code: giftCat.code },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.rewardCategory.create({
      data: {
        clientId,
        code: giftCat.code,
        name: giftCat.name,
        imageUrl: giftCat.imageUrl,
        sortOrder: giftCat.sortOrder,
        isActive: true,
      },
      select: { id: true },
    });
    return created.id;
  }

  private async uniqueVendorCode(clientId: string, vendorId: string): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = `VEN-${vendorId.slice(-4)}-${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`.toUpperCase();
      const clash = await this.prisma.rewardCatalog.findFirst({
        where: { clientId, code, deletedAt: null },
        select: { id: true },
      });
      if (!clash) return code;
    }
    throw new ConflictException('Could not allocate a unique item code — please retry');
  }

  // ── GET /vendor/me ────────────────────────────────────────────────────────────
  async getMe(user: JwtPayload) {
    const scope = await this.resolveScope(user);
    return {
      vendor: { id: scope.vendorId, name: scope.vendorName, status: scope.vendorStatus },
      clientId: scope.clientId,
      approvalPolicy: scope.approvalPolicy,
    };
  }

  // ── Categories ────────────────────────────────────────────────────────────────
  /**
   * GET /vendor/categories — the shared platform GiftCategory taxonomy (decision #3),
   * the vendor item-category picker. resolveScope AUTHORIZES the caller (VENDOR + ACTIVE
   * vendor + ACTIVE grant) first; the taxonomy itself is platform-shared (not tenant
   * data), so there is no cross-tenant leak — only active categories are returned.
   */
  async listCategories(user: JwtPayload) {
    await this.resolveScope(user);
    const items = await this.prisma.giftCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        parentId: true,
        code: true,
        name: true,
        imageUrl: true,
        sortOrder: true,
        // CONTRACT: the FE GiftCategory type carries `isActive`, and the vendor item
        // editor's category picker filters on it. This endpoint already returns
        // active-only rows, so isActive is always true here — but it MUST be present
        // in the payload, or the FE reads `undefined` (falsy) and filters EVERY
        // category out, leaving the picker empty despite categories existing.
        isActive: true,
      },
    });
    return { items };
  }

  /**
   * GET /vendor/catalogue/template — the blank xlsx bulk-upload template. resolveScope
   * AUTHORIZES the caller; the template is a static header layout (no tenant data).
   */
  async getCatalogueTemplate(user: JwtPayload): Promise<Buffer> {
    await this.resolveScope(user);
    return buildVendorUploadTemplateBuffer();
  }

  // ── Catalogue ───────────────────────────────────────────────────────────────
  async listCatalogue(user: JwtPayload) {
    const scope = await this.resolveScope(user);
    const items = await this.prisma.rewardCatalog.findMany({
      where: {
        sourceType: 'VENDOR',
        vendorId: scope.vendorId,
        clientId: scope.clientId,
        deletedAt: null,
      },
      include: { giftCategory: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { items: items.map((i) => this.toVendorCatalogueRow(i)) };
  }

  private toVendorCatalogueRow(i: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    imageUrls: unknown;
    pointsCost: number;
    sellingValuePaise: number | null;
    mrpPaise: number | null;
    redemptionMode: unknown;
    status: unknown;
    moderationStatus: unknown;
    moderationReason: string | null;
    stockQuantity: number | null;
    metadata: unknown;
    giftCategoryId: string | null;
    giftCategory?: { id: string; name: string } | null;
  }) {
    const meta = (i.metadata as { fulfilmentChannel?: string } | null) ?? null;
    return {
      id: i.id,
      code: i.code,
      name: i.name,
      description: i.description ?? '',
      imageUrls: Array.isArray(i.imageUrls) ? i.imageUrls : [],
      pointsCost: i.pointsCost,
      sellingValuePaise: i.sellingValuePaise,
      mrpPaise: i.mrpPaise,
      redemptionMode: i.redemptionMode,
      fulfilmentChannel: meta?.fulfilmentChannel ?? null,
      status: i.status,
      moderationStatus: i.moderationStatus,
      moderationReason: i.moderationReason,
      stockQuantity: i.stockQuantity,
      categoryId: i.giftCategoryId,
      categoryName: i.giftCategory?.name ?? null,
    };
  }

  async createCatalogue(user: JwtPayload, dto: VendorCreateCatalogueDto) {
    const scope = await this.resolveScope(user);
    // Price bounds ALWAYS (even under AUTO_LIVE) — a mis-price inflates the outlet's 194R.
    this.assertPrice(dto.sellingValuePaise, dto.mrpPaise);

    const giftCat = await this.prisma.giftCategory.findFirst({
      where: { id: dto.categoryId, isActive: true },
    });
    if (!giftCat) throw new BadRequestException('Gift category not found');

    const rewardCategoryId = await this.ensureTenantRewardCategory(scope.clientId, giftCat);
    const rate = await this.tenantSettings.getConversionRate(scope.clientId);
    const pointsCost = this.derivePointsCost(dto.sellingValuePaise, rate);
    const moderationStatus = this.moderationFor(scope.approvalPolicy);
    const status = dto.stockQuantity === 0 ? 'OUT_OF_STOCK' : 'ACTIVE';
    const code = await this.uniqueVendorCode(scope.clientId, scope.vendorId);

    const created = await this.prisma.rewardCatalog.create({
      data: {
        clientId: scope.clientId,
        categoryId: rewardCategoryId,
        giftCategoryId: dto.categoryId,
        sourceType: 'VENDOR',
        vendorId: scope.vendorId,
        code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        pointsCost,
        sellingValuePaise: dto.sellingValuePaise,
        mrpPaise: dto.mrpPaise,
        redemptionMode: dto.redemptionMode,
        stockQuantity: dto.stockQuantity,
        status,
        moderationStatus,
        metadata: { fulfilmentChannel: dto.fulfilmentChannel } as Prisma.InputJsonValue,
      },
      include: { giftCategory: { select: { id: true, name: true } } },
    });
    await this.audit(user, scope, 'CREATE', created.id, {
      sellingValuePaise: dto.sellingValuePaise,
      moderationStatus,
    });
    return this.toVendorCatalogueRow(created);
  }

  async updateCatalogue(user: JwtPayload, id: string, dto: VendorUpdateCatalogueDto) {
    const scope = await this.resolveScope(user);
    const existing = await this.prisma.rewardCatalog.findFirst({
      where: { id, sourceType: 'VENDOR', vendorId: scope.vendorId, clientId: scope.clientId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Catalogue item not found');

    // Re-validate price bounds whenever either price side is touched (uses the NEW value
    // where supplied, else the stored one) — bounds hold even under AUTO_LIVE.
    if (dto.sellingValuePaise !== undefined || dto.mrpPaise !== undefined) {
      this.assertPrice(
        dto.sellingValuePaise ?? existing.sellingValuePaise,
        dto.mrpPaise ?? existing.mrpPaise,
      );
    }

    const data: Prisma.RewardCatalogUpdateInput = {
      name: dto.name,
      description: dto.description,
      imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
      sellingValuePaise: dto.sellingValuePaise,
      mrpPaise: dto.mrpPaise,
      redemptionMode: dto.redemptionMode,
      stockQuantity: dto.stockQuantity,
      status: dto.status,
    };

    // Category change → re-map the mirrored RewardCategory + shared taxonomy link.
    if (dto.categoryId !== undefined && dto.categoryId !== existing.giftCategoryId) {
      const giftCat = await this.prisma.giftCategory.findFirst({
        where: { id: dto.categoryId, isActive: true },
      });
      if (!giftCat) throw new BadRequestException('Gift category not found');
      data.giftCategory = { connect: { id: dto.categoryId } };
      data.category = { connect: { id: await this.ensureTenantRewardCategory(scope.clientId, giftCat) } };
    }

    // Re-price pointsCost when the selling value changes (rate at edit time).
    if (dto.sellingValuePaise !== undefined) {
      const rate = await this.tenantSettings.getConversionRate(scope.clientId);
      data.pointsCost = this.derivePointsCost(dto.sellingValuePaise, rate);
    }

    // fulfilmentChannel lives in metadata → merge.
    if (dto.fulfilmentChannel !== undefined) {
      const meta = (existing.metadata as Record<string, unknown> | null) ?? {};
      data.metadata = { ...meta, fulfilmentChannel: dto.fulfilmentChannel } as Prisma.InputJsonValue;
    }

    // RE-MODERATION (review #9): a MATERIAL edit (sellingValue / name / images /
    // category) of an item under a NON-AUTO policy resets moderation → PENDING, which
    // drops it from the member catalogue (filter requires APPROVED) until re-approved.
    // Under AUTO_LIVE the item stays live (auto policy).
    const materialEdit =
      (dto.sellingValuePaise !== undefined && dto.sellingValuePaise !== existing.sellingValuePaise) ||
      (dto.name !== undefined && dto.name !== existing.name) ||
      dto.imageUrls !== undefined ||
      (dto.categoryId !== undefined && dto.categoryId !== existing.giftCategoryId);
    if (materialEdit && scope.approvalPolicy !== GiftApprovalPolicy.AUTO_LIVE) {
      data.moderationStatus = 'PENDING';
      data.moderationByUserId = null;
      data.moderatedAt = null;
      data.moderationReason = null;
    }

    const updated = await this.prisma.rewardCatalog.update({
      where: { id },
      data,
      include: { giftCategory: { select: { id: true, name: true } } },
    });
    await this.audit(user, scope, 'UPDATE', id, {
      before: { sellingValuePaise: existing.sellingValuePaise },
      after: { sellingValuePaise: updated.sellingValuePaise },
      reModerated: materialEdit && scope.approvalPolicy !== GiftApprovalPolicy.AUTO_LIVE,
    });
    return this.toVendorCatalogueRow(updated);
  }

  /** POST /vendor/catalogue/upload — Excel bulk create (same price + moderation rules). */
  async uploadCatalogue(user: JwtPayload, file: Express.Multer.File) {
    const scope = await this.resolveScope(user);
    if (!file?.buffer) throw new BadRequestException('No file uploaded');

    let parsed: ReturnType<typeof parseVendorUploadBuffer>;
    try {
      parsed = parseVendorUploadBuffer(file.buffer);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Could not parse the upload');
    }
    if (parsed.rows.length === 0) {
      throw new BadRequestException('The upload has no data rows');
    }

    const rate = await this.tenantSettings.getConversionRate(scope.clientId);
    const moderationStatus = this.moderationFor(scope.approvalPolicy);
    const results: Array<{ rowIndex: number; created?: string; error?: string }> = [];

    for (const row of parsed.rows) {
      try {
        if (!row.name) throw new Error('Name is required');
        if (!row.categoryCode) throw new Error('Category Code is required');
        if (!row.redemptionMode) throw new Error('Redemption Mode is required');
        if (!row.fulfilmentChannel) throw new Error('Fulfilment Channel is required');
        // Same server-side price bounds as the single-create path.
        assertVendorPriceBounds({ sellingValuePaise: row.sellingValuePaise, mrpPaise: row.mrpPaise });

        const giftCat = await this.prisma.giftCategory.findFirst({
          where: { code: row.categoryCode, isActive: true },
        });
        if (!giftCat) throw new Error(`Unknown category code "${row.categoryCode}"`);

        const rewardCategoryId = await this.ensureTenantRewardCategory(scope.clientId, giftCat);
        const code = await this.uniqueVendorCode(scope.clientId, scope.vendorId);
        const created = await this.prisma.rewardCatalog.create({
          data: {
            clientId: scope.clientId,
            categoryId: rewardCategoryId,
            giftCategoryId: giftCat.id,
            sourceType: 'VENDOR',
            vendorId: scope.vendorId,
            code,
            name: row.name,
            description: row.description,
            imageUrls: row.imageUrls as Prisma.InputJsonValue,
            pointsCost: this.derivePointsCost(row.sellingValuePaise as number, rate),
            sellingValuePaise: row.sellingValuePaise,
            mrpPaise: row.mrpPaise,
            redemptionMode: row.redemptionMode as never,
            stockQuantity: row.stockQuantity,
            status: row.stockQuantity === 0 ? 'OUT_OF_STOCK' : 'ACTIVE',
            moderationStatus,
            metadata: { fulfilmentChannel: row.fulfilmentChannel } as Prisma.InputJsonValue,
          },
        });
        results.push({ rowIndex: row.rowIndex, created: created.id });
      } catch (e) {
        results.push({ rowIndex: row.rowIndex, error: e instanceof Error ? e.message : 'Row failed' });
      }
    }

    return {
      total: parsed.rows.length,
      created: results.filter((r) => r.created).length,
      failed: results.filter((r) => r.error).length,
      moderationStatus,
      results,
    };
  }

  // ── Orders ────────────────────────────────────────────────────────────────────
  /**
   * Map a RETENTION-APPLIED vendor order row into the DISPLAY shape the vendor FE consumes
   * (the same `delivery.{name,address,phone}` / `rewardName` contract the Gifsy console
   * uses — see `getFulfilmentOrder` in rewards.service). The `delivery` block is composed
   * from the retention-applied fields, so once the retention window has elapsed those
   * fields are already null and `delivery` comes out null (FE shows the withheld message).
   *
   * PRIVACY INVARIANT (decision #15): this DELIBERATELY OMITS the 194R cost basis —
   * `valuePaise`, `pointsDeducted`, `totalPointsCost`, `sellingValuePaise`, `metadata`,
   * `sourceType`, `moderationStatus`. The console mapper emits `valuePaise`; the vendor
   * view must NOT. (VENDOR_ORDER_SELECT already never selects those columns; this mapper
   * is the second line of defence so no future select-widening leaks them.)
   */
  private toVendorOrderView(row: VendorOrderRowRetained) {
    const address = [
      row.deliveryAddressLine1,
      row.deliveryAddressLine2,
      row.deliveryCity,
      row.deliveryState,
      row.deliveryPincode,
    ]
      .filter(Boolean)
      .join(', ');
    const delivery =
      row.deliveryName || address || row.deliveryPhone
        ? {
            name: row.deliveryName ?? null,
            address: address || null,
            phone: row.deliveryPhone ?? null,
          }
        : null;
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      redemptionMode: row.redemptionMode,
      quantity: row.quantity,
      rewardName: row.reward?.name ?? null,
      fulfilmentChannel: row.fulfilmentChannel,
      logisticsPartner: row.logisticsPartner,
      supplierOrderRef: row.supplierOrderRef,
      trackingNumber: row.trackingNumber,
      trackingUrl: row.trackingUrl,
      voucherCode: row.voucherCode,
      voucherProvider: row.voucherProvider,
      podUrl: row.podUrl,
      delivery,
      piiWithheld: row.piiWithheld,
      dispatchedAt: row.dispatchedAt,
      deliveredAt: row.deliveredAt,
      cancelledAt: row.cancelledAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listOrders(user: JwtPayload) {
    const scope = await this.resolveScope(user);
    const orders = await this.prisma.redemptionOrder.findMany({
      // HARD scope: only THIS vendor's items' orders, in THIS tenant. A PENDING order is
      // pre-payment (pre-OTP-confirm) — the vendor must not see its PII until CONFIRMED
      // (Wave-2 audit LOW#6).
      where: {
        fulfilledByVendorId: scope.vendorId,
        partner: { clientId: scope.clientId },
        status: { not: RedemptionStatus.PENDING },
      },
      select: VENDOR_ORDER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    // Retention FIRST (nulls PII past the window), THEN map to the display shape so the
    // composed `delivery` block reflects the withheld state (decision #15/#16).
    return { items: orders.map((o) => this.toVendorOrderView(applyVendorPiiRetention(o, now))) };
  }

  async getOrder(user: JwtPayload, id: string) {
    const scope = await this.resolveScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      // PENDING (pre-payment) orders are hidden from the vendor (Wave-2 audit LOW#6).
      where: {
        id,
        fulfilledByVendorId: scope.vendorId,
        partner: { clientId: scope.clientId },
        status: { not: RedemptionStatus.PENDING },
      },
      select: VENDOR_ORDER_SELECT,
    });
    if (!order) throw new NotFoundException('Order not found');
    // Retention FIRST, THEN map to the display shape (delivery.{name,address,phone} +
    // rewardName), keeping the 194R cost basis out of the vendor payload (decision #15).
    return this.toVendorOrderView(applyVendorPiiRetention(order, new Date()));
  }

  /** PATCH /vendor/orders/:id/fulfilment — vendor-scoped NON-STATUS update. */
  async updateFulfilment(user: JwtPayload, id: string, dto: VendorFulfilmentDto) {
    const scope = await this.resolveScope(user);
    const existing = await this.prisma.redemptionOrder.findFirst({
      // Hidden while PENDING (pre-payment, LOW#6).
      where: {
        id,
        fulfilledByVendorId: scope.vendorId,
        partner: { clientId: scope.clientId },
        status: { not: RedemptionStatus.PENDING },
      },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Order not found');
    // A CLOSED order is immutable to the vendor (Wave-2 audit MED#4b) — this also stops a
    // PATCH from bumping `updatedAt` and restarting the PII retention clock.
    if (VENDOR_TERMINAL_STATUSES.includes(existing.status)) {
      throw new BadRequestException('This order is closed and can no longer be updated.');
    }

    await this.prisma.redemptionOrder.update({
      where: { id },
      data: {
        trackingNumber: dto.trackingNumber,
        trackingUrl: dto.trackingUrl,
        voucherCode: dto.voucherCode,
        voucherProvider: dto.voucherProvider,
        notes: dto.notes,
        fulfilmentChannel: dto.fulfilmentChannel,
        logisticsPartner: dto.logisticsPartner,
        supplierOrderRef: dto.supplierOrderRef,
        podUrl: dto.podUrl,
      },
    });
    return this.getOrder(user, id);
  }

  /**
   * POST /vendor/orders/:id/transition — RESTRICTED, wallet-free status move
   * (review CRITICAL #4). Only CONFIRMED→PROCESSING→DISPATCHED→DELIVERED; every
   * refund/reversal edge (CANCELLED/RETURNED/FAILED) is EXCLUDED and stays Gifsy-only.
   * NEVER touches points/valuePaise/wallet.
   */
  async transition(user: JwtPayload, id: string, dto: VendorTransitionDto) {
    const scope = await this.resolveScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      // Hidden while PENDING (pre-payment, LOW#6).
      where: {
        id,
        fulfilledByVendorId: scope.vendorId,
        partner: { clientId: scope.clientId },
        status: { not: RedemptionStatus.PENDING },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // A CLOSED order is immutable to the vendor (Wave-2 audit MED#4b).
    if (VENDOR_TERMINAL_STATUSES.includes(order.status)) {
      throw new BadRequestException('This order is closed and can no longer be updated.');
    }

    const toStatus = dto.toStatus as unknown as RedemptionStatus;
    if (order.status === toStatus) {
      // Idempotent no-op — return the MEMBER-SAFE projection (VENDOR_ORDER_SELECT +
      // retention), never the raw order (Wave-2 audit HIGH#1).
      return { order: await this.getOrder(user, id), skipped: true as const };
    }

    // RESTRICTED edge map — forward-only, NO wallet-touching edges.
    const allowed: Record<string, RedemptionStatus[]> = {
      CONFIRMED: [RedemptionStatus.PROCESSING],
      PROCESSING: [RedemptionStatus.DISPATCHED],
      DISPATCHED: [RedemptionStatus.DELIVERED],
    };
    const fromStatus = order.status;
    if (!(allowed[fromStatus] ?? []).includes(toStatus)) {
      throw new BadRequestException(
        `Vendors may only move an order PROCESSING → DISPATCHED → DELIVERED. Illegal: ${fromStatus} → ${toStatus}`,
      );
    }

    // BUG-1: a DIGITAL_VOUCHER order cannot be marked DELIVERED without a voucher code —
    // the member would have nothing to redeem. Check the EFFECTIVE channel/code (the value
    // arriving on this transition dto, else the one already stored). Mirrors the identical
    // guard in rewards.service transitionOrder.
    const effectiveChannel = dto.fulfilmentChannel ?? order.fulfilmentChannel;
    const effectiveVoucherCode = (dto.voucherCode ?? order.voucherCode ?? '').trim();
    if (
      toStatus === RedemptionStatus.DELIVERED &&
      effectiveChannel === 'DIGITAL_VOUCHER' &&
      !effectiveVoucherCode
    ) {
      throw new BadRequestException(
        'A voucher code is required before a digital voucher order can be marked delivered.',
      );
    }

    const now = new Date();
    const data: Prisma.RedemptionOrderUpdateInput = {
      status: toStatus,
      voucherCode: dto.voucherCode,
      voucherProvider: dto.voucherProvider,
      trackingNumber: dto.trackingNumber,
      trackingUrl: dto.trackingUrl,
      notes: dto.notes,
      fulfilmentChannel: dto.fulfilmentChannel,
      logisticsPartner: dto.logisticsPartner,
      supplierOrderRef: dto.supplierOrderRef,
      podUrl: dto.podUrl,
    };
    if (toStatus === RedemptionStatus.DISPATCHED) data.dispatchedAt = now;
    if (toStatus === RedemptionStatus.DELIVERED) data.deliveredAt = now;

    await this.prisma.$transaction(async (tx) => {
      const o = await tx.redemptionOrder.update({ where: { id }, data });
      await tx.redemptionStatusHistory.create({
        data: { orderId: id, fromStatus, toStatus, changedById: user.sub, notes: dto.notes },
      });
      return o;
    });

    // Member notification on the customer-visible milestones (same path as Gifsy).
    if (toStatus === RedemptionStatus.DISPATCHED || toStatus === RedemptionStatus.DELIVERED) {
      const partner = await this.prisma.channelPartner.findFirst({
        where: { id: order.partnerId },
        select: { userId: true, phone: true, ownerName: true },
      });
      if (partner?.userId) {
        await this.notifications.notifyUserWithChannels({
          clientId: scope.clientId,
          userId: partner.userId,
          eventKey: `ORDER_${toStatus}` as EventKey,
          recipientPhone: partner.phone ?? null,
          vars: {
            ownerName: partner.ownerName ?? 'Partner',
            orderId: order.orderNumber,
            trackingId: dto.trackingNumber ?? '',
            reason: '',
          },
          subject: 'Redemption update',
          body: `Your redemption ${order.orderNumber} is now ${toStatus}.`,
          url: '/partner/rewards',
          event: `REDEMPTION_${toStatus}`,
        });
      }
    }

    await this.audit(user, scope, 'UPDATE', id, { event: 'TRANSITION', fromStatus, toStatus });
    // Return the MEMBER-SAFE projection (VENDOR_ORDER_SELECT + retention), never the raw
    // RedemptionOrder — it carries valuePaise/pointsDeducted/metadata etc. (Wave-2 audit HIGH#1).
    return { order: await this.getOrder(user, id) };
  }

  /** Every vendor write is audited with actor + vendor (review CRITICAL #2). */
  private async audit(
    user: JwtPayload,
    scope: VendorScope,
    action: 'CREATE' | 'UPDATE',
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          action,
          entityType: 'VENDOR_CATALOGUE',
          entityId,
          actorId: user.sub,
          metadata: { vendorId: scope.vendorId, clientId: scope.clientId, ...metadata },
        },
      })
      .catch((e) => this.logger.error(`vendor audit failed: ${e}`));
  }
}
