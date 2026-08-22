import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GiftFulfilmentChannel, PayoutMode, Prisma, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { generateNumericOtp } from '../common/otp';
import { ensureOutletAccount } from '../common/reward-account.helper';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { EventKey } from '../notification-templates/notification-templates.config';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveEffectiveKycStatus, isPartnerPayable } from '../kyc/kyc-eligibility';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { isGifsyOperator, tenantScope } from '../common/tenant-scope';
import { generateTenantOrderNumber } from './order-number.helper';
import { computeFrozenValuePaise } from './gift-value.helper';
import { computeDispatchSla } from '../common/dispatch-sla';
import { loadHolidaySet } from '../common/holiday-calendar';
import {
  AdminListCatalogQueryDto,
  CreateRewardCatalogDto,
  CreateRewardCategoryDto,
  FulfilmentOrdersQueryDto,
  FulfilmentTemplateQueryDto,
  ListCatalogQueryDto,
  ListOrdersQueryDto,
  RedeemConfirmDto,
  RedeemDto,
  SalesRedeemConfirmDto,
  SalesRedeemDto,
  TransitionOrderDto,
  UpdatableOrderStatus,
  UpdateOrderDto,
  UpdateRewardCatalogDto,
  UpdateRewardCategoryDto,
} from './dto/rewards.dto';
import {
  buildFulfilmentTemplateBuffer,
  parseFulfilmentUploadBuffer,
} from './rewards-fulfilment.helpers';

/**
 * Rewards & Redemption — ported from platform/src/app/api/rewards/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT); non-GIFSY callers
 * see/act on only their own partner's catalog affordability and orders. Business
 * logic lives here; the controller is a thin HTTP adapter.
 *
 * 5.4a CORE redemption pipeline (now ported): redeem → OTP confirm → guarded
 * fulfilment transition. The points debit/refund composes WalletService (which
 * owns the canonical wallet invariant + PointsLedger) inside this service's own
 * $transaction; the REDEMPTION_CONFIRM OTP reuses the OtpCode model; confirm +
 * status events enqueue via NotificationsService.
 */
/**
 * Default dispatch-SLA budget (BUSINESS hours) for self-fulfilled channels
 * (GIFSY_WAREHOUSE / BRAND). Amazon / DIGITAL_VOUCHER are exempt (see dispatch-sla.ts).
 * A single platform default in v1 — a per-channel/per-tenant config is a later addition.
 */
export const DISPATCH_SLA_BUSINESS_HOURS = 48;

/**
 * Member-safe RewardCatalog projection for the partner-facing catalogue reads
 * (listCatalog / getCatalogItem). Deliberately EXCLUDES ops/internal columns —
 * sellingValuePaise (194R/cost basis), sourceType, vendorId, giftMasterId,
 * giftCategoryId and the moderation* fields — that a member must never see.
 */
const MEMBER_CATALOG_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  imageUrls: true,
  pointsCost: true,
  mrpPaise: true,
  redemptionMode: true,
  status: true,
  minRedemptionPoints: true,
  maxRedemptionPoints: true,
  stockQuantity: true,
  termsAndConditions: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { name: true } },
} satisfies Prisma.RewardCatalogSelect;

/**
 * Member-safe RedemptionOrder projection for the partner-facing order reads
 * (listOrders / getOrder member path). EXCLUDES the ops-only fulfilment fields
 * (fulfilmentChannel, supplierOrderRef, fulfilledByVendorId, podUrl, notes) and the
 * BigInt valuePaise. partnerId is included for the caller-ownership authorization
 * check (it is the member's own partner, not an ops-only field).
 */
