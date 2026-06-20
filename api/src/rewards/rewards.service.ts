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
import { PayoutMode, Prisma, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { roundToRupeePaise } from '../tds/tds.helpers';
import {
  AdminListCatalogQueryDto,
  CreateRewardCatalogDto,
  CreateRewardCategoryDto,
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
@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  // Matches WalletService: 1 point = ₹1 by default; overridable via env.
  private readonly conversionRate = parseFloat(process.env.POINTS_CONVERSION_RATE ?? '1');

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
  ) {}

  private isGifsy(user: JwtPayload): boolean {
    return user.role === 'GIFSY_ADMIN';
  }

  /** GET /v1/rewards/catalog — active catalog with per-item affordability vs the caller's wallet. */
  async listCatalog(user: JwtPayload, q: ListCatalogQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.RewardCatalogWhereInput = {
      status: 'ACTIVE',
      deletedAt: null,
      clientId: user.clientId,
    };
    if (q.minPoints !== undefined || q.maxPoints !== undefined) {
      where.pointsCost = {};
      if (q.minPoints !== undefined) where.pointsCost.gte = q.minPoints;
      if (q.maxPoints !== undefined) where.pointsCost.lte = q.maxPoints;
    }

    // Get caller's wallet balance to flag eligible items.
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId } },
    });
    const wallet = partner
      ? await this.prisma.wallet.findFirst({ where: { partnerId: partner.id } })
      : null;
    const userBalance = wallet ? wallet.redeemablePoints : 0;

    const [items, total] = await Promise.all([
      this.prisma.rewardCatalog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { pointsCost: 'asc' },
      }),
      this.prisma.rewardCatalog.count({ where }),
    ]);

    const enriched = items.map((item) => ({
      ...item,
      isAffordable: userBalance >= item.pointsCost,
    }));

    return {
      items: enriched,
      userBalance,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/rewards/catalog/:id — a single active (non-deleted) catalog item in the tenant. */
  async getCatalogItem(user: JwtPayload, id: string) {
    const item = await this.prisma.rewardCatalog.findFirst({
      where: { id, deletedAt: null, clientId: user.clientId },
    });
    if (!item) throw new NotFoundException('Reward item not found');
    return { item };
  }

  /** GET /v1/rewards/orders — paginated redemption orders (own only for non-admins). */
  async listOrders(user: JwtPayload, q: ListOrdersQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.RedemptionOrderWhereInput = {
      partner: { user: { clientId: user.clientId } },
    };
    if (!this.isGifsy(user)) {
      const partner = await this.prisma.channelPartner.findFirst({
        where: { userId: user.sub, user: { clientId: user.clientId } },
      });
      where.partnerId = partner?.id ?? 'none';
    }
    if (q.status) where.status = q.status;

    const [orders, total] = await Promise.all([
      this.prisma.redemptionOrder.findMany({
        where,
        include: {
          reward: { select: { id: true, name: true, imageUrls: true } },
          partner: { select: { id: true, businessName: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.redemptionOrder.count({ where }),
    ]);

    return {
      orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/rewards/orders/:id — one order; non-admins may only see their own. */
  async getOrder(user: JwtPayload, id: string) {
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, partner: { user: { clientId: user.clientId } } },
      include: {
        reward: true,
        partner: { select: { id: true, businessName: true, userId: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Non-admins can only see their own orders.
    if (!this.isGifsy(user) && order.partner?.userId !== user.sub) {
      throw new ForbiddenException('Forbidden');
    }

    return { order };
  }

  /**
   * PATCH /v1/rewards/orders/:id — GIFSY-only NON-STATUS edits (tracking / notes /
   * voucher). Status changes are NOT accepted here: every status move must go
   * through `transitionOrder` (the guarded edge-map + refund path). 5.4b's bulk
   * fulfilment upload reuses this same non-status write.
   */
  async updateOrder(user: JwtPayload, id: string, dto: UpdateOrderDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope re-checked here.
    const existingOrder = await this.prisma.redemptionOrder.findFirst({
      where: { id, partner: { user: { clientId: user.clientId } } },
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

  /** Resolve the caller's tenant-scoped ChannelPartner or throw 404. */
  private async requirePartner(user: JwtPayload) {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId } },
    });
    if (!partner) throw new NotFoundException('Partner account not found');
    return partner;
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
      where: { id: dto.rewardId, status: 'ACTIVE', deletedAt: null, clientId: user.clientId },
    });
    if (!item) throw new NotFoundException('Reward item not found or not available');

    // PHYSICAL_GIFT requires a full delivery address; other modes do not.
    if (item.redemptionMode === 'PHYSICAL_GIFT' && !dto.deliveryAddress) {
      throw new BadRequestException('Delivery address is required for physical gifts');
    }

    // Points cost: FREE_AMOUNT = round(amount × rate) bounded by min/max; else pointsCost × qty.
    let requiredPoints: number;
    if (this.isFreeAmount(item)) {
      if (dto.amount == null) {
        throw new BadRequestException('amount (₹) is required for a variable-amount voucher');
      }
      requiredPoints = Math.round(dto.amount * this.conversionRate);
      const min = item.minRedemptionPoints as number;
      const max = item.maxRedemptionPoints as number;
      if (requiredPoints < min || requiredPoints > max) {
        throw new BadRequestException(
          `Amount out of range. Allowed: ${min}–${max} points, requested: ${requiredPoints}`,
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

    const orderNumber = `RDM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const addr = dto.deliveryAddress;
    const otp = this.generateOtpCode();

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
      const created = await tx.redemptionOrder.create({
        data: {
          partnerId: partner.id,
          rewardId: item.id,
          orderNumber,
          quantity,
          pointsDeducted: 0,
          totalPointsCost: requiredPoints,
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
            orderNumber,
          },
        },
      })
      .catch((e) => this.logger.error(`[redeemForOutlet] audit log failed: ${e}`));

    // Send OTP delivery to the OUTLET's phone synchronously (consent). Debug-log only in dev.
    this.logger.debug(`[redeemForOutlet] OTP for order ${order.id}: ${otp}`);
    try {
      await this.msg91.sendOtp(otpPhone, otp, 'SMS');
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
      orderNumber,
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
      include: { reward: true, partner: { select: { id: true, userId: true } } },
    });
    if (!order) throw new NotFoundException('Redemption order not found');
    if (order.status !== 'PENDING') {
      throw new BadRequestException('Order is not awaiting confirmation');
    }

    // OTP is bound to the OUTLET's user (it was delivered to the outlet's phone).
    const otpId = await this.verifyRedemptionOtp(partner.userId, dto.otp);

    const requiredPoints = order.totalPointsCost;

    await this.prisma.$transaction(async (tx) => {
      // valuePaise: freeze the ₹-equivalent at confirm time (194R TDS base).
      // value(₹) = points ÷ conversionRate; centi-rate integer math avoids
      // truncating a fractional rate. rate 0 (misconfig) → 0 (guard div-by-zero).
      const rateCenti = Math.round(this.conversionRate * 100);
      const valuePaise =
        rateCenti > 0
          ? roundToRupeePaise((BigInt(requiredPoints) * 10000n) / BigInt(rateCenti))
          : 0n;

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

        const amountPaise: bigint =
          valuePaise != null && valuePaise > 0n ? valuePaise : (() => {
            this.logger.warn(
              `[confirmRedeemForOutlet] valuePaise null/zero for order ${order.id} — PayoutTransaction created with amountPaise=0; manual correction required`,
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

    // Notify on commit — the confirmation goes to the OUTLET's phone.
    await this.notifications
      .enqueue({
        userId: partner.userId,
        channel: 'SMS',
        recipientPhone: partner.user?.phone ?? undefined,
        body: `Your redemption ${order.orderNumber} (${order.reward?.name ?? ''}) is confirmed for ${requiredPoints} points.`,
        variables: { orderId: order.id, orderNumber: order.orderNumber, points: requiredPoints },
      })
      .catch((e) => this.logger.error(`[confirmRedeemForOutlet] notify failed: ${e}`));

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
  async redeem(user: JwtPayload, dto: RedeemDto) {
    const quantity = dto.quantity ?? 1;

    // ACTIVE non-deleted catalog item, in-tenant.
    const item = await this.prisma.rewardCatalog.findFirst({
      where: { id: dto.rewardId, status: 'ACTIVE', deletedAt: null, clientId: user.clientId },
    });
    if (!item) throw new NotFoundException('Reward item not found or not available');

    // PHYSICAL_GIFT requires a full delivery address; other modes do not.
    if (item.redemptionMode === 'PHYSICAL_GIFT' && !dto.deliveryAddress) {
      throw new BadRequestException('Delivery address is required for physical gifts');
    }

    // Points cost: FREE_AMOUNT = round(amount × rate) bounded by min/max; else pointsCost × qty.
    let requiredPoints: number;
    if (this.isFreeAmount(item)) {
      if (dto.amount == null) {
        throw new BadRequestException('amount (₹) is required for a variable-amount voucher');
      }
      requiredPoints = Math.round(dto.amount * this.conversionRate);
      const min = item.minRedemptionPoints as number;
      const max = item.maxRedemptionPoints as number;
      if (requiredPoints < min || requiredPoints > max) {
        throw new BadRequestException(
          `Amount out of range. Allowed: ${min}–${max} points, requested: ${requiredPoints}`,
        );
      }
    } else {
      requiredPoints = item.pointsCost * quantity;
    }
    if (requiredPoints <= 0) {
      throw new BadRequestException('Redemption must cost a positive number of points');
    }

    const partner = await this.requirePartner(user);

    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: partner.id } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.redeemablePoints < requiredPoints) {
      throw new BadRequestException(
        `Insufficient points. Required: ${requiredPoints}, Available: ${wallet.redeemablePoints}`,
      );
    }

    const orderNumber = `RDM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const addr = dto.deliveryAddress;
    const otp = this.generateOtpCode();

    // C2 — bind the OTP to exactly ONE order. A user may have only one redemption
    // awaiting confirmation at a time: superseding any abandoned PENDING orders
    // (none were ever debited → pointsDeducted=0, no refund) and their unverified
    // OTPs guarantees the single active REDEMPTION_CONFIRM OTP can confirm only
    // THIS order — closing the cross-order OTP-confusion the audit flagged.
    const order = await this.prisma.$transaction(async (tx) => {
      await tx.redemptionOrder.updateMany({
        where: { partnerId: partner.id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await tx.otpCode.deleteMany({
        where: { userId: user.sub, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const created = await tx.redemptionOrder.create({
        data: {
          partnerId: partner.id,
          rewardId: item.id,
          orderNumber,
          quantity,
          pointsDeducted: 0,
          totalPointsCost: requiredPoints,
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
        },
      });
      return created;
    });

    // Send OTP delivery (SMS) synchronously. Never log the live OTP in prod; debug only.
    this.logger.debug(`[redeem] OTP for order ${order.id}: ${otp}`);
    try {
      await this.msg91.sendOtp(user.phone, otp, 'SMS');
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
      orderNumber,
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
  async confirmRedeem(user: JwtPayload, dto: RedeemConfirmDto) {
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id: dto.orderId, partner: { user: { clientId: user.clientId } } },
      include: { reward: true, partner: { select: { id: true, userId: true } } },
    });
    if (!order) throw new NotFoundException('Redemption order not found');
    if (order.partner?.userId !== user.sub) throw new ForbiddenException('Forbidden');
    if (order.status !== 'PENDING') {
      throw new BadRequestException('Order is not awaiting confirmation');
    }

    const otpId = await this.verifyRedemptionOtp(user.sub, dto.otp);

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
      const rateCenti = Math.round(this.conversionRate * 100);
      const valuePaise =
        rateCenti > 0
          ? roundToRupeePaise((BigInt(requiredPoints) * 10000n) / BigInt(rateCenti))
          : 0n;

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
        // Fetch full partner for bank snapshot inside the tx.
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

        // valuePaise is set by the claim update just above; the re-read is not
        // needed — we computed it in `valuePaise` (BigInt) in this scope.
        const amountPaise: bigint =
          valuePaise != null && valuePaise > 0n ? valuePaise : (() => {
            this.logger.warn(
              `[confirmRedeem] valuePaise null/zero for order ${order.id} — PayoutTransaction created with amountPaise=0; manual correction required`,
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

    await this.notifications
      .enqueue({
        userId: user.sub,
        channel: 'SMS',
        recipientPhone: user.phone,
        body: `Your redemption ${order.orderNumber} (${order.reward?.name ?? ''}) is confirmed for ${requiredPoints} points.`,
        variables: { orderId: order.id, orderNumber: order.orderNumber, points: requiredPoints },
      })
      .catch((e) => this.logger.error(`[confirmRedeem] notify failed: ${e}`));

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
    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id, partner: { user: { clientId: user.clientId } } },
    });
    if (!order) throw new NotFoundException('Order not found');

    const toStatus = dto.toStatus as unknown as RedemptionStatus;
    const allowed: Record<string, RedemptionStatus[]> = {
      PENDING: [RedemptionStatus.CANCELLED],
      CONFIRMED: [RedemptionStatus.PROCESSING, RedemptionStatus.CANCELLED, RedemptionStatus.RETURNED],
      PROCESSING: [RedemptionStatus.DISPATCHED, RedemptionStatus.FAILED, RedemptionStatus.CANCELLED],
      DISPATCHED: [RedemptionStatus.DELIVERED, RedemptionStatus.RETURNED],
    };
    const fromStatus = order.status;
    if (!(allowed[fromStatus] ?? []).includes(toStatus)) {
      throw new BadRequestException(`Illegal status transition: ${fromStatus} → ${toStatus}`);
    }

    const isRefundTarget =
      toStatus === RedemptionStatus.CANCELLED ||
      toStatus === RedemptionStatus.RETURNED ||
      toStatus === RedemptionStatus.FAILED;

    const now = new Date();
    const data: Prisma.RedemptionOrderUpdateInput = {
      status: toStatus,
      voucherCode: dto.voucherCode,
      voucherProvider: dto.voucherProvider,
      trackingNumber: dto.trackingNumber,
      trackingUrl: dto.trackingUrl,
      notes: dto.notes,
    };
    if (toStatus === RedemptionStatus.DISPATCHED) data.dispatchedAt = now;
    if (toStatus === RedemptionStatus.DELIVERED) data.deliveredAt = now;
    if (toStatus === RedemptionStatus.CANCELLED) data.cancelledAt = now;

    const updated = await this.prisma.$transaction(async (tx) => {
      // M2 — refund at most ONCE: atomically claim the debited points
      // (pointsDeducted > 0 → 0). Only the tx that wins the claim re-credits, so
      // two concurrent refund-bound transitions can't double-refund.
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
        select: { userId: true, phone: true },
      });
      if (partner?.userId) {
        await this.notifications
          .enqueue({
            userId: partner.userId,
            channel: 'SMS',
            recipientPhone: partner.phone ?? undefined,
            body: `Your redemption ${order.orderNumber} is now ${toStatus}.`,
            variables: { orderId: id, orderNumber: order.orderNumber, status: toStatus },
          })
          .catch((e) => this.logger.error(`[transitionOrder] notify failed: ${e}`));
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
    const where: Prisma.RedemptionOrderWhereInput = {
      partner: { user: { clientId: user.clientId } },
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

    for (const r of parsed.rows) {
      try {
        // Resolve the order in-tenant; collect (don't throw) on a miss/cross-tenant.
        const order = await this.prisma.redemptionOrder.findFirst({
          where: { orderNumber: r.orderNumber, partner: { user: { clientId: user.clientId } } },
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
   * Validate the user's latest unverified REDEMPTION_CONFIRM OTP and return its id.
   * Self-contained (does NOT reuse auth.verifyOtp, which auto-registers users).
   * Bumps attempts + 401 on a miss. Does NOT set verifiedAt — the caller marks it
   * INSIDE the confirm transaction so a failed debit rolls the OTP back (M1).
   * FIXED_OTP is honoured ONLY outside production — a dev backdoor on a money
   * confirm must never be live in prod (H2).
   */
  private async verifyRedemptionOtp(userId: string, otp: string): Promise<string> {
    const record = await this.prisma.otpCode.findFirst({
      where: { userId, purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
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

    const fixedOtp =
      process.env.NODE_ENV !== 'production' ? process.env.FIXED_OTP : undefined;
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

  /** 6-digit OTP (100000–999999), matching auth.generateOtpCode. */
  private generateOtpCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
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
  // a DISCONTINUED item). Stock is NOT decremented on redemption here — that is
  // 5.4's redeem path (see TODO in createCatalogItem).
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

    // M3 — a FREE_AMOUNT voucher (pointsCost 0 + a min/max range) must have a
    // positive lower bound, so a variable-amount redeem can never round to 0 points.
    if (
      dto.pointsCost === 0 &&
      dto.minRedemptionPoints != null &&
      dto.maxRedemptionPoints != null &&
      dto.minRedemptionPoints < 1
    ) {
      throw new BadRequestException(
        'A variable-amount (FREE_AMOUNT) voucher must have minRedemptionPoints >= 1',
      );
    }

    // Code unique within the tenant (among non-deleted items).
    const clash = await this.prisma.rewardCatalog.findFirst({
      where: { clientId: user.clientId, code: dto.code, deletedAt: null },
    });
    if (clash) throw new ConflictException('A catalog item with this code already exists');

    // Stock rule: explicit 0 forces OUT_OF_STOCK regardless of requested status.
    const status =
      dto.stockQuantity === 0 ? 'OUT_OF_STOCK' : dto.status ?? 'ACTIVE';

    // TODO(5.4): redeem path decrements stockQuantity and flips OUT_OF_STOCK
    // when it hits 0. CRUD here only sets the initial value.
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

    // Validate the EFFECTIVE min/max (post-merge with the stored values).
    const effMin = dto.minRedemptionPoints ?? existing.minRedemptionPoints ?? undefined;
    const effMax = dto.maxRedemptionPoints ?? existing.maxRedemptionPoints ?? undefined;
    this.assertRedemptionRange(effMin, effMax);

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
        minRedemptionPoints: dto.minRedemptionPoints,
        maxRedemptionPoints: dto.maxRedemptionPoints,
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

  /** min <= max when both bounds are provided (FREE_AMOUNT voucher range). */
  private assertRedemptionRange(min?: number | null, max?: number | null) {
    if (min != null && max != null && min > max) {
      throw new BadRequestException(
        'minRedemptionPoints must be <= maxRedemptionPoints',
      );
    }
  }
}
