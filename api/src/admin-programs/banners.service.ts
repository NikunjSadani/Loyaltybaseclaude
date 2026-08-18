import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateBannerDto } from './dto/banners.dto';
import { isGifsyOperator } from '../common/tenant-scope';

/**
 * Banners admin — ported from platform/src/app/api/admin/banners/route.ts.
 *
 * Uses BannerManagement (KEPT). The source POST also wrote `targetClasses`
 * (CP_01/CP_02/CP_03) — DROPPED: partner-class targeting is a World-A concept
 * and the canonical BannerManagement has no targetClasses column. Tenant-scoped
 * by clientId throughout.
 *
 * GET: engagement:read (non-GIFSY callers see only ACTIVE, non-expired banners).
 * POST/DELETE: GIFSY_ADMIN | CLIENT_ADMIN (engagement:manage_banners).
 */
@Injectable()
export class BannersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/admin/banners */
  async list(user: JwtPayload) {
    const where: Prisma.BannerManagementWhereInput = { clientId: user.clientId };
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    if (!isGifsyOperator(user)) {
      where.status = 'ACTIVE';
      where.OR = [{ endDate: null }, { endDate: { gte: new Date() } }];
    }

    const banners = await this.prisma.bannerManagement.findMany({
      where,
      orderBy: [{ sortOrder: 'desc' }, { createdAt: 'desc' }],
    });

    return { banners };
  }

  /** POST /v1/admin/banners */
  async create(user: JwtPayload, dto: CreateBannerDto) {
    const banner = await this.prisma.bannerManagement.create({
      data: {
        title: dto.title,
        imageUrl: dto.imageUrl,
        linkUrl: dto.linkUrl,
        position: dto.position,
        status: dto.status ?? 'INACTIVE',
        startDate: dto.startDate,
        endDate: dto.endDate,
        sortOrder: dto.sortOrder ?? 0,
        createdByUserId: user.sub,
        clientId: user.clientId,
      },
    });

    return { banner };
  }

  /** DELETE /v1/admin/banners?id= — soft delete (sets deletedAt). */
  async remove(user: JwtPayload, id: string) {
    // Verify the banner belongs to this tenant before deleting.
    const banner = await this.prisma.bannerManagement.findFirst({
      where: { id, clientId: user.clientId },
    });
    if (!banner) throw new NotFoundException('Banner not found');

    await this.prisma.bannerManagement.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Banner deleted successfully' };
  }
}
