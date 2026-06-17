import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateSchemeDto,
  ListSchemesQueryDto,
  UpdateSchemeDto,
} from './dto/schemes.dto';

/**
 * Schemes — ported from platform/src/app/api/schemes/*.
 * Tenant-scoped by clientId (from the session-bound JWT). Non-admin partners
 * see only the active schemes they are eligible for. The World-A incentive
 * compute engine (schemes/calculate) and the dropped SchemeRule/compute fields
 * (pointsPerRupee, fixedPoints, maxPointsPerCycle, scheme rules/slabs) are
 * intentionally absent.
 */
@Injectable()
export class SchemesService {
  constructor(private readonly prisma: PrismaService) {}

  private isAdmin(user: JwtPayload): boolean {
    return user.role === 'GIFSY_ADMIN' || user.role === 'CLIENT_ADMIN';
  }

  async list(user: JwtPayload, q: ListSchemesQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.SchemeWhereInput = {
      clientId: user.clientId,
      status: 'ACTIVE',
      deletedAt: null,
    };

    // Non-admins only see schemes they are explicitly eligible for.
    if (!this.isAdmin(user)) {
      const eligibilities = await this.prisma.schemeEligibility.findMany({
        where: { specificPartnerId: user.sub },
        select: { schemeId: true },
      });
      where.id = { in: eligibilities.map((e) => e.schemeId) };
    }

    const [schemes, total] = await Promise.all([
      this.prisma.scheme.findMany({
        where,
        include: { eligibility: true },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.scheme.count({ where }),
    ]);

    return { schemes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async create(user: JwtPayload, dto: CreateSchemeDto) {
    // GIFSY_ADMIN / CLIENT_ADMIN only — enforced at the controller; re-stated here for safety.
    if (!this.isAdmin(user)) throw new ForbiddenException('Forbidden - Admin only');

    const scheme = await this.prisma.scheme.create({
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        schemeType: dto.schemeType,
        rewardType: dto.rewardType,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        holdingPeriodDays: dto.holdingPeriodDays ?? 30,
        budgetPaise: dto.budgetPaise,
        termsAndConditions: dto.termsAndConditions,
        isStackable: dto.isStackable ?? false,
        priority: dto.priority ?? 0,
        imageUrl: dto.imageUrl,
        metadata: dto.metadata as Prisma.InputJsonValue | undefined,
        status: 'ACTIVE',
        createdByUserId: user.sub,
        clientId: user.clientId,
      },
    });

    return { scheme };
  }

  async getOne(user: JwtPayload, id: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id, clientId: user.clientId },
      include: { eligibility: true },
    });

    if (scheme && scheme.deletedAt !== null) throw new NotFoundException('Scheme not found');
    if (!scheme) throw new NotFoundException('Scheme not found');

    return { scheme };
  }

  async update(user: JwtPayload, id: string, dto: UpdateSchemeDto) {
    if (!this.isAdmin(user)) throw new ForbiddenException('Forbidden - Admin only');

    const existingScheme = await this.prisma.scheme.findFirst({ where: { id, clientId: user.clientId } });
    if (!existingScheme) throw new NotFoundException('Scheme not found');

    const data: Prisma.SchemeUpdateInput = { updatedAt: new Date() };
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.endDate !== undefined) data.endDate = new Date(dto.endDate);

    const scheme = await this.prisma.scheme.update({ where: { id }, data });

    return { scheme };
  }

  async remove(user: JwtPayload, id: string) {
    // GIFSY_ADMIN only — enforced at the controller; re-stated here for safety.
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Gifsy Admin only');

    const existingScheme = await this.prisma.scheme.findFirst({ where: { id, clientId: user.clientId } });
    if (!existingScheme) throw new NotFoundException('Scheme not found');

    await this.prisma.scheme.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'CANCELLED', updatedAt: new Date() },
    });

    return { message: 'Scheme deleted successfully' };
  }

}
