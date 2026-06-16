import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, KycFieldKey } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { KYC_FIELD_KEYS } from './kyc-verification.helper';
import {
  generateKycReviewDumpExcel,
  KycReviewDumpEntry,
  KycReviewDumpFieldState,
} from './kyc-review-dump';
import {
  ConsentKycDto,
  CreateKycDto,
  FirstApproveKycDto,
  ListKycQueryDto,
  NotInterestedKycDto,
  RejectKycDto,
  UpdateKycDto,
  UploadKycDocumentDto,
} from './dto/kyc.dto';
import {
  canFirstApprove,
  initialKycStatus,
  nextStatusAfterFirstApprove,
  detectEscalation,
} from './kyc-approval.helper';

/**
 * KYC & Enrollment — ported from platform/src/app/api/kyc/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT). The multi-level field
 * approval chain (SO → ASM → RSM → Gifsy) is preserved; pure routing logic lives
 * in kyc-approval.helper.ts. Business logic lives here; the controller is a thin
 * HTTP adapter.
 *
 * Notifications: the source `sendNotification(userId, EVENT, data)` looked up a
 * DB template and dispatched SMS/WhatsApp. Here we enqueue a QUEUED row via the
 * foundation NotificationsService (delivery is P7); the original event code is
 * passed through `variables.event` so the worker can resolve the template.
 *
 * Documents: the source stored the provided dataUrl/storage URL directly on
 * KycDocument.fileUrl (no multipart upload happens on this path — the form posts
 * JSON with base64/url document references), so no StorageService upload is used.
 */
