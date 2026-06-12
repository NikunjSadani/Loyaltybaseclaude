import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCatalogItemDto, UpdateCatalogItemDto } from './dto/rewards-admin.dto';

interface DeliveryAddressDto {
  name:     string;
  mobile:   string;
  address:  string;
  city:     string;
  state:    string;
  pincode:  string;
}

interface InitiateRedemptionDto {
  rewardId:        string;
  quantity?:       number;
  deliveryAddress: DeliveryAddressDto;
}

interface CatalogOpts {
  category?:   string;
  minPoints?:  number;
  maxPoints?:  number;
  page?:       number;
  limit?:      number;
}

interface AdminCatalogOpts {
  status?: string;
  page?:   number;
  limit?:  number;
}

interface OrdersOpts {
  status?: string;
  page?:   number;
  limit?:  number;
}

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Catalog ────────────────────────────────────────────────────────────────

  async getCatalog(clientId: string, userId: string, opts: CatalogOpts) {
    const page   = opts.page  ?? 1;
    const limit  = opts.limit ?? 20;
    const skip   = (page - 1) * limit;

    const where: any = { status: 'ACTIVE', deletedAt: null, clientId };
    if (opts.minPoints !== undefined || opts.maxPoints !== undefined) {
      where.pointsCost = {};
      if (opts.minPoints !== undefined) where.pointsCost.gte = opts.minPoints;
      if (opts.maxPoints !== undefined) where.pointsCost.lte = opts.maxPoints;
    }

    // Look up partner wallet for affordability flag
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId, clientId },
    });
    const wallet = partner
      ? await this.prisma.wallet.findFirst({ where: { partnerId: partner.id } })
      : null;
    const userBalance = wallet?.redeemablePoints ?? 0;

    const [items, total] = await Promise.all([
      this.prisma.rewardCatalog.findMany({
        where, skip, take: limit, orderBy: { pointsCost: 'asc' },
      }),
      this.prisma.rewardCatalog.count({ where }),
    ]);

    return {
      items: items.map((item) => ({ ...item, isAffordable: userBalance >= item.pointsCost })),
      userBalance,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ── Initiate Redemption ────────────────────────────────────────────────────

  async initiateRedemption(userId: string, clientId: string, dto: InitiateRedemptionDto) {
    const quantity = dto.quantity ?? 1;

    // Find the partner
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId, clientId },
    });
    if (!partner) throw new NotFoundException('Partner account not found');

    // Find the reward item
    const item = await this.prisma.rewardCatalog.findFirst({
      where: { id: dto.rewardId, status: 'ACTIVE', deletedAt: null, clientId },
    });
    if (!item) throw new NotFoundException('Reward item not found or not available');

    const requiredPoints = item.pointsCost * quantity;

    // Check wallet balance
    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: partner.id } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.redeemablePoints < requiredPoints) {
      throw new BadRequestException(
        `Insufficient points. Required: ${requiredPoints}, Available: ${wallet.redeemablePoints}`,
      );
    }

    // Generate order number
    const orderNumber = `RDM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { deliveryAddress: da } = dto;

    // Create pending order
    const order = await this.prisma.redemptionOrder.create({
      data: {
        partnerId:            partner.id,
        rewardId:             dto.rewardId,
        orderNumber,
        quantity,
        pointsDeducted:       0,   // set on confirm
        totalPointsCost:      requiredPoints,
        redemptionMode:       item.redemptionMode,
        deliveryName:         da.name,
        deliveryPhone:        da.mobile,
        deliveryAddressLine1: da.address,
        deliveryCity:         da.city,
        deliveryState:        da.state,
        deliveryPincode:      da.pincode,
        status:               'PENDING' as any,
      },
    });

    // Store OTP for confirmation
    const otp  = String(Math.floor(100000 + Math.random() * 900000));
    const user = await this.prisma.user.findFirst({ where: { id: userId } });
    const phone = user?.phone ?? userId;

    await this.prisma.otpCode.create({
      data: {
        phone,
        userId,
        code:      otp,
        purpose:   'REDEMPTION_CONFIRM' as any,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    this.logger.log(`Redemption initiated: ${order.id} (${requiredPoints} pts) — OTP ${otp}`);

    return {
      orderId:        order.id,
      orderNumber,
      requiredPoints,
      message:        'OTP sent to your registered mobile. Please confirm the redemption.',
    };
  }

  // ── Confirm Redemption ─────────────────────────────────────────────────────

  async confirmRedemption(
    userId:   string,
    clientId: string,
    orderId:  string,
    otp:      string,
  ) {
    // Find pending order belonging to this user's partner
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId, clientId },
    });
    if (!partner) throw new NotFoundException('Partner account not found');

    const order = await this.prisma.redemptionOrder.findFirst({
      where: { id: orderId, partnerId: partner.id, status: 'PENDING' },
      include: { reward: true },
    });
    if (!order) {
      throw new BadRequestException('Order not found or is no longer pending');
    }

    // Verify OTP
    const user      = await this.prisma.user.findFirst({ where: { id: userId } });
    const phone     = user?.phone ?? userId;
    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        phone,
        code:        otp,
        purpose:     'REDEMPTION_CONFIRM' as any,
        verifiedAt:  null,
        expiresAt:   { gt: new Date() },
      },
    });
    if (!otpRecord) throw new BadRequestException('Invalid or expired OTP');

    // Atomic: deduct points + confirm order + mark OTP used
    const updated = await this.prisma.$transaction(async (tx) => {
      // Mark OTP verified
      await tx.otpCode.update({
        where: { id: otpRecord.id },
        data:  { verifiedAt: new Date() },
      });

      // Deduct points atomically
      await tx.wallet.update({
        where: { partnerId: partner.id },
        data:  {
          redeemablePoints: { decrement: order.totalPointsCost },
          redeemedPoints:   { increment: order.totalPointsCost },
          lifetimeRedeemed: { increment: order.totalPointsCost },
        },
      });

      // Log wallet transaction
      const wallet = await tx.wallet.findFirst({ where: { partnerId: partner.id } });
      await tx.walletTransaction.create({
        data: {
          walletId:        wallet!.id,
          transactionType: 'DEBIT_REDEMPTION',
          points:          order.totalPointsCost,
          balanceBefore:   wallet!.redeemablePoints + order.totalPointsCost,
          balanceAfter:    wallet!.redeemablePoints,
          balanceType:     'redeemablePoints',
          referenceType:   'REDEMPTION_ORDER',
          referenceId:     order.id,
          description:     `Redemption: ${order.reward?.name ?? order.rewardId}`,
        },
      });

      // Update order
      const confirmedOrder = await tx.redemptionOrder.update({
        where: { id: order.id },
        data:  { status: 'CONFIRMED' as any, pointsDeducted: order.totalPointsCost },
      });

      // Status history
      await tx.redemptionStatusHistory.create({
        data: {
          orderId:    order.id,
          fromStatus: 'PENDING' as any,
          toStatus:   'CONFIRMED' as any,
          notes:      'OTP confirmed',
        },
      });

      return confirmedOrder;
    });

    this.logger.log(`Redemption confirmed: ${order.id}`);
    return updated;
  }

  // ── Admin: Catalog management ──────────────────────────────────────────────

  async listAdminCatalog(clientId: string, opts: AdminCatalogOpts) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;

    const where: any = { clientId, deletedAt: null };
    if (opts.status) where.status = opts.status;

    const [items, total] = await Promise.all([
      this.prisma.rewardCatalog.findMany({
        where, skip, take: limit, orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.rewardCatalog.count({ where }),
    ]);

    return { items, total, page, totalPages: Math.ceil(total / limit) };
  }

  async createCatalogItem(clientId: string, dto: CreateCatalogItemDto) {
    return this.prisma.rewardCatalog.create({
      data: {
        clientId,
        categoryId:         dto.categoryId,
        code:               dto.code,
        name:               dto.name,
        description:        dto.description        ?? null,
        pointsCost:         dto.pointsCost,
        redemptionMode:     dto.redemptionMode      as any,
        mrpPaise:           dto.mrpPaise            ?? null,
        eligibleClasses:    (dto.eligibleClasses    ?? []) as any,
        termsAndConditions: dto.termsAndConditions  ?? null,
        sortOrder:          dto.sortOrder           ?? 0,
      },
    });
  }

  async updateCatalogItem(id: string, clientId: string, dto: UpdateCatalogItemDto) {
    const item = await this.prisma.rewardCatalog.findFirst({
      where: { id, clientId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Catalog item not found');

    return this.prisma.rewardCatalog.update({
      where: { id },
      data:  dto as any,
    });
  }

  async softDeleteCatalogItem(id: string, clientId: string) {
    const item = await this.prisma.rewardCatalog.findFirst({
      where: { id, clientId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Catalog item not found');

    return this.prisma.rewardCatalog.update({
      where: { id },
      data:  { deletedAt: new Date(), status: 'DISCONTINUED' as any },
    });
  }

  // ── Partner orders ─────────────────────────────────────────────────────────

  async getOrders(userId: string, clientId: string, opts: OrdersOpts) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;

    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId, clientId },
    });
    if (!partner) throw new NotFoundException('Partner not found');

    const where: any = { partnerId: partner.id };
    if (opts.status) where.status = opts.status;

    const [data, total] = await Promise.all([
      this.prisma.redemptionOrder.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { reward: { select: { id: true, name: true, imageUrls: true } } },
      }),
      this.prisma.redemptionOrder.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
