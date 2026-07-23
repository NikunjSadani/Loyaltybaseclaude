import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateSchemeDto,
  ListSchemesQueryDto,
  SubmitEnrollmentDto,
  UpdateSchemeDto,
  UpsertEnrollmentFormDto,
} from './dto/schemes.dto';
import {
  EnrollmentFormSchema,
  validateSubmittedValues,
} from './enrollment-form.helper';

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

    const isAdmin = this.isAdmin(user);

    const where: Prisma.SchemeWhereInput = {
      clientId: user.clientId,
      deletedAt: null,
    };

    // Status handling (Wave 2 pagination).
    //   • ADMINS: an explicit `?status` wins (validated against SchemeStatus); with no
    //     status they get ALL non-deleted statuses so the admin list's "All" pill +
    //     DRAFT/PAUSED/EXPIRED/CANCELLED filters work (previously hard-pinned to ACTIVE).
    //   • NON-ADMINS (partner / sales enrollment views): ALWAYS forced to ACTIVE-only,
    //     IGNORING any client-supplied `?status`. They must never see DRAFT/EXPIRED/etc.
    //     — so the status filter is admin-gated: a non-admin hand-crafting
    //     `?status=DRAFT` cannot bypass the ACTIVE-only default (their eligibility rows
    //     could otherwise expose an unpublished scheme's name/code/dates).
    if (isAdmin) {
      if (q.status) where.status = q.status;
    } else {
      where.status = 'ACTIVE';
    }

    // Scheme-type filter (validated against the SchemeType enum at the DTO).
    if (q.type) where.schemeType = q.type;

    // Free-text search over name + code, case-insensitive. AND-combined with the
    // scope clauses above (never widens tenant scope).
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Non-admins only see schemes they are explicitly eligible for.
    if (!isAdmin) {
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

  // ───────────────────────────────────────────────────────────────────────────
  // P4.3 — Enrollment submission
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * POST /v1/schemes/:id/enroll
   *
   * Submit an enrollment for the caller (SELF) or on behalf of a partner (SALES).
   *
   * Access model:
   *   SELF  — caller must be a ChannelPartner in this tenant. userId = user.sub.
   *   SALES — caller must be a sales user with an active assignment to the target
   *           partner. userId = target partner's userId. targetPartnerId is the
   *           ChannelPartner.id (never trusted without the assignment check).
   *
   * Tenant: scheme + partner must both belong to user.clientId.
   * Scheme state: must be ACTIVE, non-deleted, and within start–end dates.
   * Audience: campaignType on the enrollment form drives who may enroll.
   *   LOYALTY_ONLY  → KYC-APPROVED partners only.
   *   OPEN_CAMPAIGN → non-KYC ("scheme-only") partners only.
   *   MIXED         → both.
   * Form values: required fields present, types correct, visibleWhen-hidden fields
   *   skipped, CALCULATED fields recomputed server-side (client values discarded).
   * Upsert: re-enrollment updates formValues + sets status ACTIVE; use the
   *   @@unique([schemeId, userId]) constraint (idempotent update on repeat).
   */
  async submitEnrollment(user: JwtPayload, schemeId: string, dto: SubmitEnrollmentDto) {
    const mode = dto.enrollmentMode ?? 'SELF';

    // ── 1. Resolve the enrolled userId + verify access ─────────────────────
    let enrolledUserId: string;

    if (mode === 'SELF') {
      // Verify caller is a ChannelPartner in this tenant.
      const partner = await this.prisma.channelPartner.findFirst({
        where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
        select: { id: true, userId: true },
      });
      if (!partner) {
        throw new ForbiddenException(
          'No ChannelPartner record found for your account in this tenant.',
        );
      }
      enrolledUserId = user.sub;
    } else {
      // SALES mode — verify caller is a sales user with assignment to the target.
      if (!dto.targetPartnerId) {
        throw new BadRequestException(
          'targetPartnerId is required for SALES enrollment mode.',
        );
      }

      // Caller must be a SalesUser in this tenant.
      const callerSalesUser = await this.prisma.salesUser.findFirst({
        where: { userId: user.sub, clientId: user.clientId, deletedAt: null },
        select: { id: true },
      });
      if (!callerSalesUser) {
        throw new ForbiddenException(
          'Only sales users may enroll on behalf of a partner (SALES mode).',
        );
      }

      // Target partner must belong to this tenant.
      const targetPartner = await this.prisma.channelPartner.findFirst({
        where: { id: dto.targetPartnerId, clientId: user.clientId, deletedAt: null },
        select: { id: true, userId: true },
      });
      if (!targetPartner) {
        throw new NotFoundException('Target partner not found in this tenant.');
      }

      // Caller must have an ACTIVE assignment to this partner. Assignments may be
      // keyed by partnerId (admin re-assign / seed) OR by outletId (the production
      // master outlet-upload path, where partnerId is null at upload time — the
      // partner attaches later at KYC and is never backfilled on the assignment).
      // Accept EITHER so the guard matches real production assignments, not just
      // the seeded shape. This mirrors rewards.requireAssignedPartner (gap #53 /
      // the B1 fix for #50-E redemption).
      const partnerOutlets = await this.prisma.outlet.findMany({
        where: { partnerId: dto.targetPartnerId, deletedAt: null },
        select: { id: true },
      });
      const outletIds = partnerOutlets.map((o) => o.id);
      const assignment = await this.prisma.salesUserAssignment.findFirst({
        where: {
          salesUserId: callerSalesUser.id,
          unassignedAt: null,
          OR: [
            { partnerId: dto.targetPartnerId },
            ...(outletIds.length ? [{ outletId: { in: outletIds } }] : []),
          ],
        },
        select: { id: true },
      });
      if (!assignment) {
        throw new ForbiddenException(
          'You do not have an active assignment to this partner.',
        );
      }

      // A parent owner (userId nullable) is never an enrollment target; a real partner
      // always has a linked user. Guard defensively.
      if (!targetPartner.userId) {
        throw new ForbiddenException('This partner has no linked user to enroll.');
      }
      enrolledUserId = targetPartner.userId;
    }

    // ── 2. Load and validate scheme (tenant + state) ─────────────────────────
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, clientId: user.clientId },
      include: { enrollmentForm: true },
    });

    if (!scheme || scheme.deletedAt !== null) {
      throw new NotFoundException('Scheme not found.');
    }

    if (scheme.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Scheme is not accepting enrollments (status: ${scheme.status}).`,
      );
    }

    const now = new Date();
    if (now < scheme.startDate || now > scheme.endDate) {
      throw new BadRequestException(
        'Scheme is outside its active enrollment period.',
      );
    }

    // ── 3. Audience enforcement via campaignType ─────────────────────────────
    const enrollmentForm = scheme.enrollmentForm;
    const campaignType: string = enrollmentForm?.campaignType ?? 'MIXED';

    if (campaignType !== 'MIXED') {
      // Determine KYC status for the enrolled user.
      const enrolledPartner = await this.prisma.channelPartner.findFirst({
        where: { userId: enrolledUserId, clientId: user.clientId },
        select: {
          kycSubmissions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
      });

      const latestKycStatus = enrolledPartner?.kycSubmissions?.[0]?.status ?? null;
      const isKycApproved = latestKycStatus === 'APPROVED';

      if (campaignType === 'LOYALTY_ONLY' && !isKycApproved) {
        throw new ForbiddenException(
          'This scheme is LOYALTY_ONLY: only KYC-approved partners may enroll.',
        );
      }
      if (campaignType === 'OPEN_CAMPAIGN' && isKycApproved) {
        throw new ForbiddenException(
          'This scheme is OPEN_CAMPAIGN: KYC-approved partners are not eligible.',
        );
      }
    }

    // ── 4. Form-values validation (if a form is configured) ──────────────────
    let finalFormValues: Record<string, unknown> | null = null;

    if (enrollmentForm) {
      const rawSchema = enrollmentForm.formSchema as unknown;
      // Cast: the formSchema is stored after passing validateFormSchema so it is
      // guaranteed to be an EnrollmentFormSchema at this point.
      const parsedSchema = rawSchema as EnrollmentFormSchema;

      const submitted = dto.formValues ?? {};
      const { errors, recomputedValues } = validateSubmittedValues(parsedSchema, submitted);

      if (errors.length > 0) {
        throw new BadRequestException(
          `Form validation failed: ${errors.join(' | ')}`,
        );
      }

      // Merge: start with submitted values, then overwrite CALCULATED fields
      // with the server-recomputed values (client values are discarded).
      finalFormValues = { ...submitted, ...recomputedValues };
    }

    // ── 5. Upsert the SchemeEnrollment ───────────────────────────────────────
    // Re-enrollment (upsert on @@unique[schemeId, userId]) resets status to
    // ACTIVE and updates formValues + mode. This is intentional: a partner who
    // re-enrolls is updating their form submission, not creating a new record.
    const enrollment = await this.prisma.schemeEnrollment.upsert({
      where: {
        schemeId_userId: { schemeId, userId: enrolledUserId },
      },
      create: {
        schemeId,
        userId: enrolledUserId,
        status: 'ACTIVE',
        enrollmentMode: mode,
        formValues: (finalFormValues ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        enrolledAt: now,
      },
      update: {
        status: 'ACTIVE',
        enrollmentMode: mode,
        formValues: (finalFormValues ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        enrolledAt: now,
        updatedAt: now,
      },
    });

    return { enrollment };
  }

  /**
   * GET /v1/schemes/:id/my-enrollment
   *
   * Returns the calling user's own enrollment for the given scheme, or 404.
   * Tenant-scoped: the scheme must belong to user.clientId.
   */
  async getMyEnrollment(user: JwtPayload, schemeId: string) {
    // Validate tenant ownership of the scheme first.
    await this.assertSchemeOwnership(user, schemeId);

    const enrollment = await this.prisma.schemeEnrollment.findUnique({
      where: {
        schemeId_userId: { schemeId, userId: user.sub },
      },
    });

    if (!enrollment) throw new NotFoundException('Enrollment not found.');

    return { enrollment };
  }

}
