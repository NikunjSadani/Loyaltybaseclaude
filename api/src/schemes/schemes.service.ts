import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ListSchemesQueryDto } from './dto/schemes.dto';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { isGifsyOperator } from '../common/tenant-scope';

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
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    return user.role === 'GIFSY_ADMIN' || user.role === 'GIFSY_STAFF' || user.role === 'CLIENT_ADMIN';
  }

  async list(user: JwtPayload, q: ListSchemesQueryDto, requestedPartnerId?: string) {
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

    // Non-admin (partner / sales-enrollment) catalog visibility.
    //
    // Wave 4: `SchemeEligibility` is an OPT-IN allowlist — it restricts what a partner sees ONLY
    // when rows are configured for that subject. With none configured (the default: no code path in
    // the platform writes SchemeEligibility today) a partner sees every ACTIVE tenant scheme it can
    // enrol in. This fixes a pre-existing dead-mechanism bug where the old unconditional
    // `id IN (eligible)` collapsed to `IN ()` and hid EVERY scheme from EVERY partner.
    //
    // Threaded through the Wave-3 login picker: resolve the ACTIVE partner (own, or an authorized
    // login-less same-group sibling via `x-active-partner-id`) and match eligibility on BOTH the
    // active partner id AND the login user id — so it works whether rows are partner- or user-scoped
    // (the column is historically keyed off `user.sub`), and so a switched login-less sibling (which
    // has no user id of its own) is still matched by its partner id.
    if (!isAdmin) {
      const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
        clientId: user.clientId,
        userSub: user.sub,
        phone: user.phone,
        requestedPartnerId,
      });
      if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');

      const subjects = [partnerId, user.sub].filter((s): s is string => Boolean(s));
      const eligibilities = await this.prisma.schemeEligibility.findMany({
        where: { specificPartnerId: { in: subjects } },
        select: { schemeId: true },
      });
      // Opt-in: only narrow the catalog when this subject actually has eligibility rows.
      if (eligibilities.length > 0) {
        where.id = { in: eligibilities.map((e) => e.schemeId) };
      }
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

  async getOne(user: JwtPayload, id: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id, clientId: user.clientId },
      include: { eligibility: true },
    });

    if (scheme && scheme.deletedAt !== null) throw new NotFoundException('Scheme not found');
    if (!scheme) throw new NotFoundException('Scheme not found');

    return { scheme };
  }

  async remove(user: JwtPayload, id: string) {
    // GIFSY_ADMIN only — enforced at the controller; re-stated here for safety.
    // RBAC Option-X: GIFSY_STAFF (permission-gated) is a platform operator
    if (!isGifsyOperator(user)) throw new ForbiddenException('Forbidden - Gifsy Admin only');

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
