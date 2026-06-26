import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  ListFraudLogQueryDto,
  ListSubmissionsQueryDto,
  OutletStatusesQueryDto,
  RejectSubmissionDto,
  SubmitVisibilityDto,
} from './dto/visibility.dto';
import { StorageService } from '../storage/storage.service';

/** Image MIME allowlist for visibility photo submissions. */
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Visibility — ported from platform/src/app/api/visibility/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT). Submissions are scoped
 * through the partner→user relation; approve/reject/fraud-log are GIFSY-only
 * (enforced by @Roles on the controller; tenant scope re-checked here). Business
 * logic lives here; the controller is a thin HTTP adapter.
 *
 * POST /visibility/submit (partner photo submission) is now ported here: it uses
 * StorageService for the GCS upload (same pattern as kyc.uploadDocument). The
 * partner is resolved from the JWT (never trusted from the request body), and the
 * outlet from the partner — so a partner can only submit for their own outlet.
 */
@Injectable()
export class VisibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Tenant filter for visibility submissions (gap #38 / VERIFICATION-PROTOCOL §72).
   * GIFSY_ADMIN is the cross-tenant operator (approve/reject visibility across all
   * tenants) → EXEMPT from the caller-tenant filter; every other role is hard-scoped
   * to its own clientId via the partner→user relation. Spreadable where-fragment.
   * Owner decision: Gifsy sees all tenants (DATA-VISIBILITY §3.1).
   */
  private submissionTenantFilter(user: JwtPayload): Prisma.VisibilitySubmissionWhereInput {
    return user.role === 'GIFSY_ADMIN' ? {} : { partner: { user: { clientId: user.clientId } } };
  }

  /**
   * Master gate — the whole Visibility module is opt-in per tenant. When the tenant's
   * `visibilityEnabled` setting is false (the default), visibility endpoints 403 for that
   * tenant's own users (CLIENT_ADMIN/sales/partner — their clientId IS their tenant).
   *
   * The GIFSY platform operator is EXEMPT only in TRUE platform context (`!assumed`) —
   * keying the gate to the operator's own clientId (the gifsy tenant) would wrongly block
   * them from working the cross-tenant approval queue for ENABLED tenants. When the operator
   * has ASSUMED a tenant (`assumed === true`, clientId = the assumed tenant), they act AS that
   * tenant, so the tenant's own switch applies — this makes "OFF means OFF" hold even for an
   * operator (matching the FE, which hides every visibility surface for an OFF assumed tenant).
   * `role`/`assumed` come from the signed JWT and cannot be forged by a non-operator
   * (assumeTenant requires role GIFSY_ADMIN). The real data-ENTRY teeth (partner submit; admin
   * bulk-upload — clientId = the tenant) are gated for every non-platform caller.
   */
  private async assertVisibilityEnabled(user: JwtPayload): Promise<void> {
    if (user.role === 'GIFSY_ADMIN' && !user.assumed) return;
    const enabled = await this.tenant.resolveVisibilityEnabled(user.clientId);
    if (!enabled) {
      throw new ForbiddenException('Visibility is not enabled for this tenant.');
    }
  }

  /**
   * POST /v1/visibility/submit — partner submits a branding photo for an outlet.
   *
   * Scoping/trust: the partner is resolved from the JWT (user.sub) — never from
   * the request — so partnerId is always the caller's own ChannelPartner. The
   * outlet is either the caller-supplied outletId (validated to belong to this
   * partner) or, when omitted, the partner's single active outlet. The program is
   * validated to belong to the caller's tenant.
   *
   * Mode gate: only PHOTO_APPROVAL tenants accept photo submissions (mirrors the
   * approve/reject gate). Submissions land in SUBMITTED (queued for review).
   */
  async submit(user: JwtPayload, file: Express.Multer.File, dto: SubmitVisibilityDto) {
    // 0. Master gate — visibility must be enabled for the tenant.
    await this.assertVisibilityEnabled(user);

    // 1. Validate the uploaded image.
    if (!file) throw new BadRequestException('Image file is required');
    if (!file.buffer?.length) throw new BadRequestException('Empty image file');
    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image too large (max 5 MB)');
    }
    if (!ALLOWED_IMAGE_MIME.includes(file.mimetype)) {
      throw new BadRequestException('Invalid image format. Allowed: JPEG, PNG, WEBP');
    }

    // 2. Tenant must be in PHOTO_APPROVAL mode for photo submissions.
    const captureMode = await this.tenant.resolveVisibilityCaptureMode(user.clientId);
    if (captureMode !== 'PHOTO_APPROVAL') {
      throw new BadRequestException(
        'Tenant is not configured for photo-approval visibility. ' +
          'Photo submissions are only available when features.visibilityCaptureMode = "PHOTO_APPROVAL".',
      );
    }

    // 3. Resolve the calling partner from the JWT (never from the request body).
    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId } },
      select: { id: true },
    });
    if (!partner) throw new ForbiddenException('Only channel partners can submit visibility photos');

    // 4. Validate the program belongs to this tenant.
    const program = await this.prisma.visibilityProgram.findFirst({
      where: { id: dto.programId, clientId: user.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!program) throw new NotFoundException('Visibility program not found');

    // 5. Resolve the outlet — caller-supplied (validated to this partner) or the
    //    partner's single active outlet when omitted (the partner app sends none).
    let outletId = dto.outletId;
    if (outletId) {
      const outlet = await this.prisma.outlet.findFirst({
        where: { id: outletId, partnerId: partner.id, clientId: user.clientId },
        select: { id: true },
      });
      if (!outlet) throw new NotFoundException('Outlet not found for this partner');
    } else {
      const outlets = await this.prisma.outlet.findMany({
        where: { partnerId: partner.id, clientId: user.clientId, isActive: true },
        select: { id: true },
        take: 2,
      });
      if (outlets.length === 0) {
        throw new BadRequestException('No active outlet found for this partner');
      }
      if (outlets.length > 1) {
        throw new BadRequestException('Multiple outlets found — specify outletId');
      }
      outletId = outlets[0].id;
    }

    // 6. Upload the image to GCS (tenant-foldered key), then persist the submission.
    const key = this.storage.generateKey(
      `visibility/${user.clientId}`,
      file.originalname || 'visibility.jpg',
    );
    const imageUrl = await this.storage.uploadFile(file.buffer, key, file.mimetype);

    const geoLat = dto.geoLat != null && dto.geoLat !== '' ? Number(dto.geoLat) : null;
    const geoLng = dto.geoLng != null && dto.geoLng !== '' ? Number(dto.geoLng) : null;

    const submission = await this.prisma.visibilitySubmission.create({
      data: {
        programId: program.id,
        partnerId: partner.id,
        outletId,
        imageUrls: [imageUrl],
        latitude: Number.isFinite(geoLat as number) ? (geoLat as number) : null,
        longitude: Number.isFinite(geoLng as number) ? (geoLng as number) : null,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
      select: { id: true, status: true, submittedAt: true },
    });

    return { submissionId: submission.id, status: submission.status, submittedAt: submission.submittedAt };
  }

  /**
   * GET /v1/visibility/submissions — paginated submissions for the tenant,
   * scoped through partner.user.clientId (mirrors the source `where`).
   */
  async listSubmissions(user: JwtPayload, q: ListSubmissionsQueryDto) {
    await this.assertVisibilityEnabled(user);
    // Partners submit via POST /submit; they do not list the tenant's submissions.
    // Mirror the denylist already enforced in outletStatuses (@Roles can't express
    // "everyone except partners", so the block lives in the service).
    const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];
    if (partnerRoles.includes(user.role)) throw new ForbiddenException('Forbidden');

    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.VisibilitySubmissionWhereInput = {
      ...this.submissionTenantFilter(user),
    };
    if (q.outletId) where.outletId = q.outletId;
    if (q.programId) where.programId = q.programId;
    if (q.status) where.status = q.status;

    const [submissions, total] = await Promise.all([
      this.prisma.visibilitySubmission.findMany({
        where,
        include: {
          partner: { select: { id: true, businessName: true } },
          outlet: { select: { id: true, name: true, city: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.visibilitySubmission.count({ where }),
    ]);

    return {
      submissions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * POST /v1/visibility/submissions/:id/approve — GIFSY-only.
   * Transitions DRAFT/SUBMITTED/etc → APPROVED, records the approval and an audit log.
   *
   * Mode gate: only allowed when the tenant's visibilityCaptureMode is PHOTO_APPROVAL
   * (the default). AMOUNT_UPLOAD tenants do not use photo submissions.
   */
  async approve(user: JwtPayload, id: string) {
    await this.assertVisibilityEnabled(user);
    const captureMode = await this.tenant.resolveVisibilityCaptureMode(user.clientId);
    if (captureMode !== 'PHOTO_APPROVAL') {
      throw new BadRequestException(
        'Tenant is not configured for photo-approval visibility. ' +
          'Approval actions are only available when features.visibilityCaptureMode = "PHOTO_APPROVAL".',
      );
    }

    // GIFSY-only is enforced by @Roles on the controller; tenant scope checked here.
    const submission = await this.prisma.visibilitySubmission.findFirst({
      where: { id, ...this.submissionTenantFilter(user) },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status === 'APPROVED') throw new BadRequestException('Already approved');

    await this.prisma.$transaction(async (tx) => {
      const prevStatus = submission.status;

      await tx.visibilitySubmission.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedByUserId: user.sub,
          reviewedAt: new Date(),
        },
      });

      await tx.visibilityApproval.create({
        data: {
          submissionId: id,
          reviewerUserId: user.sub,
          fromStatus: prevStatus,
          toStatus: 'APPROVED',
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'APPROVE',
          entityType: 'VISIBILITY_SUBMISSION',
          entityId: id,
          actorId: user.sub,
        },
      });
    });

    return { message: 'Submission approved successfully' };
  }

  /**
   * POST /v1/visibility/submissions/:id/reject — GIFSY-only.
   * Transitions → REJECTED with a reason, records the approval row and an audit log.
   *
   * Mode gate: only allowed when the tenant's visibilityCaptureMode is PHOTO_APPROVAL
   * (the default). AMOUNT_UPLOAD tenants do not use photo submissions.
   */
  async reject(user: JwtPayload, id: string, dto: RejectSubmissionDto) {
    await this.assertVisibilityEnabled(user);
    const captureMode = await this.tenant.resolveVisibilityCaptureMode(user.clientId);
    if (captureMode !== 'PHOTO_APPROVAL') {
      throw new BadRequestException(
        'Tenant is not configured for photo-approval visibility. ' +
          'Reject actions are only available when features.visibilityCaptureMode = "PHOTO_APPROVAL".',
      );
    }

    // GIFSY-only is enforced by @Roles on the controller; tenant scope checked here.
    const submission = await this.prisma.visibilitySubmission.findFirst({
      where: { id, ...this.submissionTenantFilter(user) },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status === 'REJECTED') throw new BadRequestException('Already rejected');

    const { reason } = dto;

    await this.prisma.$transaction(async (tx) => {
      const prevStatus = submission.status;

      await tx.visibilitySubmission.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          reviewedByUserId: user.sub,
          reviewedAt: new Date(),
        },
      });

      await tx.visibilityApproval.create({
        data: {
          submissionId: id,
          reviewerUserId: user.sub,
          fromStatus: prevStatus,
          toStatus: 'REJECTED',
          notes: reason,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'REJECT',
          entityType: 'VISIBILITY_SUBMISSION',
          entityId: id,
          actorId: user.sub,
          metadata: { reason },
        },
      });
    });

    return { message: 'Submission rejected successfully' };
  }

  /**
   * GET /v1/visibility/outlet-statuses — outletCode→status map for a month.
   * Internal roles only; partner roles are blocked at the controller via @Roles
   * is not expressive enough here (it is a deny-list), so the block is enforced
   * in the service to mirror the source exactly.
   */
  async outletStatuses(user: JwtPayload, q: OutletStatusesQueryDto) {
    await this.assertVisibilityEnabled(user);
    const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];
    if (partnerRoles.includes(user.role)) throw new ForbiddenException('Forbidden');

    const outletCodesParam = q.outletCodes ?? '';
    // Default to current month (YYYY-MM) if not provided.
    const month = q.month ?? new Date().toISOString().slice(0, 7);

    if (!outletCodesParam) return {};

    // Each code is encodeURIComponent'd by the FE before being joined on ',' (outlet
    // codes may contain any character, including the ',' delimiter — owner 2026-06-26),
    // so split on the raw ',' delimiter, then decode each segment back to its real value.
    // Trim first: stored codes are always trimmed at creation, so a stray edge space from
    // a hand-built query never removes a meaningful character.
    const outletCodes = outletCodesParam
      .split(',')
      .map((c) => {
        const t = c.trim();
        try {
          return decodeURIComponent(t);
        } catch {
          return t; // malformed %-sequence: fall back to the raw segment
        }
      })
      .filter(Boolean);

    if (outletCodes.length === 0) return {};

    const records = await this.prisma.outletVisibilityRecord.findMany({
      where: {
        clientId: user.clientId,
        month,
        outletCode: { in: outletCodes },
      },
      select: {
        outletCode: true,
        status: true,
        dateOfCapture: true,
        approvedBy: true,
        capturedByEmployeeName: true,
      },
    });

    // Build outletCode → status map
    const statusMap: Record<
      string,
      {
        status: string;
        dateOfCapture: string | null;
        approvedBy: string | null;
        capturedByEmployeeName: string | null;
      }
    > = {};

    for (const record of records) {
      statusMap[record.outletCode] = {
        status: record.status,
        dateOfCapture: record.dateOfCapture ? record.dateOfCapture.toISOString().slice(0, 10) : null,
        approvedBy: record.approvedBy,
        capturedByEmployeeName: record.capturedByEmployeeName,
      };
    }

    return statusMap;
  }

  /**
   * GET /v1/visibility/fraud-log — GIFSY-only paginated fraud log,
   * scoped through submission.partner.user.clientId (mirrors the source `where`).
   */
  async listFraudLog(user: JwtPayload, q: ListFraudLogQueryDto) {
    await this.assertVisibilityEnabled(user);
    // GIFSY-only is enforced by @Roles on the controller.
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const dateFrom = q.dateFrom ? new Date(q.dateFrom) : undefined;
    const dateTo = q.dateTo ? new Date(q.dateTo) : undefined;

    const where: Prisma.VisibilityFraudLogWhereInput =
      user.role === 'GIFSY_ADMIN'
        ? {}
        : { submission: { partner: { user: { clientId: user.clientId } } } };
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = dateFrom;
      if (dateTo) where.createdAt.lte = dateTo;
    }

    const [logs, total] = await Promise.all([
      this.prisma.visibilityFraudLog.findMany({
        where,
        include: {
          submission: { select: { id: true, partnerId: true, outletId: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.visibilityFraudLog.count({ where }),
    ]);

    return {
      logs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
}