@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  // ─── POST /v1/kyc/documents ──────────────────────────────────────────────────
  /**
   * Upload a single KYC document to GCS and return its object reference. The form
   * uploads each file here as the user picks it, then submits the KYC (POST /v1/kyc)
   * with the returned { fileKey, fileUrl } instead of inlining base64 — keeping the
   * bytes in object storage, not the DB. Files are private; reads go through a
   * signed URL at review time.
   */
  async uploadDocument(user: JwtPayload, file: Express.Multer.File, dto: UploadKycDocumentDto) {
    if (!file) throw new BadRequestException('No file uploaded');

    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — typical KYC photo/doc
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('File too large (max 5 MB)');
    }

    // Tenant-foldered key so objects are partitioned per client.
    const key = this.storage.generateKey(
      `kyc/${user.clientId}`,
      file.originalname || `${dto.documentType}.bin`,
    );
    const fileUrl = await this.storage.uploadFile(file.buffer, key, file.mimetype);

    return {
      documentType: dto.documentType,
      fileKey: key,
      fileUrl,
      fileName: file.originalname ?? null,
      mimeType: file.mimetype ?? null,
      fileSizeBytes: file.size,
    };
  }

  private isAdmin(role: string): boolean {
    return role === 'GIFSY_ADMIN' || role === 'CLIENT_ADMIN';
  }

  /** Enqueue a KYC notification, mirroring the source's fire-and-forget semantics. */
  private async notify(
    userId: string,
    event: string,
    body: string,
    variables: Record<string, unknown>,
    recipientPhone?: string,
  ): Promise<void> {
    await this.notifications
      .enqueue({
        userId,
        channel: 'SMS',
        body,
        recipientPhone,
        variables: { event, ...variables },
      })
      .catch(() => {
        // Non-critical: notification failures must not fail the request.
      });
  }

  // ─── POST /v1/kyc ────────────────────────────────────────────────────────────
  async create(user: JwtPayload, dto: CreateKycDto) {
    // 1. Find channel partner for this user (tenant-scoped).
    let partner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, clientId: user.clientId },
    });

    // 2. Update ChannelPartner with submitted details (bank + identity).
    if (partner) {
      partner = await this.prisma.channelPartner.update({
        where: { id: partner.id },
        data: {
          businessName: dto.partnerName,
          phone: dto.mobile,
          gstNumber: dto.gstNumber ?? undefined,
          panNumber: dto.panNumber ?? undefined,
          bankName: dto.bankName ?? undefined,
          bankAccountNumber: dto.accountNumber ?? undefined,
          bankAccountHolder: dto.accountHolderName ?? undefined,
          ifscCode: dto.ifscCode ?? undefined,
          upiId: dto.upiId ?? undefined,
          paymentMode: dto.paymentMode ?? undefined,
        },
      });
    }

    // 3. Block duplicate in-flight submissions.
    const existing = await this.prisma.kycSubmission.findFirst({
      where: {
        userId: user.sub,
        status: {
          in: [
            'DRAFT',
            'SUBMITTED',
            'UNDER_REVIEW',
            'PENDING_SO_APPROVAL',
            'PENDING_ASM_APPROVAL',
            'PENDING_RSM_APPROVAL',
            'PENDING_GIFSY',
          ],
        },
      },
    });
    if (existing) throw new BadRequestException('You already have a pending KYC submission');

    // 4. Escalation routing (preserved from original).
    const status = initialKycStatus(user.role);
    const escalatedFrom = detectEscalation(user.role, status);

    // 5. Create KycSubmission with all geo + notes.
    const submission = await this.prisma.kycSubmission.create({
      data: {
        userId: user.sub,
        partnerId: partner?.id ?? null,
        status: status as never,
        escalatedFrom: escalatedFrom ?? null,
        reviewerNotes: dto.reviewerNotes ?? null,
        submittedAt: new Date(),

        boardPhotoLat: dto.boardPhotoGeo?.lat ?? null,
        boardPhotoLng: dto.boardPhotoGeo?.lng ?? null,
        boardPhotoGeoAccuracy: dto.boardPhotoGeo?.accuracy ?? null,
        boardPhotoGeoAt: dto.boardPhotoGeo?.ts ? new Date(dto.boardPhotoGeo.ts) : null,

        paymentLat: dto.paymentGeo?.lat ?? null,
        paymentLng: dto.paymentGeo?.lng ?? null,
        paymentGeoAccuracy: dto.paymentGeo?.accuracy ?? null,
        paymentGeoAt: dto.paymentGeo?.ts ? new Date(dto.paymentGeo.ts) : null,
      },
    });

    // 6. Log initial status history.
    await this.prisma.kycStatusHistory.create({
      data: {
        kycSubmissionId: submission.id,
        toStatus: status as never,
        changedByUserId: user.sub,
        notes: escalatedFrom
          ? `Escalated — ${escalatedFrom} has resigned`
          : 'Submitted for review',
      },
    });

    // 7. Create KycDocument records for each submitted document.
    const docPromises: Promise<unknown>[] = [];

    if (dto.documents?.length) {
      for (const doc of dto.documents) {
        if (!doc.type) continue;
        // Prefer a GCS-uploaded object (fileKey/fileUrl from POST /v1/kyc/documents);
        // fall back to the legacy inline dataUrl, then a pending placeholder.
        const fileUrl = doc.fileUrl ?? doc.dataUrl ?? `pending://kyc/${submission.id}/${doc.type}`;
        const fileKey = doc.fileKey ?? `kyc/${submission.id}/${doc.type}/${Date.now()}`;
        docPromises.push(
          this.prisma.kycDocument.create({
            data: {
              kycSubmissionId: submission.id,
              documentType: doc.type as never,
              fileUrl,
              fileKey,
              fileName: doc.fileName ?? null,
              mimeType: doc.mimeType ?? null,
              fileSizeBytes: doc.fileSizeBytes ?? null,
              status: 'PENDING',
            },
          }),
        );
      }
    }

    // 8. Signature document — store the base64 PNG.
    if (dto.signatureDataUrl) {
      docPromises.push(
        this.prisma.kycDocument.create({
          data: {
            kycSubmissionId: submission.id,
            documentType: 'SIGNATURE',
            fileUrl: dto.signatureDataUrl,
            fileKey: `kyc/${submission.id}/SIGNATURE/${Date.now()}`,
            fileName: 'signature.png',
            mimeType: 'image/png',
            status: 'PENDING',
          },
        }),
      );
    }

    await Promise.all(docPromises);

    return { submissionId: submission.id, status, escalatedFrom };
  }

  // ─── GET /v1/kyc ─────────────────────────────────────────────────────────────
  async list(user: JwtPayload, q: ListKycQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.KycSubmissionWhereInput = { user: { clientId: user.clientId } };

    if (user.role === 'SALES_SO') {
      where.status = 'PENDING_SO_APPROVAL';
    } else if (user.role === 'SALES_ASM') {
      where.status = 'PENDING_ASM_APPROVAL';
    } else if (user.role === 'SALES_STATE_HEAD') {
      where.status = 'PENDING_RSM_APPROVAL';
    } else if (!this.isAdmin(user.role)) {
      where.userId = user.sub;
    }

    if (q.status && this.isAdmin(user.role)) {
      where.status = q.status;
    }

    const [submissions, total] = await Promise.all([
      this.prisma.kycSubmission.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, phone: true } },
          partner: { select: { id: true, businessName: true } },
          documents: { select: { id: true, documentType: true, status: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.kycSubmission.count({ where }),
    ]);

    const statusCounts = await this.prisma.kycSubmission.groupBy({
      by: ['status'],
      where: this.isAdmin(user.role)
        ? { user: { clientId: user.clientId } }
        : { userId: user.sub, user: { clientId: user.clientId } },
      _count: { status: true },
    });

    return {
      submissions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      statusCounts: statusCounts.reduce<Record<string, number>>((acc, s) => {
        acc[s.status] = s._count.status;
        return acc;
      }, {}),
    };
  }

  // ─── GET /v1/kyc/:id ─────────────────────────────────────────────────────────
  async getOne(user: JwtPayload, id: string) {
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, user: { clientId: user.clientId } },
      include: {
        documents: true,
        statusHistory: { orderBy: { createdAt: 'desc' } },
        user: { select: { id: true, name: true, phone: true, role: true } },
        partner: true,
      },
    });

    if (!submission) throw new NotFoundException('KYC submission not found');

    // Non-admin users can only view their own submissions.
    if (!this.isAdmin(user.role) && submission.userId !== user.sub) {
      throw new ForbiddenException('Forbidden');
    }

    return { submission };
  }

  // ─── PATCH /v1/kyc/:id ───────────────────────────────────────────────────────
  async update(user: JwtPayload, id: string, dto: UpdateKycDto) {
    // GIFSY-only is enforced by @Roles on the controller; re-checked logically here.
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Admin only');

    const { status, rejectionReason, reviewerNotes } = dto;

    // Reason is mandatory for REJECTED and RE_UPLOAD_REQUIRED.
    if ((status === 'REJECTED' || status === 'RE_UPLOAD_REQUIRED') && !rejectionReason) {
      throw new BadRequestException(
        'Rejection reason is mandatory for REJECTED or RE_UPLOAD_REQUIRED status',
      );
    }

    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, user: { clientId: user.clientId } },
    });
    if (!submission) throw new NotFoundException('KYC submission not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.kycSubmission.update({
        where: { id },
        data: {
          ...(status && { status: status as never }),
          ...(rejectionReason && { rejectionReason }),
          ...(reviewerNotes && { reviewerNotes }),
        },
      });

      if (status) {
        await tx.kycStatusHistory.create({
          data: {
            kycSubmissionId: id,
            fromStatus: submission.status,
            toStatus: status as never,
            notes: rejectionReason ?? null,
            changedByUserId: user.sub,
          },
        });
      }

      return result;
    });

    return { submission: updated };
  }

  // ─── POST /v1/kyc/:id/first-approve ──────────────────────────────────────────
  async firstApprove(user: JwtPayload, id: string, dto: FirstApproveKycDto) {
    const { remarks } = dto;

    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, user: { clientId: user.clientId } },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        partner: { select: { id: true, businessName: true } },
      },
    });
    if (!submission) throw new NotFoundException('KYC submission not found');

    // Only the correct role for the current status may act.
    if (!canFirstApprove(user.role, submission.status)) {
      throw new ForbiddenException(
        `Your role (${user.role}) cannot approve a submission in status "${submission.status}"`,
      );
    }

    const nextStatus = nextStatusAfterFirstApprove(submission.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.kycSubmission.update({
        where: { id },
        data: { status: nextStatus as never, reviewedAt: new Date() },
      });

      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          fromStatus: submission.status,
          toStatus: nextStatus as never,
          changedByUserId: user.sub,
          notes: remarks ?? `Approved by ${user.role}`,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'APPROVE',
          entityType: 'KYC_SUBMISSION',
          entityId: id,
          actorId: user.sub,
          oldValues: { status: submission.status },
          newValues: { status: nextStatus },
          metadata: { stage: 'FIRST_APPROVER', approverRole: user.role, remarks },
        },
      });
    });

    await this.notify(
      submission.userId,
      'KYC_UNDER_REVIEW',
      `Your KYC is under review.`,
      { name: submission.user.name ?? submission.user.phone },
      submission.user.phone ?? undefined,
    );

    return { message: 'KYC first-approval recorded successfully', nextStatus, submissionId: id };
  }

  // ─── POST /v1/kyc/:id/approve ────────────────────────────────────────────────
  async approve(user: JwtPayload, id: string) {
    // GIFSY-only is enforced by @Roles on the controller; re-checked logically here.
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden — Gifsy Admin only');

    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, user: { clientId: user.clientId } },
      include: { user: true, partner: true },
    });
    if (!submission) throw new NotFoundException('KYC submission not found');
    if (submission.status === 'APPROVED') throw new BadRequestException('Already approved');

    // Guard: field approver must have acted first.
    if (submission.status !== 'PENDING_GIFSY') {
      throw new ConflictException(
        `Cannot approve — submission is in "${submission.status}". ` +
          `The field approver (SO / ASM / RSM) must act first via POST /v1/kyc/${id}/first-approve.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.kycSubmission.update({
        where: { id },
        data: { status: 'APPROVED', approvedAt: new Date() },
      });

      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          fromStatus: 'PENDING_GIFSY',
          toStatus: 'APPROVED',
          changedByUserId: user.sub,
          notes: 'Final approval by Gifsy Admin',
          metadata: { stage: 'GIFSY' },
        },
      });

      // Activate the user's account.
      await tx.user.update({
        where: { id: submission.userId },
        data: { status: 'ACTIVE' },
      });

      // Create wallet if not already present.
      if (submission.partnerId) {
        const existingWallet = await tx.wallet.findFirst({
          where: { partnerId: submission.partnerId },
        });
        if (!existingWallet) {
          await tx.wallet.create({ data: { partnerId: submission.partnerId } });
        }
      }

      await tx.auditLog.create({
        data: {
          action: 'APPROVE',
          entityType: 'KYC_SUBMISSION',
          entityId: id,
          actorId: user.sub,
          oldValues: { status: 'PENDING_GIFSY' },
          newValues: { status: 'APPROVED' },
          metadata: { stage: 'GIFSY', submissionId: id, userId: submission.userId },
        },
      });
    });

    await this.notify(
      submission.userId,
      'KYC_APPROVED',
      `Your KYC has been approved.`,
      { name: submission.user.name ?? submission.user.phone },
      submission.user.phone ?? undefined,
    );

    return { message: 'KYC approved successfully' };
  }

  // ─── POST /v1/kyc/:id/reject ─────────────────────────────────────────────────
  async reject(user: JwtPayload, id: string, dto: RejectKycDto) {
    const { reason, requiredAction } = dto;
    const status = dto.status ?? 'REJECTED';

    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, user: { clientId: user.clientId } },
      include: { user: true },
    });
    if (!submission) throw new NotFoundException('KYC submission not found');
    if (submission.status === 'REJECTED') throw new BadRequestException('Already rejected');

    // Gifsy admin can reject at any stage. Field approvers can only reject when
    // the submission is currently awaiting them.
    const isGifsyAdmin = user.role === 'GIFSY_ADMIN';
    const isFieldApprover = canFirstApprove(user.role, submission.status);

    if (!isGifsyAdmin && !isFieldApprover) {
      throw new ForbiddenException(
        `Your role (${user.role}) cannot reject a submission in status "${submission.status}"`,
      );
    }

    const stage = isGifsyAdmin ? 'GIFSY' : 'FIRST_APPROVER';

    await this.prisma.$transaction(async (tx) => {
      await tx.kycSubmission.update({
        where: { id },
        data: { status: status as never, rejectionReason: reason },
      });

      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          fromStatus: submission.status,
          toStatus: status as never,
          changedByUserId: user.sub,
          notes: reason,
          metadata: { stage, requiredAction, approverRole: user.role },
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'REJECT',
          entityType: 'KYC_SUBMISSION',
          entityId: id,
          actorId: user.sub,
          oldValues: { status: submission.status },
          newValues: { status },
          metadata: { stage, reason, requiredAction },
        },
      });
    });

    await this.notify(
      submission.userId,
      'KYC_REJECTED',
      `Your KYC was rejected. Reason: ${reason}`,
      { reason, requiredAction: requiredAction ?? '' },
      submission.user.phone ?? undefined,
    );

    return {
      message:
        status === 'REJECTED'
          ? 'KYC rejected successfully'
          : 'Re-upload requested successfully',
    };
  }

  // ─── GET /v1/kyc/:id/ledger ──────────────────────────────────────────────────
  async ledger(user: JwtPayload, id: string) {
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, user: { clientId: user.clientId } },
      include: {
        partner: {
          select: {
            businessName: true,
            phone: true,
            outlets: {
              where: { isPrimary: true, deletedAt: null },
              select: { outletCode: true },
              take: 1,
            },
            wallets: {
              include: {
                transactions: { orderBy: { createdAt: 'desc' }, take: 200 },
              },
            },
          },
        },
      },
    });

    if (!submission) throw new NotFoundException('KYC submission not found');

    const partner = submission.partner;
    const wallet = partner?.wallets[0] ?? null;

    return {
      meta: {
        name: partner?.businessName ?? 'Unknown',
        outletCode: partner?.outlets[0]?.outletCode ?? '',
        mobile: partner?.phone ?? '',
        balance: wallet?.redeemablePoints ?? 0,
        lifetime: wallet?.lifetimeEarned ?? 0,
        redeemed: wallet?.lifetimeRedeemed ?? 0,
      },
      transactions: (wallet?.transactions ?? []).map((tx) => ({
        id: tx.id,
        date: tx.createdAt.toISOString().split('T')[0],
        description: tx.description ?? '',
        type: mapTxType(tx.transactionType),
        points: tx.points,
        balance: tx.balanceAfter,
        ref: tx.referenceId ?? undefined,
      })),
    };
  }

  // ─── POST /v1/kyc/consent ────────────────────────────────────────────────────
  async consent(user: JwtPayload, dto: ConsentKycDto) {
    const { submissionId, mobile, otp } = dto;

    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        phone: mobile,
        purpose: 'KYC_CONSENT',
        verifiedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) throw new UnauthorizedOtp('OTP not found or expired');
    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      throw new HttpException(
        'OTP locked due to too many attempts. Request a new OTP.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (otpRecord.code !== otp) {
      await this.prisma.otpCode.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
      });
      const remaining = otpRecord.maxAttempts - otpRecord.attempts - 1;
      throw new UnauthorizedOtp(`Invalid OTP. ${remaining} attempt(s) remaining.`);
    }

    // Mark OTP as verified.
    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { verifiedAt: new Date() },
    });

    // Verify the submission belongs to this user.
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id: submissionId, userId: user.sub },
    });
    if (!submission) throw new NotFoundException('KYC submission not found');

    return { verified: true, submissionId };
  }

  // ─── POST /v1/kyc/not-interested ─────────────────────────────────────────────
  async notInterested(user: JwtPayload, dto: NotInterestedKycDto) {
    const { outletId } = dto;

    // Look up the outlet by its per-tenant (clientId, outletCode) key.
    const outlet = await this.prisma.outlet.findUnique({
      where: { clientId_outletCode: { clientId: user.clientId, outletCode: outletId } },
    });

    if (!outlet) throw new NotFoundException(`Outlet "${outletId}" not found`);
    if (!outlet.isActive && outlet.kycIntent === 'NOT_INTERESTED') {
      // Already marked — idempotent.
      return { outletId, alreadyMarked: true };
    }

    await this.prisma.outlet.update({
      where: { clientId_outletCode: { clientId: user.clientId, outletCode: outletId } },
      data: {
        kycIntent: 'NOT_INTERESTED',
        kycIntentBy: user.sub,
        kycIntentAt: new Date(),
        isActive: false,
      },
    });

    return { outletId, markedAt: new Date().toISOString() };
  }

  // ─── GET /v1/kyc/sla-metrics ─────────────────────────────────────────────────
  async slaMetrics(user: JwtPayload) {
    // GIFSY-only is enforced by @Roles on the controller; re-checked logically here.
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Gifsy Admin only');

    const slaTargetHours = parseInt(process.env.SLA_TARGET_HOURS ?? '48', 10);
    const now = new Date();

    const approved = await this.prisma.kycSubmission.findMany({
      where: { status: 'APPROVED', user: { clientId: user.clientId } },
      include: {
        statusHistory: {
          where: { toStatus: 'APPROVED' },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    const approvalTimes = approved
      .filter((s) => s.statusHistory.length > 0)
      .map((s) => {
        const approvedAt = s.statusHistory[0].createdAt;
        return (approvedAt.getTime() - s.createdAt.getTime()) / (1000 * 60 * 60);
      });

    const avgApprovalTimeHours =
      approvalTimes.length > 0
        ? approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length
        : 0;

    const slaBreachCount = approvalTimes.filter((t) => t > slaTargetHours).length;
    const slaComplianceRate =
      approvalTimes.length > 0
        ? ((approvalTimes.length - slaBreachCount) / approvalTimes.length) * 100
        : 100;

    const pending = await this.prisma.kycSubmission.findMany({
      where: {
        status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'DRAFT'] },
        user: { clientId: user.clientId },
      },
      select: { createdAt: true },
    });

    const pendingAging = { '0-24h': 0, '24-48h': 0, '48-72h': 0, '72h+': 0 };

    for (const p of pending) {
      const hours = (now.getTime() - p.createdAt.getTime()) / (1000 * 60 * 60);
      if (hours <= 24) pendingAging['0-24h']++;
      else if (hours <= 48) pendingAging['24-48h']++;
      else if (hours <= 72) pendingAging['48-72h']++;
      else pendingAging['72h+']++;
    }

    const rejectionHistory = await this.prisma.kycStatusHistory.findMany({
      where: { toStatus: 'REJECTED', notes: { not: null } },
      select: { notes: true },
    });

    const rejectionByReason: Record<string, number> = {};
    for (const r of rejectionHistory) {
      const reason = r.notes ?? 'Unknown';
      rejectionByReason[reason] = (rejectionByReason[reason] ?? 0) + 1;
    }

    const reUploadCount = await this.prisma.kycSubmission.count({
      where: { status: 'RE_UPLOAD_REQUIRED', user: { clientId: user.clientId } },
    });
    const totalCount = await this.prisma.kycSubmission.count({
      where: { user: { clientId: user.clientId } },
    });
    const reUploadRate = totalCount > 0 ? (reUploadCount / totalCount) * 100 : 0;

    return {
      avgApprovalTimeHours: Math.round(avgApprovalTimeHours * 10) / 10,
      slaComplianceRate: Math.round(slaComplianceRate * 10) / 10,
      slaBreachCount,
      pendingAging,
      rejectionByReason,
      reUploadRate: Math.round(reUploadRate * 10) / 10,
    };
  }

  // ─── GET /v1/kyc/review-dump ─────────────────────────────────────────────────
  /**
   * Lane A export: one xlsx of all PENDING_GIFSY submissions for this tenant, with
   * every filled field, signed document hyperlinks, and the per-field Decision/Remark
   * columns reflecting current verification state (so re-export round-trips). Pure
   * layout in kyc-review-dump.ts; this assembles entries from real data.
   */
  async reviewDump(user: JwtPayload): Promise<Buffer> {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Gifsy Admin only');

    const submissions = await this.prisma.kycSubmission.findMany({
      where: { status: 'PENDING_GIFSY', user: { clientId: user.clientId } },
      include: {
        user: { select: { name: true, phone: true } },
        partner: {
          select: {
            businessName: true,
            ownerName: true,
            phone: true,
            gstNumber: true,
            panNumber: true,
            bankName: true,
            bankAccountNumber: true,
            bankAccountHolder: true,
            ifscCode: true,
            upiId: true,
            paymentMode: true,
            outlets: {
              where: { isPrimary: true, deletedAt: null },
              take: 1,
              select: {
                outletCode: true,
                name: true,
                addressLine1: true,
                addressLine2: true,
                city: true,
                state: true,
                pincode: true,
                programName: true,
                outletType: { select: { name: true } },
              },
            },
          },
        },
        documents: { select: { documentType: true, fileUrl: true, fileKey: true, fileName: true } },
        verificationItems: { select: { fieldKey: true, decision: true, remark: true, source: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const entries: KycReviewDumpEntry[] = [];
    for (const s of submissions) {
      const p = s.partner;
      const o = p?.outlets[0];
      const holder = p?.bankAccountHolder?.trim().toLowerCase();
      const owner = p?.ownerName?.trim().toLowerCase();
      entries.push({
        submissionId: s.id,
        outletCode: o?.outletCode ?? '',
        outletName: o?.name ?? p?.businessName ?? '',
        ownerName: p?.ownerName ?? '',
        mobile: p?.phone ?? s.user.phone ?? '',
        outletType: o?.outletType?.name ?? o?.programName ?? '',
        gstNumber: p?.gstNumber ?? '',
        panNumber: p?.panNumber ?? '',
        address: [o?.addressLine1, o?.addressLine2].filter(Boolean).join(', '),
        city: o?.city ?? '',
        state: o?.state ?? '',
        pincode: o?.pincode ?? '',
        paymentMode: p?.paymentMode ?? '',
        bankName: p?.bankName ?? undefined,
        accountHolderName: p?.bankAccountHolder ?? undefined,
        accountNumber: p?.bankAccountNumber ?? undefined,
        ifscCode: p?.ifscCode ?? undefined,
        upiId: p?.upiId ?? undefined,
        boardGeo:
          s.boardPhotoLat != null && s.boardPhotoLng != null
            ? { lat: Number(s.boardPhotoLat), lng: Number(s.boardPhotoLng) }
            : undefined,
        nameMismatch: !!(holder && owner && holder !== owner),
        documents: await this.resolveDumpDocuments(s.documents),
        fields: this.dumpFieldStates(s.verificationItems),
      });
    }

    return generateKycReviewDumpExcel(entries);
  }

  /** Build the 7-field state map, defaulting any field with no item to PENDING. */
  private dumpFieldStates(
    items: { fieldKey: KycFieldKey; decision: string; remark: string | null; source: string | null }[],
  ): Record<KycFieldKey, KycReviewDumpFieldState> {
    const out = {} as Record<KycFieldKey, KycReviewDumpFieldState>;
    for (const k of KYC_FIELD_KEYS) out[k] = { decision: 'PENDING' };
    for (const it of items) {
      out[it.fieldKey] = {
        decision: it.decision as KycReviewDumpFieldState['decision'],
        remark: it.remark ?? undefined,
        source: (it.source as KycReviewDumpFieldState['source']) ?? undefined,
      };
    }
    return out;
  }

  /**
   * Map KycDocument rows → the 6 dump doc columns, signing GCS objects for clickable
   * links. NOTE: the submission form overloads documentType 'OTHER' for both the store
   * board photo and the self-declaration, so those two are split best-effort by file
   * name — the proper fix is distinct KycDocumentType values (tracked follow-up).
   */
  private async resolveDumpDocuments(
    docs: { documentType: string; fileUrl: string; fileKey: string; fileName: string | null }[],
  ): Promise<KycReviewDumpEntry['documents']> {
    const sign = async (
      d?: { fileUrl: string; fileKey: string },
    ): Promise<string | undefined> => {
      if (!d) return undefined;
      if (d.fileKey && d.fileUrl?.startsWith('https://storage.googleapis.com/')) {
        try {
          return await this.storage.getSignedUrl(d.fileKey);
        } catch {
          return d.fileUrl;
        }
      }
      return d.fileUrl && !d.fileUrl.startsWith('pending://') ? d.fileUrl : undefined;
    };
    const byType = (t: string) => docs.find((d) => d.documentType === t);

    const others = docs.filter((d) => d.documentType === 'OTHER');
    const board = others.find((d) => /board|store/i.test(d.fileName ?? ''));
    const decl = others.find((d) => /declar|self/i.test(d.fileName ?? ''));

    return {
      gstCertificateUrl: await sign(byType('GST_CERTIFICATE')),
      addressDocUrl: await sign(byType('SHOP_ESTABLISHMENT') ?? byType('TRADE_LICENSE')),
      selfDeclarationUrl: await sign(decl ?? others.find((d) => d !== board)),
      boardPhotoUrl: await sign(board),
      ownerPhotoUrl: await sign(byType('SELFIE')),
      chequeUrl: await sign(byType('CANCELLED_CHEQUE')),
    };
  }
}

/** Maps a wallet transaction type to the ledger view's coarse type. */
function mapTxType(type: string): 'earn' | 'redeem' | 'hold' | 'expire' | 'credit' {
  switch (type) {
    case 'CREDIT_POINTS_EARNED':
      return 'earn';
    case 'CREDIT_BONUS':
    case 'CREDIT_ADJUSTMENT':
    case 'CREDIT_REVERSAL':
    case 'UNLOCK_HOLDING':
      return 'credit';
    case 'DEBIT_REDEMPTION':
    case 'DEBIT_ADJUSTMENT':
      return 'redeem';
    case 'DEBIT_EXPIRY':
      return 'expire';
    case 'LOCK_HOLDING':
      return 'hold';
    default:
      return 'credit';
  }
}

/** 401 Unauthorized for OTP failures (source returned HTTP 401 here). */
class UnauthorizedOtp extends HttpException {
  constructor(message: string) {
    super(message, 401);
  }
}
