import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  ListChannelPartnersQueryDto,
  UpdateChannelPartnerDto,
} from './dto/channel-partners.dto';

/**
 * Channel Partners admin — ported from
 * platform/src/app/api/admin/channel-partners/{route.ts,[id]/route.ts}.
 *
 * Historically this managed partner CLASS. The canonical ChannelPartner has no
 * class/tier/kyc/region columns, so those filters and the `currentTierConfigId`
 * PATCH field are DROPPED. Tenant scope uses the denormalised
 * ChannelPartner.clientId column directly (the canonical model carries its own
 * clientId), rather than the source's `user: { clientId }` relation filter.
 *
 * GET allows GIFSY_ADMIN | CLIENT_ADMIN | MIS_USER (partners:read).
 * PATCH allows GIFSY_ADMIN | CLIENT_ADMIN (partners:write).
 */
@Injectable()
export class ChannelPartnersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/admin/channel-partners */
  async list(user: JwtPayload, q: ListChannelPartnersQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ChannelPartnerWhereInput = {
      isActive: true,
      clientId: user.clientId,
      // Parents (owner-group anchors) live in ChannelPartner but are non-operating — exclude
      // them from the operating-partner list/count (docs/plans/PARTNER-MULTI-OUTLET.md §9).
      isParent: false,
    };
    if (q.search) {
      where.OR = [
        { businessName: { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
        { panNumber: { contains: q.search, mode: 'insensitive' } },
      ];
    }

    const [partners, total] = await Promise.all([
      this.prisma.channelPartner.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, phone: true, email: true, status: true } },
          wallets: { select: { earnedPoints: true, redeemedPoints: true, lockedPoints: true } },
          outlets: { select: { id: true, name: true, city: true, isActive: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.channelPartner.count({ where }),
    ]);

    return { partners, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** GET /v1/admin/channel-partners/:id */
  async getOne(user: JwtPayload, id: string) {
    const partner = await this.prisma.channelPartner.findFirst({
      // A PARENT (owner-group anchor) is non-operating — it is NOT an operating partner, so it
      // must not resolve on this operating-partner endpoint (consistent with list/count's
      // isParent:false filter; docs/plans/PARTNER-MULTI-OUTLET.md §9). Returns NotFound below.
      where: { id, clientId: user.clientId, isParent: false },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, status: true } },
        wallets: true,
        outlets: true,
        kycSubmissions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!partner) throw new NotFoundException('Channel partner not found');
    return { partner };
  }

  /** PATCH /v1/admin/channel-partners/:id */
  async update(user: JwtPayload, id: string, dto: UpdateChannelPartnerDto) {
    // Verify ownership (tenant scope) before update — and REJECT a parent: a parent is a
    // non-operating owner-group anchor, not an operating partner, so it is not mutable through
    // this endpoint (consistent with list/count/getOne; §9). Excluding it here yields NotFound.
    const existing = await this.prisma.channelPartner.findFirst({
      where: { id, clientId: user.clientId, isParent: false },
    });
    if (!existing) throw new NotFoundException('Channel partner not found');

    const data: Prisma.ChannelPartnerUpdateInput = { updatedAt: new Date() };
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const partner = await this.prisma.channelPartner.update({ where: { id }, data });

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'CHANNEL_PARTNER',
        entityId: id,
        actorId: user.sub,
        metadata: { isActive: dto.isActive },
      },
    });

    return { partner };
  }
}
