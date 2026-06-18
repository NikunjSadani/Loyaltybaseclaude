import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, RedemptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateRewardCatalogDto,
  CreateRewardCategoryDto,
  ListCatalogQueryDto,
  ListOrdersQueryDto,
  RedeemConfirmDto,
  RedeemDto,
  TransitionOrderDto,
  UpdateOrderDto,
  UpdateRewardCatalogDto,
  UpdateRewardCategoryDto,
} from './dto/rewards.dto';

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

    // Enqueue OTP delivery (SMS). Never log the live OTP in prod; debug only.
    this.logger.debug(`[redeem] OTP for order ${order.id}: ${otp}`);
    await this.notifications
      .enqueue({
        userId: user.sub,
        channel: 'SMS',
        recipientPhone: user.phone,
        body: `Your redemption confirmation OTP is ${otp}. Valid for 10 minutes.`,
        variables: { otp, orderNumber },
      })
      .catch((e) => this.logger.error(`[redeem] OTP enqueue failed: ${e}`));

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
      const claim = await tx.redemptionOrder.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: requiredPoints },
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
