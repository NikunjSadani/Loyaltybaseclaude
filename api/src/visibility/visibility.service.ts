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
} from './dto/visibility.dto';

/**
 * Visibility — ported from platform/src/app/api/visibility/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT). Submissions are scoped
 * through the partner→user relation; approve/reject/fraud-log are GIFSY-only
 * (enforced by @Roles on the controller; tenant scope re-checked here). Business
 * logic lives here; the controller is a thin HTTP adapter.
 *
 * NOTE: the source POST /visibility/submit route is intentionally NOT ported — it
 * depends on multipart image upload + GCS storage infra (lib/s3.ts) that is owned
 * centrally and not present in this api. See the agent report.
 */
@Injectable()
export class VisibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
  ) {}

  /**
   * GET /v1/visibility/submissions — paginated submissions for the tenant,
   * scoped through partner.user.clientId (mirrors the source `where`).
   */
  async listSubmissions(user: JwtPayload, q: ListSubmissionsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.VisibilitySubmissionWhereInput = {
      partner: { user: { clientId: user.clientId } },
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
    const captureMode = await this.tenant.resolveVisibilityCaptureMode(user.clientId);
    if (captureMode !== 'PHOTO_APPROVAL') {
      throw new BadRequestException(
        'Tenant is not configured for photo-approval visibility. ' +
          'Approval actions are only available when features.visibilityCaptureMode = "PHOTO_APPROVAL".',
      );
    }

    // GIFSY-only is enforced by @Roles on the controller; tenant scope checked here.
    const submission = await this.prisma.visibilitySubmission.findFirst({
      where: { id, partner: { user: { clientId: user.clientId } } },
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
    const captureMode = await this.tenant.resolveVisibilityCaptureMode(user.clientId);
    if (captureMode !== 'PHOTO_APPROVAL') {
      throw new BadRequestException(
        'Tenant is not configured for photo-approval visibility. ' +
          'Reject actions are only available when features.visibilityCaptureMode = "PHOTO_APPROVAL".',
      );
    }

    // GIFSY-only is enforced by @Roles on the controller; tenant scope checked here.
    const submission = await this.prisma.visibilitySubmission.findFirst({
      where: { id, partner: { user: { clientId: user.clientId } } },
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
    const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];
    if (partnerRoles.includes(user.role)) throw new ForbiddenException('Forbidden');

    const outletCodesParam = q.outletCodes ?? '';
    // Default to current month (YYYY-MM) if not provided.
    const month = q.month ?? new Date().toISOString().slice(0, 7);

    if (!outletCodesParam) return {};

    const outletCodes = outletCodesParam
      .split(',')
      .map((c) => c.trim())
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
    // GIFSY-only is enforced by @Roles on the controller.
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const dateFrom = q.dateFrom ? new Date(q.dateFrom) : undefined;
    const dateTo = q.dateTo ? new Date(q.dateTo) : undefined;

    const where: Prisma.VisibilityFraudLogWhereInput = {
      submission: { partner: { user: { clientId: user.clientId } } },
    };
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
