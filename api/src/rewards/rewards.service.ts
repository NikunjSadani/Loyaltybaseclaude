import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListCatalogQueryDto, ListOrdersQueryDto, UpdateOrderDto } from './dto/rewards.dto';

/**
 * Rewards & Redemption — ported from platform/src/app/api/rewards/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT); non-GIFSY callers
 * see/act on only their own partner's catalog affordability and orders. Business
 * logic lives here; the controller is a thin HTTP adapter.
 *
 * NOTE: the source redeem + redeem/confirm routes are NOT ported — they depend
 * on a REDEMPTION_CONFIRM OTP purpose and a notifications service that do not
 * exist in the canonical schema/api. See the porting report.
 */
@Injectable()
export class RewardsService {
  constructor(private readonly prisma: PrismaService) {}

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

  /** PATCH /v1/rewards/orders/:id — GIFSY-only order update (status/tracking/notes). */
  async updateOrder(user: JwtPayload, id: string, dto: UpdateOrderDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope re-checked here.
    const existingOrder = await this.prisma.redemptionOrder.findFirst({
      where: { id, partner: { user: { clientId: user.clientId } } },
    });
    if (!existingOrder) throw new NotFoundException('Order not found');

    const order = await this.prisma.redemptionOrder.update({
      where: { id },
      data: {
        status: dto.status,
        trackingNumber: dto.trackingNumber,
        trackingUrl: dto.trackingUrl,
        notes: dto.notes,
      },
    });

    return { order };
  }
}