const MEMBER_ORDER_SELECT = {
  id: true,
  partnerId: true,
  orderNumber: true,
  status: true,
  redemptionMode: true,
  totalPointsCost: true,
  quantity: true,
  voucherCode: true,
  voucherProvider: true,
  trackingNumber: true,
  trackingUrl: true,
  logisticsPartner: true,
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
  reward: { select: { id: true, name: true, imageUrls: true, redemptionMode: true } },
  partner: { select: { id: true, businessName: true } },
} satisfies Prisma.RedemptionOrderSelect;

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
  ) {}

  private isGifsy(user: JwtPayload): boolean {
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    return isGifsyOperator(user);
  }

  /**
   * Data-boundary guard for the DISPATCH-CONSOLE-only reads (listFulfilmentOrders /
   * getFulfilmentOrder) — parity with GiftCatalogueService.assertOperator. The routes
   * are already @Roles('GIFSY_ADMIN') + @RequirePermission; this is defence-in-depth at
   * the service layer. NOT applied to the SHARED transitionOrder/updateOrder, which are
   * also reached by the legacy /rewards/orders GIFSY_ADMIN endpoints and the bulk
   * fulfilment upload — those keep their route-level gate to avoid over-constraining a
   * shared method.
   */
  private assertOperator(user: JwtPayload) {
    if (!isGifsyOperator(user)) {
      throw new ForbiddenException('Gift dispatch console is Gifsy-operator only');
    }
  }

  /** Map a redemption mode to the tenant channel toggle that governs it. */
  private channelKey(mode: PayoutMode): 'physicalGifts' | 'vouchers' | 'bankTransfer' {
    if (mode === 'PHYSICAL_GIFT') return 'physicalGifts';
    if (mode === 'UPI' || mode === 'BANK_TRANSFER') return 'bankTransfer';
    return 'vouchers'; // GIFT_CARD (the only remaining PayoutMode) maps to the voucher channel
  }

  /**
   * The points↔₹ centi-rate to use when freezing valuePaise at CONFIRM time.
   * Prefer the rate SNAPSHOT taken on the order at redeem (so an admin editing the
   * per-tenant rate between redeem and confirm cannot shift the TDS/payout value);
   * fall back to the live tenant rate for pre-migration orders (conversionRateCenti null).
   */
  private async confirmRateCenti(
    order: { conversionRateCenti: number | null },
    clientId: string,
  ): Promise<number> {
    if (order.conversionRateCenti != null && order.conversionRateCenti > 0) {
      return order.conversionRateCenti;
    }
    const live = await this.tenantSettings.getConversionRate(clientId);
    return Math.round(live * 100);
  }

  /** GET /v1/rewards/catalog — active catalog with per-item affordability vs the caller's wallet. */
  async listCatalog(user: JwtPayload, q: ListCatalogQueryDto, requestedPartnerId?: string) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.RewardCatalogWhereInput = {
      status: 'ACTIVE',
      deletedAt: null,
      clientId: user.clientId,
      // Gift Catalogue moderation gate (§4 / review): a PENDING/REJECTED/DRAFT item
      // must NEVER be browsable. Existing platform rows default APPROVED (live), so
      // Deoleo's catalogue is unchanged; vendor rows land PENDING until approved.
      moderationStatus: 'APPROVED',
      // WAVE-2 SEAM — vendor visibility cascade. When vendor items ship, add here
      // (for sourceType=VENDOR rows only): require Vendor.status=ACTIVE AND an ACTIVE
      // VendorTenantGrant for this clientId, so a suspended/revoked vendor's items
      // stop being browsable immediately (§12 suspend/revoke cascade). PLATFORM rows
      // are unaffected. e.g. OR:[ {sourceType:'PLATFORM'}, {sourceType:'VENDOR', vendor:{status:'ACTIVE'}, ...grant} ].
    };
    if (q.minPoints !== undefined || q.maxPoints !== undefined) {
      where.pointsCost = {};
      if (q.minPoints !== undefined) where.pointsCost.gte = q.minPoints;
      if (q.maxPoints !== undefined) where.pointsCost.lte = q.maxPoints;
    }

    // Affordability is measured against the ACTIVE partner's wallet (own by default,
    // or a switched sibling named by x-active-partner-id). resolveActive re-authorizes
    // the selector — a forbidden id throws before any balance is read.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    const wallet = activePartnerId
      ? await this.prisma.wallet.findFirst({ where: { partnerId: activePartnerId } })
      : null;
    const userBalance = wallet ? wallet.redeemablePoints : 0;

    const [items, total] = await Promise.all([
      this.prisma.rewardCatalog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { pointsCost: 'asc' },
        // Member-safe projection — drops ops/internal columns (sellingValuePaise,
        // sourceType, vendorId, giftMasterId, giftCategoryId, moderation*).
        select: MEMBER_CATALOG_SELECT,
      }),
      this.prisma.rewardCatalog.count({ where }),
    ]);

    const enriched = items.map((item) => {
      // Flatten the category relation to its label so the partner catalogue UI
      // can display/route by category (the FE expects a flat string, not the
      // nested relation the admin endpoint returns).
      const { category, ...rest } = item;
      return {
        ...rest,
        category: category?.name,
        isAffordable: userBalance >= item.pointsCost,
      };
    });

    return {
      items: enriched,
      userBalance,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/rewards/catalog/:id — a single active (non-deleted) catalog item in the tenant. */
  async getCatalogItem(user: JwtPayload, id: string, requestedPartnerId?: string) {
    const item = await this.prisma.rewardCatalog.findFirst({
      // Moderation gate: a non-APPROVED item is not viewable even by deep-link/stale
      // cart. status=ACTIVE parity with listCatalog — a DISCONTINUED/OUT_OF_STOCK/
      // INACTIVE row must not be deep-linkable. WAVE-2 SEAM: also require vendor ACTIVE
      // + ACTIVE grant for VENDOR rows.
      where: {
        id,
        deletedAt: null,
        clientId: user.clientId,
        status: 'ACTIVE',
        moderationStatus: 'APPROVED',
      },
      // Member-safe projection (same as listCatalog) — no ops/internal columns.
      select: MEMBER_CATALOG_SELECT,
    });
    if (!item) throw new NotFoundException('Reward item not found');
    // The item is tenant-scoped (not partner-scoped), so the response is identical
    // regardless of the active outlet. We still re-authorize the selector so a bogus
    // x-active-partner-id is rejected consistently across every rewards endpoint
    // (never silently accepted on one read) — validation only, result unchanged.
    await this.resolveActive(user, requestedPartnerId);
    return { item };
  }

  /** GET /v1/rewards/orders — paginated redemption orders (own only for non-admins). */
  async listOrders(user: JwtPayload, q: ListOrdersQueryDto, requestedPartnerId?: string) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    // Tenant scope by the partner's own clientId column (NOT partner.user.clientId):
    // a login-less sibling has no linked user, so a user-relation scope would hide
    // the switched sibling's orders. partner.clientId is authoritative for both.
    const where: Prisma.RedemptionOrderWhereInput = {
      partner: { clientId: user.clientId },
    };
    if (!this.isGifsy(user)) {
      // Non-admins see only the ACTIVE partner's orders (own by default, or a
      // switched sibling named by x-active-partner-id — re-authorized here).
      const activePartnerId = await this.resolveActive(user, requestedPartnerId);
      where.partnerId = activePartnerId ?? 'none';
    }
    if (q.status) where.status = q.status;

    // Member-safe projection (§ member view). Deliberately EXCLUDES the ops-only
    // fulfilment fields (fulfilmentChannel, supplierOrderRef, fulfilledByVendorId, POD)
    // and delivery PII, and never returns the BigInt valuePaise. logisticsPartner (the
    // courier name) IS member-safe and included. Also serves the legacy /admin/gifts
    // console, which reads a strict subset of these fields.
    const [orders, total] = await Promise.all([
      this.prisma.redemptionOrder.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          redemptionMode: true,
          totalPointsCost: true,
          quantity: true,
          voucherCode: true,
          voucherProvider: true,
          trackingNumber: true,
          trackingUrl: true,
          logisticsPartner: true,
          dispatchedAt: true,
          deliveredAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
          reward: { select: { id: true, name: true, imageUrls: true, redemptionMode: true } },
          partner: { select: { id: true, businessName: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.redemptionOrder.count({ where }),
    ]);

    // No dedicated returnedAt column — surface it (member-safe) when the order is RETURNED.
    const mapped = orders.map((o) => ({
      ...o,
      returnedAt: o.status === 'RETURNED' ? o.updatedAt : null,
    }));

    return {
      orders: mapped,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/rewards/orders/:id — one order; non-admins may only see their own. */
  async getOrder(user: JwtPayload, id: string, requestedPartnerId?: string) {
    // Tenant scope by partner.clientId so a switched sibling's order is visible
    // (a login-less sibling has no linked user → partner.user.clientId would miss it).
    const where = { id, partner: { clientId: user.clientId } };

    // A Gifsy operator may see the full ops detail (this same row is also reachable via
    // the dispatch console). A MEMBER gets the member-safe projection — the same one
    // listOrders uses — so ops-only fields (fulfilmentChannel, supplierOrderRef,
    // fulfilledByVendorId, podUrl, notes, valuePaise) never leak to the partner app.
    if (this.isGifsy(user)) {
      const order = await this.prisma.redemptionOrder.findFirst({
        where,
        include: {
          reward: true,
          partner: { select: { id: true, businessName: true, userId: true } },
        },
      });
      if (!order) throw new NotFoundException('Order not found');
      return { order };
    }

    const order = await this.prisma.redemptionOrder.findFirst({
      where,
      select: MEMBER_ORDER_SELECT,
    });
    if (!order) throw new NotFoundException('Order not found');

    // Non-admins can only see the ACTIVE partner's order. Authorization is the
    // resolved active partner (own or an authorized sibling) — NOT the raw login's
    // userId, which would 403 a legitimately-switched sibling (userId=null).
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    if (!activePartnerId || order.partnerId !== activePartnerId) {
      throw new ForbiddenException('Forbidden');
    }

    return { order };
  }

  /**
   * GET /v1/rewards/orders/:id/track — member ORDER TRACKING view (partner app).
   * Own order only (same scoping as getOrder): status + tracking + the dispatch
   * timeline. A trimmed, member-safe projection (no internal notes/actor ids) so a
   * partner can follow their gift from confirmation to delivery.
   */
  async trackOrder(user: JwtPayload, id: string, requestedPartnerId?: string) {
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, partner: { clientId: user.clientId } },
      include: {
        reward: { select: { id: true, name: true, imageUrls: true } },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          // Member-safe timeline: from/to status + timestamp only. Internal `notes`
          // are ops-only (can carry supplier/vendor context) and must NOT leak here.
          select: { fromStatus: true, toStatus: true, createdAt: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Non-admins may only track the ACTIVE partner's order (own or authorized sibling).
    if (!this.isGifsy(user)) {
      const activePartnerId = await this.resolveActive(user, requestedPartnerId);
      if (!activePartnerId || order.partnerId !== activePartnerId) {
        throw new ForbiddenException('Forbidden');
      }
    }

    // NOTE: `fulfilmentChannel` is an ops-only field and is deliberately NOT surfaced on
    // the member tracking payload (matches the docstring's member-safe promise).
    return {
      tracking: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        reward: order.reward,
        quantity: order.quantity,
        logisticsPartner: order.logisticsPartner,
        trackingNumber: order.trackingNumber,
        trackingUrl: order.trackingUrl,
        dispatchedAt: order.dispatchedAt,
        deliveredAt: order.deliveredAt,
        cancelledAt: order.cancelledAt,
        timeline: order.statusHistory,
      },
    };
  }

  /**
   * PATCH /v1/rewards/orders/:id — GIFSY-only NON-STATUS edits (tracking / notes /
   * voucher). Status changes are NOT accepted here: every status move must go
   * through `transitionOrder` (the guarded edge-map + refund path). 5.4b's bulk
   * fulfilment upload reuses this same non-status write.
   */
  async updateOrder(user: JwtPayload, id: string, dto: UpdateOrderDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope re-checked
    // here by partner.clientId (§12). platformWide OWNER → cross-tenant console.
    const scope = tenantScope(user);
    const existingOrder = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
    });
    if (!existingOrder) throw new NotFoundException('Order not found');

    const order = await this.prisma.redemptionOrder.update({
      where: { id },
      data: {
        trackingNumber: dto.trackingNumber,
        trackingUrl: dto.trackingUrl,
        voucherCode: dto.voucherCode,
        voucherProvider: dto.voucherProvider,
        notes: dto.notes,
        // Dispatch fields (§5) — non-status console/bulk edits.
        fulfilmentChannel: dto.fulfilmentChannel,
        logisticsPartner: dto.logisticsPartner,
        supplierOrderRef: dto.supplierOrderRef,
        podUrl: dto.podUrl,
      },
    });

    return { order };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // P5.4a — CORE redemption pipeline.
  //
  // FREE_AMOUNT convention (reconcile §3): a catalog item with `pointsCost === 0`
  // AND both `minRedemptionPoints`/`maxRedemptionPoints` set is a variable-amount
  // voucher. The redeem body then carries `amount` (₹); requiredPoints =
  // round(amount × conversionRate) and MUST fall within [min, max]. A normal
  // (FIXED) item ignores `amount` and costs `pointsCost × quantity`.
  //
  // OTP: a 6-digit REDEMPTION_CONFIRM OtpCode (10-min TTL, maxAttempts 3) reuses
  // the OtpCode model. We do NOT call auth.verifyOtp (it auto-registers users) —
  // verifyRedemptionOtp below is a self-contained check honouring FIXED_OTP.
  //
  // Points only move at CONFIRM time (the OTP step), never at redeem time.
  // ───────────────────────────────────────────────────────────────────────────

  /** True when the item is a FREE_AMOUNT (variable-amount) voucher. */
  private isFreeAmount(item: { pointsCost: number; minRedemptionPoints: number | null; maxRedemptionPoints: number | null }): boolean {
    return (
      item.pointsCost === 0 &&
      item.minRedemptionPoints != null &&
      item.maxRedemptionPoints != null
    );
  }

  /**
   * Wave 3 login-picker — resolve the PARTNER a partner-self request should ACT ON.
   *
   * SECURITY INVARIANT: this is the ONLY authority for outlet switching on the
   * partner-self money path. `resolveActivePartnerId` re-authorizes the optional
   * `x-active-partner-id` selector against the login's operable set (own partner +
   * login-less same-group same-phone siblings) — an absent/own selector returns the
   * login's own partner (byte-identical fast path), a valid sibling returns that
   * sibling, and anything else is `forbidden`. Callers MUST use the returned
   * partnerId for EVERY downstream partner resolution (wallet, order create, order
   * re-loads inside the confirm $transaction) so a mid-flow re-resolution can never
   * silently switch back to the login's own wallet — the classic money bug.
   *
   * Returns the resolved partnerId (string) or null when the login owns no partner
   * (e.g. a parent-only phone) — the caller treats null as today's no-partner case.
   */
  private async resolveActive(
    user: JwtPayload,
    requestedPartnerId?: string,
  ): Promise<string | null> {
    const res = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (res.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    return res.partnerId;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // B1 / #50-E — SALES-ASSISTED redemption (redeem ON BEHALF OF an outlet).
  //
  // A sales user redeems for an OUTLET they are actively assigned to. Points,
  // the wallet debit, and the order all belong to the OUTLET — the sales user is
  // only the operator (recorded for audit). The OTP is sent to the OUTLET's phone
  // (owner decision: the outlet consents; the rep submits the code the outlet
  // shares). Authorization is the active salesUserAssignment, re-verified on BOTH
  // redeem AND confirm (the confirm never trusts the order alone).
  //
  // Scoping shape is the PROVEN sales-on-behalf guard from schemes.service.ts:
  //   caller SalesUser in tenant → target ChannelPartner in tenant → active
  //   salesUserAssignment(salesUserId + partnerId + unassignedAt null).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the OUTLET (ChannelPartner) the caller (a SalesUser) may act for, or
   * throw. Returns the partner plus the OTP recipient (the OUTLET's user + phone),
   * which redeem/confirm bind the REDEMPTION_CONFIRM OTP to.
   */
  private async requireAssignedPartner(user: JwtPayload, targetPartnerId: string) {
    // 1. Caller must be a SalesUser in this tenant.
    const callerSalesUser = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!callerSalesUser) {
      throw new ForbiddenException('Only sales users may redeem on behalf of an outlet');
    }

    // 2. Target outlet/partner must belong to this tenant (cross-tenant block).
    const partner = await this.prisma.channelPartner.findFirst({
      where: { id: targetPartnerId, clientId: user.clientId, deletedAt: null },
      include: { user: { select: { id: true, phone: true } } },
    });
    if (!partner) throw new NotFoundException('Outlet not found in this tenant');

    // 3. Caller must have an ACTIVE assignment to this outlet. Assignments may be
    //    keyed by partnerId (admin re-assign / seed) OR by outletId (the master
    //    outlet-upload path, where partnerId is null at upload time — the partner
    //    is attached later at KYC and not backfilled). Accept EITHER so the guard
    //    matches real production assignments, not just the seeded shape.
    const partnerOutlets = await this.prisma.outlet.findMany({
      where: { partnerId: targetPartnerId, deletedAt: null },
      select: { id: true },
    });
    const outletIds = partnerOutlets.map((o) => o.id);
    const assignment = await this.prisma.salesUserAssignment.findFirst({
      where: {
        salesUserId: callerSalesUser.id,
        unassignedAt: null,
        OR: [
          { partnerId: targetPartnerId },
          ...(outletIds.length ? [{ outletId: { in: outletIds } }] : []),
        ],
      },
      select: { id: true },
    });
    if (!assignment) {
      throw new ForbiddenException('You are not assigned to this outlet');
    }

    // ChannelPartner.userId is non-nullable in the schema, but guard defensively:
    // an OTP with no recipient cannot be delivered, so fail loudly.
    const otpUserId = partner.userId;
    if (!otpUserId) {
      throw new BadRequestException('Outlet has no linked user for OTP');
    }

    return { partner, otpUserId, otpPhone: partner.user?.phone ?? '' };
  }

  /**
   * POST /v1/rewards/redeem-for-outlet — sales-assisted redeem initiation.
   * Identical pipeline to `redeem()` EXCEPT the partner is the assigned OUTLET
   * (not the caller), and the OTP is bound to + delivered to the OUTLET's phone.
   * The wallet affordability check and the order both target the OUTLET. Writes a
   * SALES_ASSISTED_REDEEM audit log recording the operating sales user.
   */
  async redeemForOutlet(user: JwtPayload, dto: SalesRedeemDto) {
    const quantity = dto.quantity ?? 1;

    // ACTIVE non-deleted catalog item, in-tenant.
    const item = await this.prisma.rewardCatalog.findFirst({
      // Moderation gate on the REDEEM guard too — a non-APPROVED item must never be
      // redeemable via a stale cart / deep link. WAVE-2 SEAM: also require vendor
      // ACTIVE + ACTIVE grant for sourceType=VENDOR rows (§12 suspend cascade).
      where: {
        id: dto.rewardId,
        status: 'ACTIVE',
        deletedAt: null,
        clientId: user.clientId,
        moderationStatus: 'APPROVED',
      },
    });
    if (!item) throw new NotFoundException('Reward item not found or not available');

    // PHYSICAL_GIFT requires a full delivery address; other modes do not.
    if (item.redemptionMode === 'PHYSICAL_GIFT') {
      if (!dto.deliveryAddress) {
        throw new BadRequestException('Delivery address is required for physical gifts');
      }
      // Address quality (§12): validate the pincode at redeem for physical gifts.
      // The DTO already enforces 6 digits; the service adds the real-India rule
      // (first digit 1–9 — no Indian PIN starts with 0) so a syntactically-valid
      // but impossible PIN can't reach dispatch.
      this.assertValidPincode(dto.deliveryAddress.pincode);
    }

    // Per-tenant settings: the points↔₹ rate, channel availability, and the global
    // cash/voucher floor. Server-enforced (the FE gate is bypassable via direct API).
    const settings = await this.tenantSettings.getEffectiveSettings(user.clientId);
    const rate = settings.conversionRate;
    if (!settings.redemptionChannels[this.channelKey(item.redemptionMode)]) {
      throw new BadRequestException('This redemption channel is currently unavailable.');
    }

    // Points cost: FREE_AMOUNT = round(amount × rate) bounded by min/max; else pointsCost × qty.
    let requiredPoints: number;
    if (this.isFreeAmount(item)) {
      if (dto.amount == null) {
        throw new BadRequestException('amount (₹) is required for a variable-amount voucher');
      }
      requiredPoints = Math.round(dto.amount * rate);
      const min = item.minRedemptionPoints as number;
      const max = item.maxRedemptionPoints as number;
      if (requiredPoints < min || requiredPoints > max) {
        throw new BadRequestException(
          `Amount out of range. Allowed: ${min}–${max} points, requested: ${requiredPoints}`,
        );
      }
      // Global floor: a variable-amount redemption must clear the tenant minimum ₹
      // (bank/DBT vs free-amount voucher). The global floor WINS over the per-item min.
      const isCash = item.redemptionMode === 'UPI' || item.redemptionMode === 'BANK_TRANSFER';
      const floorInr = isCash ? settings.minBankTransferAmount : settings.minVoucherFreeAmount;
      const floorPoints = Math.round(floorInr * rate);
      if (requiredPoints < floorPoints) {
        throw new BadRequestException(
          `Minimum ${isCash ? 'transfer' : 'voucher'} amount is ₹${floorInr} (${floorPoints} points).`,
        );
      }
    } else {
      requiredPoints = item.pointsCost * quantity;
    }
    if (requiredPoints <= 0) {
      throw new BadRequestException('Redemption must cost a positive number of points');
    }

    // Resolve the OUTLET the caller may act for + the OTP recipient (the outlet).
    const { partner, otpUserId, otpPhone } = await this.requireAssignedPartner(
      user,
      dto.targetPartnerId,
    );

    // Affordability checks the OUTLET's wallet (no debit yet).
    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: partner.id } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.redeemablePoints < requiredPoints) {
      throw new BadRequestException(
        `Insufficient points. Required: ${requiredPoints}, Available: ${wallet.redeemablePoints}`,
      );
    }

    const addr = dto.deliveryAddress;
    const otp = this.generateOtpCode();
    // Gift value snapshot (decision §14): freeze the gift's ₹ selling price onto the
    // order at redeem so a later price/rate change never re-values it. Null for
    // non-gift / variable-amount items → confirm falls back to points ÷ rate.
    const giftMetadata =
      item.sellingValuePaise != null
        ? ({ sellingValuePaiseSnapshot: item.sellingValuePaise } as Prisma.InputJsonValue)
        : undefined;

    // Single active OTP per OUTLET: supersede the OUTLET's abandoned PENDING orders
    // (never debited) and clear the OUTLET's unverified REDEMPTION_CONFIRM OTPs so
    // the new OTP can confirm only THIS order. Scope is the OUTLET, not the caller.
    const order = await this.prisma.$transaction(async (tx) => {
      await tx.redemptionOrder.updateMany({
        where: { partnerId: partner.id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await tx.otpCode.deleteMany({
        where: { userId: otpUserId, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const orderAccountId = await ensureOutletAccount(tx, partner.id);
      // Tenant-stamped order number (TENANT-YY-######) via a concurrency-safe
      // per-(tenant,year) advisory-locked sequence. Inside the tx so the lock holds.
      const orderNumber = await generateTenantOrderNumber(tx, user.clientId);
      const created = await tx.redemptionOrder.create({
        data: {
          partnerId: partner.id,
          accountId: orderAccountId, // Employee Rewards Phase 1 — unified account owner (dual-write)
          rewardId: item.id,
          orderNumber,
          metadata: giftMetadata,
          quantity,
          pointsDeducted: 0,
          totalPointsCost: requiredPoints,
          // Snapshot the rate so confirm-time valuePaise/TDS is deterministic even if
          // an admin edits the per-tenant rate before the OTP is confirmed.
          conversionRateCenti: Math.round(rate * 100),
          redemptionMode: item.redemptionMode,
          status: 'PENDING',
          deliveryName: addr?.name,
          deliveryPhone: addr?.mobile,
          deliveryAddressLine1: addr?.address,
          deliveryCity: addr?.city,
          deliveryState: addr?.state,
          deliveryPincode: addr?.pincode,
        },
      });
      await tx.otpCode.create({
        data: {
          userId: otpUserId,
          phone: otpPhone,
          code: otp,
          purpose: 'REDEMPTION_CONFIRM',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          maxAttempts: 3,
          // Bind the OTP to THIS order so its confirm can't consume another outlet's OTP
          // (a login/outlet can now hold concurrent PENDING orders — login picker).
          referenceId: created.id,
        },
      });
      return created;
    });

    // Audit: record the operating sales user behind the OUTLET's order.
    await this.prisma.auditLog
      .create({
        data: {
          action: 'CREATE',
          entityType: 'REDEMPTION_ORDER',
          entityId: order.id,
          actorId: user.sub,
          metadata: {
            event: 'SALES_ASSISTED_REDEEM',
            salesUserId: user.sub,
            partnerId: partner.id,
            orderNumber: order.orderNumber,
          },
        },
      })
      .catch((e) => this.logger.error(`[redeemForOutlet] audit log failed: ${e}`));

    // Send OTP delivery to the OUTLET's phone synchronously (consent). NEVER log the live OTP
    // (the default Nest logger emits debug in prod → it would land in Cloud Logging).
    this.logger.debug(`[redeemForOutlet] OTP generated for order ${order.id}`);
    try {
      // Per-tenant SALES-ASSISTED redemption template; undefined → global env template.
      const tpl = await this.tenantSettings.getOtpTemplateId(user.clientId, 'redemptionSales');
      await this.msg91.sendOtp(otpPhone, otp, 'SMS', tpl);
    } catch (e) {
      this.logger.error(`[redeemForOutlet] OTP send failed for order ${order.id}: ${e}`);
      // No debit happened at redeem (pointsDeducted:0), so just undo the OTP + order so nothing is orphaned.
      // Best-effort: a stranded PENDING order is superseded by the next redeem; a cleanup failure must
      // NEVER mask the user-facing 503 (audit A-2a F5).
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.otpCode.deleteMany({ where: { userId: otpUserId, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null } });
          await tx.redemptionOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        });
      } catch (ce) {
        this.logger.error(`[redeemForOutlet] cleanup after OTP-send failure failed for order ${order.id}: ${ce}`);
      }
      throw new ServiceUnavailableException('Could not send the confirmation OTP. Please try again in a moment.');
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      requiredPoints,
      message:
        "OTP sent to the outlet's registered mobile. Ask the outlet to share it to confirm.",
    };
  }

  /**
   * POST /v1/rewards/redeem-for-outlet/confirm — confirm a sales-assisted redeem.
   * Re-verifies the assignment server-side (the assignment IS the authorization —
   * the order alone is never trusted), verifies the OTP bound to the OUTLET's user,
   * then runs the identical confirm transaction as `confirmRedeem` (atomic claim,
   * in-tx OTP consume, OUTLET wallet debit, valuePaise freeze, stock claim, P6
   * payout bridge). The operating sales user is the recorded status-history actor.
   */
  async confirmRedeemForOutlet(user: JwtPayload, dto: SalesRedeemConfirmDto) {
    // Re-verify the assignment server-side — do NOT trust the order alone.
    const { partner } = await this.requireAssignedPartner(user, dto.targetPartnerId);

    // The order must belong to the resolved (assigned) outlet. Benign-by-design:
    // a rep may confirm ANY PENDING order on that outlet — including one the
    // partner created via self-redeem — because the wallet, the debit target and
    // the OTP recipient are all the same outlet, so consent + the money path are
    // unchanged. (The atomic claim below still guarantees a single debit if two
    // assigned reps race.)
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id: dto.orderId, partnerId: partner.id },
      include: {
        reward: true,
        partner: {
          select: {
            id: true,
            userId: true,
            isActive: true,
            deletedAt: true,
            // Beneficiary rails for the pre-debit presence check (cash modes).
            bankAccountNumber: true,
            ifscCode: true,
            upiId: true,
            // GLB-1b pre-tx gate: fetch all KYC submissions for the canonical
            // resolver (deterministic tiebreak). No take:1 limit — the resolver
            // picks the effective status. See kyc-eligibility.ts for rationale.
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Redemption order not found');
    if (order.status !== 'PENDING') {
      throw new BadRequestException('Order is not awaiting confirmation');
    }

    // ELIGIBILITY GATE for the OUTLET (pre-transaction, fast path). KYC-APPROVED +
    // active + not-soft-deleted is required for ALL redemption modes (owner decision,
    // 2026-06-27): no value or goods may go to an unverified outlet — vouchers /
    // physical gifts are gated identically to cash. (Previously only cash modes were
    // gated; a pre-KYC outlet that had been credited points could redeem a voucher.)
    // Uses the canonical resolver for a deterministic tiebreak. A second check INSIDE
    // the transaction (TOCTOU guard) ensures no suspension between here and the
    // claim/debit can produce a debit for an ineligible partner.
    const isCashModeForOutlet =
      order.redemptionMode === 'UPI' || order.redemptionMode === 'BANK_TRANSFER';
    const p = order.partner;
    if (!p || p.isActive === false || p.deletedAt != null) {
      throw new BadRequestException(
        'Outlet partner account is inactive or deleted; redemption cannot be confirmed',
      );
    }
    const kycStatus = resolveEffectiveKycStatus(p.kycSubmissions ?? []);
    if (kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        `Outlet partner KYC is not approved (current status: ${kycStatus ?? 'NO_SUBMISSION'}); redemption cannot be confirmed`,
      );
    }
    if (isCashModeForOutlet) {
      // BENEFICIARY-PRESENCE GUARD (pre-debit, CASH only). The outlet needs at least
      // one COMPLETE rail to be payable; otherwise the order becomes an unpayable,
      // UNCANCELLABLE PayoutTransaction. Reject BEFORE any points debit / valuePaise
      // freeze / PayoutTransaction create.
      const hasBank = !!(p.bankAccountNumber && p.ifscCode);
      const hasUpi = !!p.upiId;
      if (!hasBank && !hasUpi) {
        throw new BadRequestException(
          'Add your bank or UPI details (complete KYC) to redeem for cash.',
        );
      }
    }

    // A parent owner (userId nullable) never redeems; a real operating outlet always
    // has a linked user. Guard defensively so a null can't reach OTP/notify below.
    if (!partner.userId) {
      throw new BadRequestException('Outlet has no linked user for redemption.');
    }

    // OTP is bound to the OUTLET's user (it was delivered to the outlet's phone) AND to THIS order.
    const otpId = await this.verifyRedemptionOtp(partner.userId, dto.otp, order.id);

    const requiredPoints = order.totalPointsCost;

    await this.prisma.$transaction(async (tx) => {
      // valuePaise: freeze the ₹-equivalent at confirm time (194R TDS base).
      // value(₹) = points ÷ conversionRate; centi-rate integer math avoids
      // truncating a fractional rate. rate 0 (misconfig) → 0 (guard div-by-zero).
      const rateCenti = await this.confirmRateCenti(order, user.clientId);
      // Canonical value freeze (decision §14): a GIFT item freezes valuePaise =
      // sellingValuePaise × quantity (rate-IMMUNE — a rate change never re-values a
      // placed gift). The selling price is read from the redeem-time snapshot in
      // order.metadata (falls back to the live catalog price for pre-snapshot orders).
      // Cash rails (UPI/BANK_TRANSFER) keep points ÷ rate (= the payout amount).
      const sellingSnap =
        typeof (order.metadata as { sellingValuePaiseSnapshot?: unknown } | null)
          ?.sellingValuePaiseSnapshot === 'number'
          ? (order.metadata as { sellingValuePaiseSnapshot: number }).sellingValuePaiseSnapshot
          : (order.reward?.sellingValuePaise ?? null);
      const valuePaise = computeFrozenValuePaise({
        isCashMode:
          order.redemptionMode === PayoutMode.UPI ||
          order.redemptionMode === PayoutMode.BANK_TRANSFER,
        sellingValuePaiseSnapshot: sellingSnap,
        quantity: order.quantity,
        points: requiredPoints,
        rateCenti,
      });

      // GLB-2 — ZERO-VALUE HARD FAIL for cash modes (inside the transaction so
      // the claim + wallet debit all roll back). Non-cash modes are unaffected.
      if (isCashModeForOutlet && valuePaise === 0n) {
        throw new BadRequestException(
          'Computed payout value is zero (check POINTS_CONVERSION_RATE); cash redemption cannot be confirmed',
        );
      }

      // TOCTOU in-tx eligibility re-check (ALL modes). The pre-tx gate above is the
      // fast path (fail early, clean 400). But a partner can be suspended / un-approved
      // between the pre-tx read and this transaction's start. Re-asserting here ensures
      // the wallet debit never happens for an ineligible partner: a throw inside
      // $transaction triggers a full rollback (no debit, claim reverts). isPartnerPayable
      // = active + not-deleted + KYC-APPROVED, which is exactly the all-mode gate.
      {
        const freshPartner = await tx.channelPartner.findFirst({
          where: { id: order.partnerId },
          select: {
            isActive: true,
            deletedAt: true,
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        });
        const freshKyc = resolveEffectiveKycStatus(freshPartner?.kycSubmissions ?? []);
        if (!isPartnerPayable({ isActive: freshPartner?.isActive, deletedAt: freshPartner?.deletedAt, effectiveKyc: freshKyc })) {
          throw new BadRequestException(
            `Outlet partner is no longer eligible for redemption (status changed after pre-tx check; KYC: ${freshKyc ?? 'NO_SUBMISSION'})`,
          );
        }
      }

      // Atomic claim: only the tx that flips PENDING→CONFIRMED proceeds → a single
      // order can never be debited twice (double-submit matches 0 rows, aborts).
      const claim = await tx.redemptionOrder.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: requiredPoints, valuePaise },
      });
      if (claim.count === 0) {
        throw new ConflictException('Order is no longer awaiting confirmation');
      }

      // Consume the OTP INSIDE the tx so a later failure rolls it back for retry.
      await tx.otpCode.update({ where: { id: otpId }, data: { verifiedAt: new Date() } });

      // Debit the OUTLET's wallet via the canonical write-path (passbook + ledger).
      await this.wallet.debitRedeem(
        order.partnerId,
        requiredPoints,
        { referenceId: order.id, description: `Redemption ${order.orderNumber}` },
        tx,
      );

      // The operating sales user is the recorded actor.
      await tx.redemptionStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: RedemptionStatus.PENDING,
          toStatus: RedemptionStatus.CONFIRMED,
          changedById: user.sub,
        },
      });

      // Guarded stock claim — concurrent confirms of the last unit can't oversell.
      if (order.reward?.stockQuantity != null) {
        const stockClaim = await tx.rewardCatalog.updateMany({
          where: { id: order.rewardId, stockQuantity: { gte: order.quantity } },
          data: { stockQuantity: { decrement: order.quantity } },
        });
        if (stockClaim.count === 0) {
          throw new BadRequestException('Reward is out of stock');
        }
        const fresh = await tx.rewardCatalog.findFirst({
          where: { id: order.rewardId },
          select: { stockQuantity: true },
        });
        if (fresh?.stockQuantity != null && fresh.stockQuantity <= 0) {
          await tx.rewardCatalog.update({
            where: { id: order.rewardId },
            data: { status: 'OUT_OF_STOCK' },
          });
        }
      }

      // P6 BRIDGE — unbatched PayoutTransaction for cash modes (UPI/BANK_TRANSFER).
      // The exclusive PENDING→CONFIRMED claim above guarantees at most one payout
      // per order. Beneficiary fields are snapshotted from the OUTLET's KYC.
      if (
        order.redemptionMode === 'UPI' ||
        order.redemptionMode === 'BANK_TRANSFER'
      ) {
        const partnerSnap = await tx.channelPartner.findFirst({
          where: { id: order.partnerId },
          select: {
            bankAccountHolder: true,
            ownerName: true,
            upiId: true,
            bankAccountNumber: true,
            ifscCode: true,
            bankName: true,
          },
        });

        // MINOR: this zero-value fallback is only reachable for non-cash modes
        // (GLB-2 above throws first for UPI/BANK_TRANSFER when valuePaise=0n).
        // It is kept for defence-in-depth but must NEVER be reached in cash paths.
        const amountPaise: bigint =
          valuePaise != null && valuePaise > 0n ? valuePaise : (() => {
            this.logger.warn(
              `[confirmRedeemForOutlet] valuePaise null/zero for order ${order.id} — PayoutTransaction created with amountPaise=0; manual correction required (non-cash path only)`,
            );
            return 0n;
          })();

        await tx.payoutTransaction.create({
          data: {
            partnerId: order.partnerId,
            redemptionOrderId: order.id,
            payoutMode: order.redemptionMode,
            status: 'PENDING',
            batchId: null,
            amountPaise,
            netAmountPaise: amountPaise,
            tdsPaise: 0n,
            tdsApplicable: false,
            beneficiaryName: partnerSnap?.bankAccountHolder ?? partnerSnap?.ownerName ?? null,
            upiId: partnerSnap?.upiId ?? null,
            bankAccountNumber: partnerSnap?.bankAccountNumber ?? null,
            ifscCode: partnerSnap?.ifscCode ?? null,
            bankName: partnerSnap?.bankName ?? null,
          },
        });

        this.logger.log(
          `[confirmRedeemForOutlet] PayoutTransaction created for order ${order.id} (${order.redemptionMode}, ${amountPaise} paise)`,
        );
      }
    });

    // Redemption-confirmed notification on commit: bell feed (IN_APP) + PUSH to the outlet's
    // partner user, PLUS the config-driven SMS/WhatsApp to the OUTLET OWNER — via the single
    // canonical notifyUserWithChannels path. The dead direct SMS enqueue is removed; SMS now flows
    // through the config path (default OFF until a tenant enables it). Fire-and-forget.
    await this.notifications.notifyUserWithChannels({
      clientId: user.clientId,
      userId: partner.userId,
      eventKey: 'REDEMPTION_CONFIRMED',
      // Paid-channel recipient = the OUTLET OWNER (partner.phone), consistent with every other
      // event. Previously this addressed the outlet's LOGIN user (partner.user.phone), which can
      // differ from the owner. Free channels still target partner.userId (the acting user) above.
      recipientPhone: partner.phone ?? null,
      vars: {
        ownerName: partner.ownerName ?? 'Partner',
        rewardName: order.reward?.name ?? '',
        points: requiredPoints,
      },
      subject: 'Redemption confirmed',
      body: 'Your redemption is confirmed.',
      url: '/partner/rewards',
      event: 'REDEMPTION_CONFIRMED',
    });

    return {
      orderId: order.id,
      status: 'CONFIRMED',
      message: 'Redemption confirmed. Your order is being processed.',
    };
  }

  /**
   * POST /v1/rewards/redeem — initiate a redemption.
   * Resolves required points (FIXED or FREE_AMOUNT), checks affordability WITHOUT
   * debiting, creates a PENDING order, and issues a REDEMPTION_CONFIRM OTP. The
   * actual wallet debit happens at confirm time.
   */
  async redeem(user: JwtPayload, dto: RedeemDto, requestedPartnerId?: string) {
    const quantity = dto.quantity ?? 1;

    // ACTIVE non-deleted catalog item, in-tenant.
    const item = await this.prisma.rewardCatalog.findFirst({
      // Moderation gate on the REDEEM guard too — a non-APPROVED item must never be
      // redeemable via a stale cart / deep link. WAVE-2 SEAM: also require vendor
      // ACTIVE + ACTIVE grant for sourceType=VENDOR rows (§12 suspend cascade).
      where: {
        id: dto.rewardId,
        status: 'ACTIVE',
        deletedAt: null,
        clientId: user.clientId,
        moderationStatus: 'APPROVED',
      },
    });
    if (!item) throw new NotFoundException('Reward item not found or not available');

    // PHYSICAL_GIFT requires a full delivery address; other modes do not.
    if (item.redemptionMode === 'PHYSICAL_GIFT') {
      if (!dto.deliveryAddress) {
        throw new BadRequestException('Delivery address is required for physical gifts');
      }
      // Address quality (§12): validate the pincode at redeem for physical gifts.
      // The DTO already enforces 6 digits; the service adds the real-India rule
      // (first digit 1–9 — no Indian PIN starts with 0) so a syntactically-valid
      // but impossible PIN can't reach dispatch.
      this.assertValidPincode(dto.deliveryAddress.pincode);
    }

    // Per-tenant settings: the points↔₹ rate, channel availability, and the global
    // cash/voucher floor. Server-enforced (the FE gate is bypassable via direct API).
    const settings = await this.tenantSettings.getEffectiveSettings(user.clientId);
    const rate = settings.conversionRate;
    if (!settings.redemptionChannels[this.channelKey(item.redemptionMode)]) {
      throw new BadRequestException('This redemption channel is currently unavailable.');
    }

    // Points cost: FREE_AMOUNT = round(amount × rate) bounded by min/max; else pointsCost × qty.
    let requiredPoints: number;
    if (this.isFreeAmount(item)) {
      if (dto.amount == null) {
        throw new BadRequestException('amount (₹) is required for a variable-amount voucher');
      }
      requiredPoints = Math.round(dto.amount * rate);
      const min = item.minRedemptionPoints as number;
      const max = item.maxRedemptionPoints as number;
      if (requiredPoints < min || requiredPoints > max) {
        throw new BadRequestException(
          `Amount out of range. Allowed: ${min}–${max} points, requested: ${requiredPoints}`,
        );
      }
      // Global floor: a variable-amount redemption must clear the tenant minimum ₹
      // (bank/DBT vs free-amount voucher). The global floor WINS over the per-item min.
      const isCash = item.redemptionMode === 'UPI' || item.redemptionMode === 'BANK_TRANSFER';
      const floorInr = isCash ? settings.minBankTransferAmount : settings.minVoucherFreeAmount;
      const floorPoints = Math.round(floorInr * rate);
      if (requiredPoints < floorPoints) {
        throw new BadRequestException(
          `Minimum ${isCash ? 'transfer' : 'voucher'} amount is ₹${floorInr} (${floorPoints} points).`,
        );
      }
    } else {
      requiredPoints = item.pointsCost * quantity;
    }
    if (requiredPoints <= 0) {
      throw new BadRequestException('Redemption must cost a positive number of points');
    }

    // SECURITY INVARIANT: resolve the ACTIVE partner ONCE (own or an authorized
    // switched sibling). This same activePartnerId drives the wallet check, the
    // PENDING supersede AND the order.partnerId — so the whole redemption (and every
    // downstream confirm re-load, which keys off order.partnerId) targets the outlet
    // the login actually switched to, never the login's own wallet. A forbidden
    // selector throws here before any read; null (no partner) → today's 404.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);
    if (!activePartnerId) throw new NotFoundException('Partner account not found');

    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: activePartnerId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.redeemablePoints < requiredPoints) {
      throw new BadRequestException(
        `Insufficient points. Required: ${requiredPoints}, Available: ${wallet.redeemablePoints}`,
      );
    }

    const addr = dto.deliveryAddress;
    const otp = this.generateOtpCode();
    // Gift value snapshot (decision §14): freeze the gift's ₹ selling price onto the
    // order at redeem so a later price/rate change never re-values it. Null for
    // non-gift / variable-amount items → confirm falls back to points ÷ rate.
    const giftMetadata =
      item.sellingValuePaise != null
        ? ({ sellingValuePaiseSnapshot: item.sellingValuePaise } as Prisma.InputJsonValue)
        : undefined;

    // C2 — bind the OTP to exactly ONE order. A user may have only one redemption
    // awaiting confirmation at a time: superseding any abandoned PENDING orders
    // (none were ever debited → pointsDeducted=0, no refund) and their unverified
    // OTPs guarantees the single active REDEMPTION_CONFIRM OTP can confirm only
    // THIS order — closing the cross-order OTP-confusion the audit flagged.
    const order = await this.prisma.$transaction(async (tx) => {
      // Supersede the ACTIVE partner's abandoned PENDING orders (never debited). The
      // OTP delete/create stay bound to user.sub — the OTP is LOGIN-level (one active
      // REDEMPTION_CONFIRM per login), while the order/wallet are the active outlet's.
      await tx.redemptionOrder.updateMany({
        where: { partnerId: activePartnerId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await tx.otpCode.deleteMany({
        where: { userId: user.sub, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const orderAccountId = await ensureOutletAccount(tx, activePartnerId);
      // Tenant-stamped order number (TENANT-YY-######) via a concurrency-safe
      // per-(tenant,year) advisory-locked sequence. Inside the tx so the lock holds.
      const orderNumber = await generateTenantOrderNumber(tx, user.clientId);
      const created = await tx.redemptionOrder.create({
        data: {
          partnerId: activePartnerId,
          accountId: orderAccountId, // Employee Rewards Phase 1 — unified account owner (dual-write)
          rewardId: item.id,
          orderNumber,
          metadata: giftMetadata,
          quantity,
          pointsDeducted: 0,
          totalPointsCost: requiredPoints,
          // Snapshot the rate so confirm-time valuePaise/TDS is deterministic even if
          // an admin edits the per-tenant rate before the OTP is confirmed.
          conversionRateCenti: Math.round(rate * 100),
          redemptionMode: item.redemptionMode,
          status: 'PENDING',
          deliveryName: addr?.name,
          deliveryPhone: addr?.mobile,
          deliveryAddressLine1: addr?.address,
          deliveryCity: addr?.city,
          deliveryState: addr?.state,
          deliveryPincode: addr?.pincode,
        },
      });
      await tx.otpCode.create({
        data: {
          userId: user.sub,
          phone: user.phone,
          code: otp,
          purpose: 'REDEMPTION_CONFIRM',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          maxAttempts: 3,
          // Bind the OTP to THIS order so its confirm can't consume another order's OTP. The OTP
          // stays LOGIN-level for delivery (userId), but a login can now hold concurrent PENDING
          // orders across outlets (login picker) — the order scope is the new confusion guard.
          referenceId: created.id,
        },
      });
      return created;
    });

    // Send OTP delivery (SMS) synchronously. NEVER log the live OTP (the default Nest logger
    // emits debug in prod → it would land in Cloud Logging).
    this.logger.debug(`[redeem] OTP generated for order ${order.id}`);
    try {
      // Per-tenant SELF redemption template; undefined → global env template.
      const tpl = await this.tenantSettings.getOtpTemplateId(user.clientId, 'redemptionSelf');
      await this.msg91.sendOtp(user.phone, otp, 'SMS', tpl);
    } catch (e) {
      this.logger.error(`[redeem] OTP send failed for order ${order.id}: ${e}`);
      // No debit happened at redeem (pointsDeducted:0), so just undo the OTP + order so nothing is orphaned.
      // Best-effort: a stranded PENDING order is superseded by the next redeem; a cleanup failure must
      // NEVER mask the user-facing 503 (audit A-2a F5).
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.otpCode.deleteMany({ where: { userId: user.sub, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null } });
          await tx.redemptionOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        });
      } catch (ce) {
        this.logger.error(`[redeem] cleanup after OTP-send failure failed for order ${order.id}: ${ce}`);
      }
      throw new ServiceUnavailableException('Could not send the confirmation OTP. Please try again in a moment.');
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      requiredPoints,
      message: 'OTP sent to your registered mobile. Please confirm the redemption.',
    };
  }

  /**
   * POST /v1/rewards/redeem/confirm — confirm a PENDING order with the OTP.
   * Verifies the OTP, then in ONE $transaction re-checks the balance, debits via
   * WalletService.debitRedeem, flips the order to CONFIRMED, decrements stock for
   * stock-tracked items, and writes a status-history row. Notifies on commit.
   */
  async confirmRedeem(user: JwtPayload, dto: RedeemConfirmDto, requestedPartnerId?: string) {
    // SECURITY INVARIANT: resolve the ACTIVE partner FIRST (own or an authorized
    // switched sibling; forbidden → 403). The order must belong to THIS partner — we
    // authorize by order.partnerId === activePartnerId, NOT by order.partner.userId
    // (a switched sibling has userId=null and would be wrongly 403'd). Every in-tx
    // re-load below keys off order.partnerId (== the resolved active partner), so the
    // debit/payout can never drift back to the login's own wallet.
    const activePartnerId = await this.resolveActive(user, requestedPartnerId);

    const order = await this.prisma.redemptionOrder.findFirst({
      // Tenant scope by partner.clientId so a switched sibling's order is found
      // (a login-less sibling has no linked user → partner.user.clientId would miss it).
      where: { id: dto.orderId, partner: { clientId: user.clientId } },
      include: {
        reward: true,
        partner: {
          select: {
            id: true,
            userId: true,
            isActive: true,
            deletedAt: true,
            // Outlet OWNER identity for the paid-channel redemption notification (below).
            phone: true,
            ownerName: true,
            // Beneficiary rails for the pre-debit presence check (cash modes).
            bankAccountNumber: true,
            ifscCode: true,
            upiId: true,
            // GLB-1b pre-tx gate: fetch all KYC submissions for the canonical
            // resolver (deterministic tiebreak). No take:1 limit — the resolver
            // picks the effective status. See kyc-eligibility.ts for rationale.
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Redemption order not found');
    // Authorize the order against the resolved active partner (own or switched sibling).
    if (!activePartnerId || order.partnerId !== activePartnerId) {
      throw new ForbiddenException('Forbidden');
    }
    if (order.status !== 'PENDING') {
      throw new BadRequestException('Order is not awaiting confirmation');
    }

    // ELIGIBILITY GATE (pre-transaction, fast path). KYC-APPROVED + active +
    // not-soft-deleted is required for ALL redemption modes (owner decision,
    // 2026-06-27): no value or goods to an unverified outlet — vouchers / physical
    // gifts are gated identically to cash. (Previously only cash was gated; a pre-KYC
    // partner credited points could redeem a voucher.) Canonical resolver for a
    // deterministic tiebreak. A second check INSIDE the transaction (TOCTOU guard)
    // ensures a suspension between here and the claim/debit is caught.
    const isCashModeConfirm =
      order.redemptionMode === 'UPI' || order.redemptionMode === 'BANK_TRANSFER';
    const p = order.partner;
    if (!p || p.isActive === false || p.deletedAt != null) {
      throw new BadRequestException(
        'Partner account is inactive or deleted; redemption cannot be confirmed',
      );
    }
    const kycStatus = resolveEffectiveKycStatus(p.kycSubmissions ?? []);
    if (kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        `Partner KYC is not approved (current status: ${kycStatus ?? 'NO_SUBMISSION'}); redemption cannot be confirmed`,
      );
    }
    if (isCashModeConfirm) {
      // BENEFICIARY-PRESENCE GUARD (pre-debit, CASH only). A cash payout needs at least
      // one COMPLETE rail to be payable. Without it the order becomes an unpayable,
      // UNCANCELLABLE PayoutTransaction — so reject BEFORE any points debit / valuePaise
      // freeze / PayoutTransaction create.
      const hasBank = !!(p.bankAccountNumber && p.ifscCode);
      const hasUpi = !!p.upiId;
      if (!hasBank && !hasUpi) {
        throw new BadRequestException(
          'Add your bank or UPI details (complete KYC) to redeem for cash.',
        );
      }
    }

    const otpId = await this.verifyRedemptionOtp(user.sub, dto.otp, order.id);

    const requiredPoints = order.totalPointsCost;

    await this.prisma.$transaction(async (tx) => {
      // C1 — CLAIM the order as the atomic concurrency gate: only the tx that
      // flips PENDING→CONFIRMED proceeds. A concurrent confirm (double-submit)
      // matches 0 rows here and aborts BEFORE any debit, so a single order can
      // never be debited twice. This is the guard, not the pre-tx status read.
      //
      // valuePaise: freeze the ₹-equivalent of the points at confirm time (the
      // 194R TDS base for redemptions). conversionRate can theoretically be 0
      // (misconfigured env) — guard to prevent division-by-zero; in that case
      // valuePaise = 0 (no TDS base, visible in reports for manual correction).
      // value(₹) = points ÷ conversionRate. Work in centi-rate (rate×100) integer math so a
      // fractional conversionRate (e.g. 0.5 pts/₹) isn't truncated: paise = points×10000 ÷ (rate×100).
      const rateCenti = await this.confirmRateCenti(order, user.clientId);
      // Canonical value freeze (decision §14): a GIFT item freezes valuePaise =
      // sellingValuePaise × quantity (rate-IMMUNE — a rate change never re-values a
      // placed gift). The selling price is read from the redeem-time snapshot in
      // order.metadata (falls back to the live catalog price for pre-snapshot orders).
      // Cash rails (UPI/BANK_TRANSFER) keep points ÷ rate (= the payout amount).
      const sellingSnap =
        typeof (order.metadata as { sellingValuePaiseSnapshot?: unknown } | null)
          ?.sellingValuePaiseSnapshot === 'number'
          ? (order.metadata as { sellingValuePaiseSnapshot: number }).sellingValuePaiseSnapshot
          : (order.reward?.sellingValuePaise ?? null);
      const valuePaise = computeFrozenValuePaise({
        isCashMode:
          order.redemptionMode === PayoutMode.UPI ||
          order.redemptionMode === PayoutMode.BANK_TRANSFER,
        sellingValuePaiseSnapshot: sellingSnap,
        quantity: order.quantity,
        points: requiredPoints,
        rateCenti,
      });

      // GLB-2 — ZERO-VALUE HARD FAIL for cash modes (inside the transaction so
      // the whole tx — claim + wallet debit — rolls back). A zero valuePaise means
      // either the conversionRate is 0/misconfigured (caught by the boot check) or
      // the arithmetic produced 0 despite a non-zero rate (e.g. tiny point count).
      // Either way, creating a PayoutTransaction with amountPaise=0 is a silent
      // money-path bug; fail loudly here so ops can correct the root cause.
      // Non-cash modes are NOT affected — they don't create a PayoutTransaction.
      if (isCashModeConfirm && valuePaise === 0n) {
        throw new BadRequestException(
          'Computed payout value is zero (check POINTS_CONVERSION_RATE); cash redemption cannot be confirmed',
        );
      }

      // TOCTOU in-tx eligibility re-check (ALL modes).
      // The pre-tx gate above is the fast path (fail early, clean 400). But a partner
      // can be suspended / un-approved between the pre-tx read and this transaction's
      // start. Re-reading partner state here ensures the wallet debit never happens for
      // an ineligible partner: a throw inside $transaction triggers a full rollback
      // (claim reverts). isPartnerPayable = active + not-deleted + KYC-APPROVED.
      {
        // SECURITY INVARIANT: re-load by order.partnerId (== the resolved active
        // partner) + clientId — NEVER re-resolve from user.sub here, which would
        // silently switch a switched-outlet confirm back to the login's own partner.
        const freshPartner = await tx.channelPartner.findFirst({
          where: { id: order.partnerId, clientId: user.clientId },
          select: {
            isActive: true,
            deletedAt: true,
            kycSubmissions: {
              orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, createdAt: true, updatedAt: true },
            },
          },
        });
        const freshKyc = resolveEffectiveKycStatus(freshPartner?.kycSubmissions ?? []);
        if (!isPartnerPayable({ isActive: freshPartner?.isActive, deletedAt: freshPartner?.deletedAt, effectiveKyc: freshKyc })) {
          throw new BadRequestException(
            `Partner is no longer eligible for redemption (status changed after pre-tx check; KYC: ${freshKyc ?? 'NO_SUBMISSION'})`,
          );
        }
      }

      const claim = await tx.redemptionOrder.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: requiredPoints, valuePaise },
      });
      if (claim.count === 0) {
        throw new ConflictException('Order is no longer awaiting confirmation');
      }

      // M1 — consume the OTP INSIDE the tx so a later failure (insufficient
      // balance, oversold stock) rolls the OTP back and the user can retry.
      await tx.otpCode.update({ where: { id: otpId }, data: { verifiedAt: new Date() } });

      // Debit via the canonical wallet write-path (passbook + ledger). Throws 400
      // on insufficient balance → whole tx (incl. the claim) rolls back.
      await this.wallet.debitRedeem(
        order.partnerId,
        requiredPoints,
        { referenceId: order.id, description: `Redemption ${order.orderNumber}` },
        tx,
      );

      await tx.redemptionStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: RedemptionStatus.PENDING,
          toStatus: RedemptionStatus.CONFIRMED,
          changedById: user.sub,
        },
      });

      // H1 — guarded stock claim: only decrement if enough stock remains, so
      // concurrent confirms of the last unit can't oversell. If the claim fails,
      // the whole tx (incl. debit) rolls back → order stays PENDING, no debit.
      if (order.reward?.stockQuantity != null) {
        const stockClaim = await tx.rewardCatalog.updateMany({
          where: { id: order.rewardId, stockQuantity: { gte: order.quantity } },
          data: { stockQuantity: { decrement: order.quantity } },
        });
        if (stockClaim.count === 0) {
          throw new BadRequestException('Reward is out of stock');
        }
        const fresh = await tx.rewardCatalog.findFirst({
          where: { id: order.rewardId },
          select: { stockQuantity: true },
        });
        if (fresh?.stockQuantity != null && fresh.stockQuantity <= 0) {
          await tx.rewardCatalog.update({
            where: { id: order.rewardId },
            data: { status: 'OUT_OF_STOCK' },
          });
        }
      }

      // P6 BRIDGE — create an unbatched PayoutTransaction for cash redemptions
      // (UPI / BANK_TRANSFER) so the payout engine can settle the INR later.
      //
      // GATE: only UPI and BANK_TRANSFER modes carry real money; GIFT_CARD,
      // PHYSICAL_GIFT, VOUCHER, and any future non-cash mode are fulfilled by
      // the rewards engine itself and do NOT need a payout.
      //
      // DOUBLE-PAYOUT GUARD: this create runs ONLY inside the tx that won the
      // PENDING→CONFIRMED claim (the `updateMany` above). A concurrent confirm
      // matches 0 rows in that claim and throws ConflictException before it ever
      // reaches here, so a single RedemptionOrder can produce at most one
      // PayoutTransaction. No extra findFirst guard is needed; we rely on the
      // exclusive claim. (If a future retry somehow reaches here after a partial
      // write, the DB-level unique-ish on redemptionOrderId is not enforced by
      // schema, but the claim gate prevents the scenario in practice.)
      //
      // AMOUNT: amountPaise = valuePaise frozen in the claim above. valuePaise
      // may be null if the order was created before the freeze column existed; we
      // fall back to 0n and log a warning so an admin can correct it.
      //
      // BENEFICIARY SNAPSHOT: we snapshot the partner's KYC-verified bank/UPI
      // fields at confirm time so the payout record is self-contained and immune
      // to later KYC edits.
      if (
        order.redemptionMode === 'UPI' ||
        order.redemptionMode === 'BANK_TRANSFER'
      ) {
        // Fetch full partner for bank snapshot inside the tx. SECURITY INVARIANT:
        // keyed by order.partnerId (== the resolved active partner) + clientId — the
        // payout beneficiary is the switched outlet, never re-resolved from user.sub.
        const partnerSnap = await tx.channelPartner.findFirst({
          where: { id: order.partnerId, clientId: user.clientId },
          select: {
            bankAccountHolder: true,
            ownerName: true,
            upiId: true,
            bankAccountNumber: true,
            ifscCode: true,
            bankName: true,
          },
        });

        // valuePaise is set by the claim update just above; the re-read is not
        // needed — we computed it in `valuePaise` (BigInt) in this scope.
        //
        // MINOR: this zero-value fallback is only reachable for non-cash modes
        // (GLB-2 throws first for UPI/BANK_TRANSFER when valuePaise=0n). It is kept
        // for defence-in-depth but must NEVER be reached in cash paths.
        const amountPaise: bigint =
          valuePaise != null && valuePaise > 0n ? valuePaise : (() => {
            this.logger.warn(
              `[confirmRedeem] valuePaise null/zero for order ${order.id} — PayoutTransaction created with amountPaise=0; manual correction required (non-cash path only)`,
            );
            return 0n;
          })();

        await tx.payoutTransaction.create({
          data: {
            partnerId: order.partnerId,
            redemptionOrderId: order.id,
            payoutMode: order.redemptionMode,
            status: 'PENDING',
            batchId: null,           // unbatched — GIFSY admin assigns to a batch later
            amountPaise,
            netAmountPaise: amountPaise,  // TDS computed later by payouts.processBatch
            tdsPaise: 0n,
            tdsApplicable: false,
            beneficiaryName: partnerSnap?.bankAccountHolder ?? partnerSnap?.ownerName ?? null,
            upiId: partnerSnap?.upiId ?? null,
            bankAccountNumber: partnerSnap?.bankAccountNumber ?? null,
            ifscCode: partnerSnap?.ifscCode ?? null,
            bankName: partnerSnap?.bankName ?? null,
          },
        });

        this.logger.log(
          `[confirmRedeem] PayoutTransaction created for order ${order.id} (${order.redemptionMode}, ${amountPaise} paise)`,
        );
      }
    });

    // Redemption-confirmed notification on commit: bell feed (IN_APP) + PUSH to the redeeming
    // partner user, PLUS the config-driven SMS/WhatsApp to the OWNER — via the single canonical
    // notifyUserWithChannels path. The dead direct SMS enqueue is removed; SMS now flows through
    // the config path (default OFF until a tenant enables it). Fire-and-forget.
    await this.notifications.notifyUserWithChannels({
      clientId: user.clientId,
      // Free channels (IN_APP + PUSH) still address the acting user (self-redeem submitter).
      userId: user.sub,
      eventKey: 'REDEMPTION_CONFIRMED',
      // Paid-channel recipient = the OUTLET OWNER, consistent with every other event. For a
      // switched-sibling redemption the acting login (user.phone/name) can differ from the outlet
      // owner; the paid message must reach the owner. Falls back to the acting user if the owner
      // fields are somehow absent.
      recipientPhone: order.partner?.phone ?? user.phone ?? null,
      vars: {
        ownerName: order.partner?.ownerName ?? user.name ?? 'Partner',
        rewardName: order.reward?.name ?? '',
        points: requiredPoints,
      },
      subject: 'Redemption confirmed',
      body: 'Your redemption is confirmed.',
      url: '/partner/rewards',
      event: 'REDEMPTION_CONFIRMED',
    });

    return {
      orderId: order.id,
      status: 'CONFIRMED',
      message: 'Redemption confirmed. Your order is being processed.',
    };
  }

  /**
   * POST /v1/rewards/orders/:id/transition — GIFSY-only guarded status change.
   *
   * Allowed edges (anything else → 400):
   *   PENDING    → CANCELLED
   *   CONFIRMED  → PROCESSING | CANCELLED | RETURNED
   *   PROCESSING → DISPATCHED | FAILED | CANCELLED
   *   DISPATCHED → DELIVERED | RETURNED
   *
   * REFUND GUARD: when leaving a state where points were already debited
   * (pointsDeducted > 0) into CANCELLED/RETURNED/FAILED, re-credit via
   * WalletService.reverse and zero pointsDeducted in the SAME tx, so a
   * double-cancel can never double-refund.
   *
   * Inline voucher/tracking entry rides on this call (per-order fulfilment).
   */
  async transitionOrder(user: JwtPayload, id: string, dto: TransitionOrderDto) {
    // Tenant scope by partner.clientId (§12 — partner.user.clientId misses login-less
    // sibling outlets). platformWide (un-assumed OWNER) → cross-tenant, which powers
    // the Gifsy fulfilment console; an assumed operator is pinned to that tenant.
    const scope = tenantScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
    });
    if (!order) throw new NotFoundException('Order not found');

    const toStatus = dto.toStatus as unknown as RedemptionStatus;

    // IDEMPOTENT (§12): a request for the CURRENT state is a no-op — skip the
    // transition AND the member notification (de-dupes bulk re-uploads / retries).
    if (order.status === toStatus) {
      return { order, skipped: true as const };
    }

    const allowed: Record<string, RedemptionStatus[]> = {
      PENDING: [RedemptionStatus.CANCELLED],
      CONFIRMED: [RedemptionStatus.PROCESSING, RedemptionStatus.CANCELLED, RedemptionStatus.RETURNED],
      PROCESSING: [RedemptionStatus.DISPATCHED, RedemptionStatus.FAILED, RedemptionStatus.CANCELLED],
      DISPATCHED: [RedemptionStatus.DELIVERED, RedemptionStatus.RETURNED],
      // DELIVERED→RETURNED (Gifsy-only) — the v1 value-reversal edge (§12). Gated to
      // gifts by the cash-mode block below; refunds points + zeroes valuePaise.
      DELIVERED: [RedemptionStatus.RETURNED],
    };
    const fromStatus = order.status;
    if (!(allowed[fromStatus] ?? []).includes(toStatus)) {
      throw new BadRequestException(`Illegal status transition: ${fromStatus} → ${toStatus}`);
    }

    const isRefundTarget =
      toStatus === RedemptionStatus.CANCELLED ||
      toStatus === RedemptionStatus.RETURNED ||
      toStatus === RedemptionStatus.FAILED;

    // INR (cash) redemptions cannot be manually reversed once OTP-confirmed: the
    // bank transfer happens offline and reversal is driven ONLY by an uploaded
    // UTR=FAILED (payouts.uploadPayoutUtr, which marks the order FAILED + refunds
    // points + flips the PayoutTransaction together). A manual transitionOrder to
    // ANY refund target (CANCELLED / RETURNED / FAILED) would re-credit the points
    // while leaving the PayoutTransaction PENDING and still payable → double-payout
    // (BUG-1). So block every refund-target edge for cash modes, not just CANCELLED.
    // Non-refund progressions (PROCESSING/DISPATCHED/DELIVERED) and non-cash
    // redemptions (gift card / physical gift) are unaffected.
    const isCashMode =
      order.redemptionMode === PayoutMode.UPI ||
      order.redemptionMode === PayoutMode.BANK_TRANSFER;
    if (isCashMode && isRefundTarget) {
      throw new BadRequestException(
        'INR redemptions cannot be cancelled, returned or failed manually once confirmed; ' +
          'reversal is driven only by an uploaded UTR=FAILED.',
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
      // Dispatch fields (§5) — the fulfilment console stamps these alongside a status
      // move. All optional; undefined leaves the stored value unchanged.
      fulfilmentChannel: dto.fulfilmentChannel,
      logisticsPartner: dto.logisticsPartner,
      supplierOrderRef: dto.supplierOrderRef,
      podUrl: dto.podUrl,
    };
    if (toStatus === RedemptionStatus.DISPATCHED) data.dispatchedAt = now;
    if (toStatus === RedemptionStatus.DELIVERED) data.deliveredAt = now;
    if (toStatus === RedemptionStatus.CANCELLED) data.cancelledAt = now;
    // RETURNED value-reversal (§12): zero valuePaise so 194R Source-2 (sums DELIVERED
    // valuePaise per PAN) and the Gift Disbursal report drop it — no permanent
    // over-count. Points are refunded by the isRefundTarget claim below.
    if (toStatus === RedemptionStatus.RETURNED) data.valuePaise = 0n;

    const updated = await this.prisma.$transaction(async (tx) => {
      // M2 — refund at most ONCE: atomically claim the debited points
      // (pointsDeducted > 0 → 0). Only the tx that wins the claim re-credits, so
      // two concurrent refund-bound transitions can't double-refund.
      // STOCK: intentionally NOT restored here (owner decision 2026-08-19) — a
      // confirmed redemption consumes its stock unit permanently; cancel / return
      // / failed refunds POINTS only. See the STOCK RULE note near the catalog CRUD.
      if (isRefundTarget) {
        const refundClaim = await tx.redemptionOrder.updateMany({
          where: { id, pointsDeducted: { gt: 0 } },
          data: { pointsDeducted: 0 },
        });
        if (refundClaim.count > 0) {
          await this.wallet.reverse(
            order.partnerId,
            order.pointsDeducted,
            { referenceId: id, description: `Refund ${order.orderNumber}` },
            tx,
          );
        }
      }

      const o = await tx.redemptionOrder.update({ where: { id }, data });

      await tx.redemptionStatusHistory.create({
        data: {
          orderId: id,
          fromStatus,
          toStatus,
          changedById: user.sub,
          notes: dto.notes,
        },
      });

      return o;
    });

    // Notify the partner on the customer-visible milestones.
    if (
      toStatus === RedemptionStatus.DISPATCHED ||
      toStatus === RedemptionStatus.DELIVERED ||
      toStatus === RedemptionStatus.CANCELLED
    ) {
      const partner = await this.prisma.channelPartner.findFirst({
        where: { id: order.partnerId },
        select: { userId: true, phone: true, ownerName: true },
      });
      if (partner?.userId) {
        // Fan the customer-visible milestone out to the bell feed (IN_APP) + PUSH AND the
        // config-driven SMS/WhatsApp to the OWNER — via the single canonical path. The dead
        // direct SMS enqueue is removed; the ORDER_* paid channels default OFF until a tenant
        // enables them. Best-effort: never throws into the transition path.
        await this.notifications.notifyUserWithChannels({
          clientId: user.clientId,
          userId: partner.userId,
          eventKey: `ORDER_${toStatus}` as EventKey,
          recipientPhone: partner.phone ?? null,
          vars: {
            ownerName: partner.ownerName ?? 'Partner',
            orderId: order.orderNumber,
            trackingId: dto.trackingNumber ?? '',
            reason: dto.notes ?? '',
          },
          subject: 'Redemption update',
          body: `Your redemption ${order.orderNumber} is now ${toStatus}.`,
          url: '/partner/rewards',
          event: `REDEMPTION_${toStatus}`,
        });
      }
    }

    return { order: updated };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // P5.4b — BULK fulfilment (Gifsy-ops download → fill → upload), mirroring the
  // payout/target download→fill→upload flow and reusing the shared xlsx helper
  // (src/common/xlsx.ts is the multi-sheet builder; this single-sheet template +
  // its parser live in rewards-fulfilment.helpers.ts, matching the P4
  // targets.helpers.ts split: a pure, DI-free build/parse pair).
  //
  // The upload APPLIES each row through the EXISTING guarded transitionOrder /
  // updateOrder — no status logic is reimplemented here, so every row inherits
  // the edge-map validation, RedemptionStatusHistory, timestamp stamping,
  // refund-on-cancel and partner notification. One bad row never aborts the batch.
  //
  // The fulfilment-actionable set (orders that NEED a voucher or tracking):
  //   GIFT_CARD     → CONFIRMED / PROCESSING       (need a voucherCode)
  //   PHYSICAL_GIFT → CONFIRMED / PROCESSING / DISPATCHED (need tracking)
  // A `?status=` or `?mode=` query narrows it further.
  // ───────────────────────────────────────────────────────────────────────────

  /** PayoutMode → the statuses that are actionable for fulfilment. */
  private fulfilmentStatusesFor(mode: PayoutMode): RedemptionStatus[] {
    if (mode === PayoutMode.PHYSICAL_GIFT) {
      return [RedemptionStatus.CONFIRMED, RedemptionStatus.PROCESSING, RedemptionStatus.DISPATCHED];
    }
    // GIFT_CARD / VOUCHER (and any cash mode that still surfaces here) → voucher entry.
    return [RedemptionStatus.CONFIRMED, RedemptionStatus.PROCESSING];
  }

  /**
   * GET /v1/admin/rewards/fulfilment/template — download an .xlsx of the tenant's
   * orders awaiting fulfilment. Tenant-scoped; default rows = the per-mode
   * actionable set, narrowable by `?status=` and `?mode=`.
   */
  async getFulfilmentTemplate(user: JwtPayload, q: FulfilmentTemplateQueryDto): Promise<Buffer> {
    // Tenant scope by partner.clientId (§12); platformWide OWNER → all tenants.
    const scope = tenantScope(user);
    const where: Prisma.RedemptionOrderWhereInput = {
      ...(scope ? { partner: { clientId: scope } } : {}),
    };
    if (q.mode) where.redemptionMode = q.mode;

    if (q.status) {
      where.status = q.status;
    } else {
      // Union of the actionable statuses across the relevant mode(s).
      const modes: PayoutMode[] = q.mode
        ? [q.mode]
        : [PayoutMode.GIFT_CARD, PayoutMode.PHYSICAL_GIFT];
      const statuses = new Set<RedemptionStatus>();
      for (const m of modes) for (const s of this.fulfilmentStatusesFor(m)) statuses.add(s);
      where.status = { in: [...statuses] };
    }

    const orders = await this.prisma.redemptionOrder.findMany({
      where,
      include: { reward: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return buildFulfilmentTemplateBuffer(
      orders.map((o) => ({
        orderNumber: o.orderNumber,
        reward: o.reward?.name ?? '',
        mode: o.redemptionMode,
        currentStatus: o.status,
      })),
    );
  }

  /**
   * POST /v1/admin/rewards/fulfilment/upload — parse a filled fulfilment sheet
   * and apply each row.
   *
   * Per row:
   *   • Match `Order Number` → the tenant's RedemptionOrder (cross-tenant / unknown
   *     → collected as an error, batch continues).
   *   • `New Status` PRESENT → apply via the guarded `transitionOrder` (carries the
   *     voucher/tracking from the row). NEW-STATUS-BLANK DECISION: a blank New
   *     Status means "no status change" → we route through the non-status
   *     `updateOrder` path to set voucherCode/voucherProvider/tracking only (so an
   *     ops user can stamp a voucher code without forcing a transition).
   *   • An unknown / illegal New Status value, an illegal edge, or any per-row
   *     throw is caught and collected; the batch is NOT aborted.
   *
   * Returns { processed, succeeded, failed, errors:[{ row, orderNumber, message }] }
   * (mirrors the P4 achievement-upload result shape).
   */
  async uploadFulfilment(user: JwtPayload, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');

    // A malformed/corrupt/non-template workbook → clean 400 (like the P4 parser).
    let parsed: ReturnType<typeof parseFulfilmentUploadBuffer>;
    try {
      parsed = parseFulfilmentUploadBuffer(file.buffer);
    } catch {
      throw new BadRequestException(
        'Invalid or unrecognized fulfilment file — download the template, fill it, and re-upload',
      );
    }

    const validStatuses = new Set<string>(Object.values(UpdatableOrderStatus));
    const errors: { row: number; orderNumber: string; message: string }[] = [];
    let succeeded = 0;
    let skipped = 0;
    // Tenant scope by partner.clientId (§12); platformWide OWNER → cross-tenant.
    const scope = tenantScope(user);

    for (const r of parsed.rows) {
      try {
        // Resolve the order in-scope; collect (don't throw) on a miss/cross-tenant.
        const order = await this.prisma.redemptionOrder.findFirst({
          where: { orderNumber: r.orderNumber, ...(scope ? { partner: { clientId: scope } } : {}) },
          select: { id: true },
        });
        if (!order) {
          errors.push({
            row: r.rowIndex,
            orderNumber: r.orderNumber,
            message: 'Order not found in this tenant',
          });
          continue;
        }

        if (r.newStatus) {
          if (!validStatuses.has(r.newStatus)) {
            errors.push({
              row: r.rowIndex,
              orderNumber: r.orderNumber,
              message: `Unknown New Status "${r.newStatus}"`,
            });
            continue;
          }
          // Guarded transition — reuses the edge-map, history, timestamps,
          // refund-on-cancel and partner notification.
          await this.transitionOrder(user, order.id, {
            toStatus: r.newStatus as UpdatableOrderStatus,
            voucherCode: r.voucherCode,
            voucherProvider: r.voucherProvider,
            trackingNumber: r.trackingNumber,
            trackingUrl: r.trackingUrl,
          });
        } else {
          // No status change → non-status write (voucher/tracking only). If every
          // fill column is blank too, the row changes nothing (e.g. an unmodified
          // template re-uploaded) — skip it so the success count isn't inflated.
          if (
            !r.voucherCode &&
            !r.voucherProvider &&
            !r.trackingNumber &&
            !r.trackingUrl
          ) {
            skipped++;
            continue;
          }
          await this.updateOrder(user, order.id, {
            voucherCode: r.voucherCode,
            voucherProvider: r.voucherProvider,
            trackingNumber: r.trackingNumber,
            trackingUrl: r.trackingUrl,
          });
        }
        succeeded++;
      } catch (e) {
        errors.push({
          row: r.rowIndex,
          orderNumber: r.orderNumber,
          message: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }

    return {
      processed: parsed.rows.length,
      succeeded,
      skipped,
      failed: errors.length,
      errors,
    };
  }

  /**
   * GET /v1/admin/gift-catalogue/dispatch/orders — GIFSY fulfilment console list.
   *
   * Cross-tenant for an un-assumed OWNER (platformWide); scoped to the assumed tenant
   * otherwise (tenantScope). Filters: status, fulfilmentChannel, a specific clientId,
   * an orderNumber search, and a createdAt date range. Each order is annotated with a
   * channel-aware dispatch-SLA (GIFSY_WAREHOUSE/BRAND age against the business-hours
   * clock; Amazon/DIGITAL are exempt). Reuses the platform holiday calendar.
   */
  async listFulfilmentOrders(user: JwtPayload, q: FulfilmentOrdersQueryDto) {
    this.assertOperator(user);
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const scope = tenantScope(user);
    // A platformWide OWNER (scope undefined) may narrow to one tenant via q.clientId.
    // An ASSUMED operator is HARD-pinned to `scope` — q.clientId must NOT override it
    // (that would be a cross-tenant leak), so it is ignored for a scoped caller.
    const effectiveClientId = scope ?? q.clientId;
    const where: Prisma.RedemptionOrderWhereInput = {
      ...(effectiveClientId ? { partner: { clientId: effectiveClientId } } : {}),
    };
    if (q.status) where.status = q.status;
    if (q.channel) where.fulfilmentChannel = q.channel;
    if (q.q) where.orderNumber = { contains: q.q, mode: 'insensitive' };
    // WAVE-2 SEAM: a `vendorId` filter (where.fulfilledByVendorId) lands here for the
    // vendor-scoped console once vendor fulfilment ships.
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) where.createdAt.gte = new Date(q.from);
      if (q.to) where.createdAt.lte = new Date(q.to);
    }

    const [orders, total, holidays] = await Promise.all([
      this.prisma.redemptionOrder.findMany({
        where,
        include: {
          reward: { select: { id: true, name: true, sourceType: true } },
          partner: { select: { id: true, businessName: true, clientId: true } },
          statusHistory: {
            where: { toStatus: 'CONFIRMED' },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { createdAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.redemptionOrder.count({ where }),
      loadHolidaySet(this.prisma),
    ]);

    // Tenant display names for the cross-tenant console (clientId → Client.internalName).
    const clientIds = [...new Set(orders.map((o) => o.partner?.clientId).filter(Boolean))] as string[];
    const clients = clientIds.length
      ? await this.prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, internalName: true },
        })
      : [];
    const tenantName = new Map(clients.map((c) => [c.id, c.internalName]));

    const nowMs = Date.now();
    const items = orders.map((o) => {
      const confirmedAt = o.statusHistory[0]?.createdAt ?? null;
      const sla = computeDispatchSla({
        fulfilmentChannel: o.fulfilmentChannel,
        status: o.status,
        confirmedAtMs: confirmedAt ? confirmedAt.getTime() : null,
        dispatchedAtMs: o.dispatchedAt ? o.dispatchedAt.getTime() : null,
        nowMs,
        slaBusinessHours: DISPATCH_SLA_BUSINESS_HOURS,
        holidays,
      });
      const clientId = o.partner?.clientId ?? null;
      // GiftOrderSummary — flat wire shape the FE console reads (renamed/derived fields).
      // valuePaise is BigInt → serialise to string for the JSON envelope.
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        clientId,
        tenantName: clientId ? tenantName.get(clientId) ?? clientId : null,
        status: o.status,
        redemptionMode: o.redemptionMode,
        fulfilmentChannel: o.fulfilmentChannel,
        rewardName: o.reward?.name ?? null,
        partnerName: o.partner?.businessName ?? null,
        totalPointsCost: o.totalPointsCost,
        valuePaise: o.valuePaise != null ? o.valuePaise.toString() : null,
        trackingNumber: o.trackingNumber,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        dispatchSla: sla,
      };
    });

    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * GET /v1/admin/gift-catalogue/dispatch/orders/:id — GIFSY console order detail.
   * Cross-tenant for a platformWide OWNER; assumed-tenant-scoped otherwise. Includes
   * the full status timeline + the internal "fulfilled by" context (§12).
   */
  async getFulfilmentOrder(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const scope = tenantScope(user);
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, ...(scope ? { partner: { clientId: scope } } : {}) },
      include: {
        reward: { select: { id: true, name: true, sourceType: true, giftMasterId: true, vendorId: true } },
        partner: { select: { id: true, businessName: true, clientId: true } },
        fulfilledByVendor: { select: { id: true, name: true, status: true } },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: { fromStatus: true, toStatus: true, changedById: true, notes: true, createdAt: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Resolve actor display names for the status timeline (changedById → User.name).
    const actorIds = [...new Set(order.statusHistory.map((h) => h.changedById).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    // Tenant display name (clientId → Client.internalName).
    const clientId = order.partner?.clientId ?? null;
    const client = clientId
      ? await this.prisma.client.findUnique({ where: { id: clientId }, select: { internalName: true } })
      : null;

    // Delivery PII as a single flat block (ops-visible; never on the member tile).
    const addressLine = [
      order.deliveryAddressLine1,
      order.deliveryAddressLine2,
      order.deliveryCity,
      order.deliveryState,
      order.deliveryPincode,
    ]
      .filter(Boolean)
      .join(', ');
    const delivery =
      order.deliveryName || addressLine || order.deliveryPhone
        ? {
            name: order.deliveryName ?? null,
            address: addressLine || null,
            phone: order.deliveryPhone ?? null,
          }
        : null;

    const statusHistory = order.statusHistory.map((h) => ({
      status: h.toStatus,
      at: h.createdAt,
      note: h.notes ?? null,
      byName: h.changedById ? actorName.get(h.changedById) ?? null : null,
    }));

    // Derive the milestone timestamps the FE reads (no dedicated columns for
    // confirmed/processed/returned — sourced from the authoritative status history).
    const stampFor = (status: string) =>
      order.statusHistory.find((h) => h.toStatus === status)?.createdAt ?? null;

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      clientId,
      tenantName: client?.internalName ?? clientId,
      status: order.status,
      redemptionMode: order.redemptionMode,
      rewardName: order.reward?.name ?? null,
      partnerName: order.partner?.businessName ?? null,
      totalPointsCost: order.totalPointsCost,
      quantity: order.quantity,
      valuePaise: order.valuePaise != null ? order.valuePaise.toString() : null,
      fulfilmentChannel: order.fulfilmentChannel,
      logisticsPartner: order.logisticsPartner,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      supplierOrderRef: order.supplierOrderRef,
      voucherCode: order.voucherCode,
      voucherProvider: order.voucherProvider,
      fulfilledByVendorId: order.fulfilledByVendorId,
      fulfilledByVendorName: order.fulfilledByVendor?.name ?? null,
      delivery,
      statusHistory,
      confirmedAt: stampFor('CONFIRMED'),
      processedAt: stampFor('PROCESSING'),
      dispatchedAt: order.dispatchedAt,
      deliveredAt: order.deliveredAt,
      cancelledAt: order.cancelledAt,
      returnedAt: stampFor('RETURNED') ?? (order.status === 'RETURNED' ? order.updatedAt : null),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  /**
   * Validate the unverified REDEMPTION_CONFIRM OTP issued for a SPECIFIC order and return its id.
   * Self-contained (does NOT reuse auth.verifyOtp, which auto-registers users).
   * Bumps attempts + 401 on a miss. Does NOT set verifiedAt — the caller marks it
   * INSIDE the confirm transaction so a failed debit rolls the OTP back (M1).
   * FIXED_OTP is honoured ONLY outside production — a dev backdoor on a money
   * confirm must never be live in prod (H2).
   *
   * AUDIT FIX (MED): scoped to `orderId` (OtpCode.referenceId). A login can now hold concurrent
   * PENDING orders across outlets (login picker) whose OTPs share the same login user, so a
   * user-level lookup could let one order's confirm consume another order's OTP. The referenceId
   * filter binds the confirm to the OTP issued for THIS order.
   */
  private async verifyRedemptionOtp(userId: string, otp: string, orderId: string): Promise<string> {
    const record = await this.prisma.otpCode.findFirst({
      where: { userId, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null, referenceId: orderId },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) {
      throw new UnauthorizedException('No active OTP found. Please restart the redemption.');
    }
    if (record.attempts >= record.maxAttempts) {
      throw new UnauthorizedException('Too many attempts — please restart the redemption.');
    }
    if (new Date() > record.expiresAt) {
      throw new UnauthorizedException('OTP expired — please restart the redemption.');
    }

    const fixedOtp = isFixedOtpAllowed() ? process.env.FIXED_OTP : undefined;
    const isCorrect = fixedOtp ? otp === fixedOtp : otp === record.code;
    if (!isCorrect) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: record.attempts + 1 },
      });
      const remaining = record.maxAttempts - record.attempts - 1;
      throw new UnauthorizedException(
        `Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      );
    }

    return record.id;
  }

  /** 6-digit OTP (100000–999999) via CSPRNG — see common/otp.ts (AF-10). */
  private generateOtpCode(): string {
    return generateNumericOtp();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // P5.3 — Admin Reward Catalog CRUD (real RewardCategory / RewardCatalog).
  // Supersedes the World-B `admin/gift-config` JSON blob (retired with the FE in
  // 5.5). Every query is tenant-scoped by clientId from the JWT.
  //
  // STOCK RULE (the simplest coherent choice): `stockQuantity` null/absent =
  // untracked (always purchasable). When a write sets stockQuantity === 0, the
  // service forces status = OUT_OF_STOCK so the partner read (filters
  // status='ACTIVE') drops the item; setting stock > 0 again does NOT auto-flip
  // status back to ACTIVE — an admin re-activates explicitly (avoids resurrecting
  // a DISCONTINUED item). Stock is NOT decremented on this CRUD path — the
  // CONFIRM path does it: confirmRedeem / confirmRedeemForOutlet atomically
  // decrement stockQuantity (guarded `updateMany` WHERE stockQuantity >= quantity
  // → rejects the last-unit race, oversell-safe) and flip status to OUT_OF_STOCK
  // when it reaches 0.
  //
  // ⚠️ DELIBERATE, NON-OBVIOUS (owner decision 2026-08-19): a confirmed
  // redemption CONSUMES its stock unit PERMANENTLY. Stock is intentionally NOT
  // restored on cancel/return/failed — `transitionOrder` refunds the POINTS only
  // and never re-increments stockQuantity. An item that flipped OUT_OF_STOCK
  // stays out until an admin explicitly re-stocks / re-activates it. This is by
  // design (not a gap) — do NOT add a stock-restore to the refund path.
  // ───────────────────────────────────────────────────────────────────────────

  /** POST /v1/admin/rewards/categories — create a tenant-scoped category. */
  async createCategory(user: JwtPayload, dto: CreateRewardCategoryDto) {
    // A parent, if given, must belong to the same tenant.
    if (dto.parentId) {
      const parent = await this.prisma.rewardCategory.findFirst({
        where: { id: dto.parentId, clientId: user.clientId },
      });
      if (!parent) throw new BadRequestException('Parent category not found in this tenant');
    }

    // `code` is the human key — keep it unique within the tenant.
    const clash = await this.prisma.rewardCategory.findFirst({
      where: { clientId: user.clientId, code: dto.code },
    });
    if (clash) throw new ConflictException('A category with this code already exists');

    const category = await this.prisma.rewardCategory.create({
      data: {
        clientId: user.clientId,
        parentId: dto.parentId ?? null,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    return { category };
  }

  /** GET /v1/admin/rewards/categories — list ALL tenant categories (incl. inactive). */
  async listCategories(user: JwtPayload) {
    const categories = await this.prisma.rewardCategory.findMany({
      where: { clientId: user.clientId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return { categories };
  }

  /**
   * GET /v1/admin/rewards/catalog — admin catalogue list (ALL statuses, non-deleted),
   * tenant-scoped, with the category name. Unlike the partner `listCatalog`, this is
   * NOT filtered to ACTIVE — admins manage inactive/out-of-stock/discontinued items.
   */
  async adminListCatalog(user: JwtPayload, q: AdminListCatalogQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.RewardCatalogWhereInput = {
      clientId: user.clientId,
      deletedAt: null,
    };
    if (q.status) where.status = q.status;
    if (q.categoryId) where.categoryId = q.categoryId;

    const [items, total] = await Promise.all([
      this.prisma.rewardCatalog.findMany({
        where,
        include: { category: { select: { id: true, name: true, code: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.rewardCatalog.count({ where }),
    ]);

    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** PATCH /v1/admin/rewards/categories/:id — tenant-scoped update. */
  async updateCategory(user: JwtPayload, id: string, dto: UpdateRewardCategoryDto) {
    const existing = await this.prisma.rewardCategory.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!existing) throw new NotFoundException('Category not found');

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      const parent = await this.prisma.rewardCategory.findFirst({
        where: { id: dto.parentId, clientId: user.clientId },
      });
      if (!parent) throw new BadRequestException('Parent category not found in this tenant');
    }

    if (dto.code !== undefined && dto.code !== existing.code) {
      const clash = await this.prisma.rewardCategory.findFirst({
        where: { clientId: user.clientId, code: dto.code },
      });
      if (clash) throw new ConflictException('A category with this code already exists');
    }

    const category = await this.prisma.rewardCategory.update({
      where: { id },
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        parentId: dto.parentId,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });
    return { category };
  }

  /**
   * DELETE /v1/admin/rewards/categories/:id — DEACTIVATE via isActive=false.
   * `RewardCategory` has no `deletedAt` column: this is a reversible toggle, not a
   * soft-delete. Re-deleting an already-inactive category is a harmless no-op, and
   * PATCH { isActive: true } intentionally reactivates it (catalog items, by
   * contrast, ARE soft-deleted via deletedAt). Blocked if the category still has
   * non-deleted catalog items (prevents orphaning the items' FK + a dangling
   * partner-facing category).
   */
  async deleteCategory(user: JwtPayload, id: string) {
    const existing = await this.prisma.rewardCategory.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!existing) throw new NotFoundException('Category not found');

    const itemCount = await this.prisma.rewardCatalog.count({
      where: { categoryId: id, clientId: user.clientId, deletedAt: null },
    });
    if (itemCount > 0) {
      throw new ConflictException(
        'Category has active catalog items; remove or re-home them first',
      );
    }

    const category = await this.prisma.rewardCategory.update({
      where: { id },
      data: { isActive: false },
    });
    return { category };
  }

  /**
   * POST /v1/admin/rewards/catalog — create a catalog item.
   * Validates: categoryId belongs to the tenant; min <= max when both set.
   * (pointsCost >= 0 is enforced by the DTO.)
   */
  async createCatalogItem(user: JwtPayload, dto: CreateRewardCatalogDto) {
    const category = await this.prisma.rewardCategory.findFirst({
      where: { id: dto.categoryId, clientId: user.clientId },
    });
    if (!category) throw new BadRequestException('Category not found in this tenant');

    this.assertRedemptionRange(dto.minRedemptionPoints, dto.maxRedemptionPoints);

    // A pointsCost-0 item is only ever a FREE_AMOUNT voucher, and it MUST carry a
    // complete [min, max] range — reject a half-configured one (see the helper).
    this.assertFreeAmountComplete(
      dto.pointsCost,
      dto.minRedemptionPoints,
      dto.maxRedemptionPoints,
    );

    // Code unique within the tenant (among non-deleted items).
    const clash = await this.prisma.rewardCatalog.findFirst({
      where: { clientId: user.clientId, code: dto.code, deletedAt: null },
    });
    if (clash) throw new ConflictException('A catalog item with this code already exists');

    // Stock rule: explicit 0 forces OUT_OF_STOCK regardless of requested status.
    const status =
      dto.stockQuantity === 0 ? 'OUT_OF_STOCK' : dto.status ?? 'ACTIVE';

    // Stock decrement lives in the CONFIRM path (confirmRedeem /
    // confirmRedeemForOutlet): guarded atomic decrement + OUT_OF_STOCK flip at 0.
    // This CRUD path only sets the initial value. By design, stock is NOT restored
    // on cancel/return/failed (owner 2026-08-19) — see the STOCK RULE note above.
    const item = await this.prisma.rewardCatalog.create({
      data: {
        clientId: user.clientId,
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        pointsCost: dto.pointsCost,
        mrpPaise: dto.mrpPaise,
        redemptionMode: dto.redemptionMode,
        status,
        minRedemptionPoints: dto.minRedemptionPoints,
        maxRedemptionPoints: dto.maxRedemptionPoints,
        stockQuantity: dto.stockQuantity,
        termsAndConditions: dto.termsAndConditions,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    return { item };
  }

  /** PATCH /v1/admin/rewards/catalog/:id — tenant-scoped, non-deleted item. */
  async updateCatalogItem(user: JwtPayload, id: string, dto: UpdateRewardCatalogDto) {
    const existing = await this.prisma.rewardCatalog.findFirst({
      where: { id, clientId: user.clientId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Reward item not found');

    if (dto.categoryId !== undefined) {
      const category = await this.prisma.rewardCategory.findFirst({
        where: { id: dto.categoryId, clientId: user.clientId },
      });
      if (!category) throw new BadRequestException('Category not found in this tenant');
    }

    // Validate the EFFECTIVE values Prisma will actually persist. `undefined` in the
    // DTO means "leave unchanged" (Prisma skips it); an explicit null/value is written —
    // so mirror that here (a bare `??` would collapse an explicit null into the stored
    // value and let a max-clearing PATCH slip a free-amount voucher into a broken state).
    const effPoints = dto.pointsCost !== undefined ? dto.pointsCost : existing.pointsCost;
    const effMin =
      dto.minRedemptionPoints !== undefined ? dto.minRedemptionPoints : existing.minRedemptionPoints;
    const effMax =
      dto.maxRedemptionPoints !== undefined ? dto.maxRedemptionPoints : existing.maxRedemptionPoints;
    this.assertRedemptionRange(effMin, effMax);
    this.assertFreeAmountComplete(effPoints, effMin, effMax);

    if (dto.code !== undefined && dto.code !== existing.code) {
      const clash = await this.prisma.rewardCatalog.findFirst({
        where: { clientId: user.clientId, code: dto.code, deletedAt: null },
      });
      if (clash) throw new ConflictException('A catalog item with this code already exists');
    }

    // Stock rule: an item can never read as ACTIVE while its EFFECTIVE stock
    // (payload value if present, else the stored value) is 0 — otherwise a bare
    // `{ status: 'ACTIVE' }` PATCH would re-list a genuinely out-of-stock item.
    // Setting stock to 0 also forces OUT_OF_STOCK. Raising stock does NOT
    // auto-reactivate (admin re-activates explicitly).
    const effectiveStock =
      dto.stockQuantity !== undefined ? dto.stockQuantity : existing.stockQuantity;
    let status = dto.status;
    if (effectiveStock === 0 && (status === 'ACTIVE' || dto.stockQuantity === 0)) {
      status = 'OUT_OF_STOCK';
    }

    const item = await this.prisma.rewardCatalog.update({
      where: { id },
      data: {
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        pointsCost: dto.pointsCost,
        mrpPaise: dto.mrpPaise,
        redemptionMode: dto.redemptionMode,
        status,
        // Bounds are meaningful ONLY for a FREE_AMOUNT item (effPoints === 0). On a
        // FIXED item (or a FREE→FIXED transition) force them null so a direct-API PATCH
        // can't leave stale [min,max] on the row; for a FREE item write the DTO value
        // (undefined = keep existing, which the guard has already validated as complete).
        minRedemptionPoints: effPoints === 0 ? dto.minRedemptionPoints : null,
        maxRedemptionPoints: effPoints === 0 ? dto.maxRedemptionPoints : null,
        stockQuantity: dto.stockQuantity,
        termsAndConditions: dto.termsAndConditions,
        sortOrder: dto.sortOrder,
      },
    });
    return { item };
  }

  /**
   * DELETE /v1/admin/rewards/catalog/:id — soft delete (sets deletedAt),
   * mirroring the read filter `deletedAt: null` so the item drops from the
   * active catalog immediately.
   */
  async deleteCatalogItem(user: JwtPayload, id: string) {
    const existing = await this.prisma.rewardCatalog.findFirst({
      where: { id, clientId: user.clientId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Reward item not found');

    const item = await this.prisma.rewardCatalog.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { item };
  }

  /**
   * Address quality (§12) — validate a delivery pincode for a physical gift at
   * redeem. The DTO already enforces 6 digits; this adds the real-India rule (first
   * digit 1–9 — no Indian PIN starts with 0). Serviceability lookup is out of scope
   * (no serviceability dataset in v1); this is format/plausibility only.
   */
  private assertValidPincode(pincode?: string | null) {
    if (!pincode || !/^[1-9]\d{5}$/.test(pincode)) {
      throw new BadRequestException(
        'A valid 6-digit delivery pincode is required for physical gifts.',
      );
    }
  }

  /** min <= max when both bounds are provided (FREE_AMOUNT voucher range). */
  private assertRedemptionRange(min?: number | null, max?: number | null) {
    if (min != null && max != null && min > max) {
      throw new BadRequestException(
        'minRedemptionPoints must be <= maxRedemptionPoints',
      );
    }
  }

  /**
   * A `pointsCost === 0` catalog item is only ever a FREE_AMOUNT (variable-amount)
   * voucher, and isFreeAmount() treats an item as free-amount ONLY when BOTH bounds
   * are set. A half-configured one (a min but no max, or neither) silently degrades
   * to a "fixed, cost 0" item that every redeem rejects with "Redemption must cost a
   * positive number of points" — an un-redeemable voucher that still looks fine in the
   * catalogue. Reject it at write time so a broken voucher can never be saved.
   */
  private assertFreeAmountComplete(
    pointsCost: number | null | undefined,
    min?: number | null,
    max?: number | null,
  ) {
    if (pointsCost !== 0) return;
    if (min == null || max == null) {
      throw new BadRequestException(
        'A variable-amount (FREE_AMOUNT) voucher requires both minRedemptionPoints and maxRedemptionPoints.',
      );
    }
    if (min < 1) {
      throw new BadRequestException(
        'A variable-amount (FREE_AMOUNT) voucher must have minRedemptionPoints >= 1',
      );
    }
  }
}
