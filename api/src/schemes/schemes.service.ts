import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateSchemeDto,
  ListSchemesQueryDto,
  UpdateSchemeDto,
  UpsertEnrollmentFormDto,
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

  // ───────────────────────────────────────────────────────────────────────────
  // P4.2 — Enrollment-form persistence
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Validates that a scheme exists and belongs to the caller's tenant.
   * Throws NotFoundException if the scheme is missing or cross-tenant.
   * Throws NotFoundException if the scheme is soft-deleted.
   */
  private async assertSchemeOwnership(user: JwtPayload, schemeId: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, clientId: user.clientId },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');
    if (scheme.deletedAt !== null) throw new NotFoundException('Scheme not found');
    return scheme;
  }

  /**
   * PUT /v1/schemes/:id/enrollment-form — admin-only.
   *
   * Upserts the SchemeEnrollmentForm record (1:1 on schemeId).
   * The caller's tenant is validated before any write; formSchema structural
   * validation is done at the DTO layer (class-validator) before this is called.
   */
  async upsertEnrollmentForm(
    user: JwtPayload,
    schemeId: string,
    dto: UpsertEnrollmentFormDto,
  ) {
    if (!this.isAdmin(user)) throw new ForbiddenException('Forbidden - Admin only');

    await this.assertSchemeOwnership(user, schemeId);

    const form = await this.prisma.schemeEnrollmentForm.upsert({
      where: { schemeId },
      update: {
        campaignType: dto.campaignType,
        formSchema: dto.formSchema as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
      create: {
        schemeId,
        campaignType: dto.campaignType,
        formSchema: dto.formSchema as Prisma.InputJsonValue,
      },
    });

    return { enrollmentForm: form };
  }

  /**
   * GET /v1/schemes/:id/enrollment-form — schemes:read.
   *
   * Returns the enrollment form for a scheme, or 404 if none exists.
   * Validates tenant ownership before reading.
   */
  async getEnrollmentForm(user: JwtPayload, schemeId: string) {
    await this.assertSchemeOwnership(user, schemeId);

    const form = await this.prisma.schemeEnrollmentForm.findUnique({
      where: { schemeId },
    });

    if (!form) throw new NotFoundException('Enrollment form not found');

    return { enrollmentForm: form };
  }

}
