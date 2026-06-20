import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, KycFieldKey, KycDocumentType, KycFieldSource } from '@prisma/client';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { KYC_FIELD_KEYS, BridgeResult } from './kyc-verification.helper';
import { evaluateSubmission } from './kyc-verification.helper';
import {
  generateKycReviewDumpExcel,
  KycReviewDumpEntry,
  KycReviewDumpFieldState,
} from './kyc-review-dump';
import {
  parseKycApprovalSheet,
  KycVerifyUpdate,
  KycVerifyParseResult,
} from './kyc-bulk-verify';
import {
  ConsentKycDto,
  CreateKycDto,
  FirstApproveKycDto,
  GstDetailsDto,
  ListKycQueryDto,
  NotInterestedKycDto,
  RejectKycDto,
  ReKycDto,
  UpdateKycDto,
  UploadKycDocumentDto,
  VerifyKycFieldDto,
} from './dto/kyc.dto';
import {
  canFirstApprove,
  nextStatusAfterFirstApprove,
  statusForApproverCode,
} from './kyc-approval.helper';

// ─── KycFieldKey → ReKYCFlags map (reconcile §6 SHOULD-FIX #3) ──────────────
// Proposed map from the spec; drives which boolean flags are set on the
// primary outlet's reKycFlags when a field is REJECTED on bulk commit.
const KYC_FIELD_TO_REKYCFLAGS: Record<KycFieldKey, string[]> = {
  PAYMENT: ['bankName', 'accountHolderName', 'accountNumber', 'ifscCode', 'upiId', 'cancelledCheque'],
  GST_VALIDATION: ['gstNumber', 'panNumber'],
  GST_DOCUMENT: ['gstCertificate'],
  ADDRESS: ['streetAddress', 'city', 'state', 'pincode'],
  ADDRESS_DOCUMENT: ['addressProof', 'selfDeclaration'],
  BOARD_PHOTO: ['storeBoardPhoto'],
  OWNER_PHOTO: ['ownerPhoto'],
};

/** Outcome for a single submission in a bulk-verify commit. */
export interface BulkVerifySubmissionResult {
  submissionId: string;
  outcome: 'approved' | 'reupload' | 'recorded' | 'skipped' | 'error';
  detail?: string;
}

export interface BulkVerifyResult {
  committed: boolean;
  results: BulkVerifySubmissionResult[];
  errors: KycVerifyParseResult['errors'];
  summary: {
    rowsParsed: number;
    fieldsSet: number;
    parseErrors: number;
    approved: number;
    reupload: number;
    recorded: number;
    skipped: number;
    commitErrors: number;
  };
}

export interface BulkVerifyDryRunResult {
  committed: false;
  updates: KycVerifyUpdate[];
  errors: KycVerifyParseResult['errors'];
  summary: KycVerifyParseResult['summary'];
}

/**
 * A notification to enqueue AFTER a per-submission commit tx resolves (audit B1):
 * NotificationsService.enqueue writes via its own (base) Prisma client, NOT the tx,
 * so enqueuing inside the tx would persist independently and could outlive a
 * rolled-back approval. We carry the intent out and enqueue post-commit.
 */
interface CommitNotifyIntent {
  userId: string;
  event: string;
  body: string;
  variables: Record<string, unknown>;
  phone?: string;
}

type CommitOutcome = BulkVerifySubmissionResult & { notification?: CommitNotifyIntent };

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
    if (!file.buffer?.length) throw new BadRequestException('Empty file');

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

  /**
   * Tenant filter for KYC submission lookups (gap #38 / VERIFICATION-PROTOCOL §72).
   * The GIFSY_ADMIN is the cross-tenant platform operator: final KYC approval + bulk
   * validation act on ANY tenant's records, so they are EXEMPT from the caller-tenant
   * filter (the record is scoped by its OWN tenant instead). Every other role —
   * including CLIENT_ADMIN — stays hard-scoped to its own clientId. Returns a
   * spreadable where-fragment so callers write `{ id, ...this.kycTenantFilter(user) }`.
   * Owner decision: Gifsy sees all tenants (DATA-VISIBILITY §3.1).
   */
  private kycTenantFilter(user: JwtPayload): Prisma.KycSubmissionWhereInput {
    return user.role === 'GIFSY_ADMIN' ? {} : { user: { clientId: user.clientId } };
  }

  /**
   * Task 3.4e — DPDP read-masking.
   * When `mask` is true, replaces bank account number, PAN, and GST number with
   * "****<last4>" on the partner object. Full values are never stored differently —
   * the mask is applied at the response layer only.
   * Privileged callers (GIFSY_ADMIN / CLIENT_ADMIN) receive the unmasked values.
   */
  private maskPartnerSensitiveFields<T extends Record<string, unknown>>(partner: T, mask: boolean): T {
    if (!mask) return partner;
    const last4 = (v: unknown): string | null => {
      if (typeof v !== 'string' || v.length === 0) return v as string | null;
      return v.length <= 4 ? `****` : `****${v.slice(-4)}`;
    };
    return {
      ...partner,
      bankAccountNumber: last4(partner.bankAccountNumber),
      panNumber: last4(partner.panNumber),
      gstNumber: last4(partner.gstNumber),
    };
  }

  /**
   * Resolves the initial KYC status and escalation note by walking the real
   * SalesUser reporting tree upward from the submitter's record.
   *
   * Algorithm:
   *   1. Find the submitter's SalesUser (tenant-scoped, not soft-deleted).
   *      If none (non-sales role: GIFSY_ADMIN, RETAILER, etc.) → SUBMITTED, null.
   *   2. Walk reportingToId upward (max 10 hops, cycle-safe). Skip any manager
   *      that is inactive (isActive=false) OR soft-deleted (deletedAt != null).
   *   3. The first ACTIVE manager found → map their hierarchyLevel.code to a
   *      KycStatus via statusForApproverCode (SO→PENDING_SO, ASM→PENDING_ASM,
   *      RSM/ZNM/NSM→PENDING_RSM).
   *   4. escalatedFrom: if one or more intermediate managers were skipped, set it
   *      to the FIRST skipped level code (matches legacy detectEscalation intent).
   *   5. Fallback when no active manager found up the entire chain:
   *      PENDING_RSM_APPROVAL (routes to the top of the known bucket rather than
   *      silently dropping the submission into SUBMITTED). escalatedFrom is set to
   *      the first skipped level code if any skips occurred, else null.
   *
   * Every Prisma query is scoped to `user.clientId` to prevent cross-tenant reads.
   * The walk is bounded to MAX_HOPS to avoid infinite loops on cyclic data.
   */
  private async resolveInitialRouting(
    user: JwtPayload,
  ): Promise<{ status: string; escalatedFrom: string | null }> {
    const MAX_HOPS = 10;

    // Step 1: find the submitter's own SalesUser.
    const submitterSalesUser = await this.prisma.salesUser.findFirst({
      where: {
        userId: user.sub,
        clientId: user.clientId,
        deletedAt: null,
      },
      select: {
        id: true,
        reportingToId: true,
      },
    });

    // Non-sales submitter (GIFSY_ADMIN, RETAILER, etc.) → plain SUBMITTED.
    if (!submitterSalesUser) {
      return { status: 'SUBMITTED', escalatedFrom: null };
    }

    // Step 2–4: walk the reporting chain upward.
    let currentId: string | null = submitterSalesUser.reportingToId;
    let firstSkippedCode: string | null = null;
    let hops = 0;
    const visitedIds = new Set<string>();

    while (currentId && hops < MAX_HOPS) {
      if (visitedIds.has(currentId)) break; // cycle guard
      visitedIds.add(currentId);
      hops++;

      const manager = await this.prisma.salesUser.findFirst({
        where: {
          id: currentId,
          clientId: user.clientId,
        },
        select: {
          id: true,
          isActive: true,
          deletedAt: true,
          reportingToId: true,
          hierarchyLevel: { select: { code: true } },
        },
      });

      if (!manager) break; // dangling reference — stop walking

      const isInactive = !manager.isActive || manager.deletedAt != null;

      if (isInactive) {
        // Record the first skipped level for the escalation note.
        if (firstSkippedCode === null) {
          firstSkippedCode = manager.hierarchyLevel.code;
        }
        currentId = manager.reportingToId;
        continue;
      }

      // Active manager found — resolve status.
      const status = statusForApproverCode(manager.hierarchyLevel.code);
      return { status, escalatedFrom: firstSkippedCode };
    }

    // Step 5: no active manager found up the chain → escalate to RSM bucket.
    return { status: 'PENDING_RSM_APPROVAL', escalatedFrom: firstSkippedCode };
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

    // 4. Escalation routing — DB-backed via the real SalesUser reporting tree.
    const { status, escalatedFrom } = await this.resolveInitialRouting(user);

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

        let fileUrl: string;
        let fileKey: string;
        if (doc.fileKey) {
          // A GCS object reference — accept ONLY keys this tenant owns (the upload
          // endpoint always tenant-folders as kyc/<clientId>/…). Reconstruct the URL
          // from the validated key; never trust a client-supplied fileUrl (a foreign
          // key would otherwise be signed into another tenant's doc at review time).
          if (!doc.fileKey.startsWith(`kyc/${user.clientId}/`)) {
            throw new BadRequestException('Invalid document reference');
          }
          fileKey = doc.fileKey;
          fileUrl = this.storage.publicUrl(fileKey);
        } else if (doc.dataUrl) {
          // Legacy inline base64 fallback.
          fileUrl = doc.dataUrl;
          fileKey = `kyc/${submission.id}/${doc.type}/${Date.now()}`;
        } else {
          fileUrl = `pending://kyc/${submission.id}/${doc.type}`;
          fileKey = `kyc/${submission.id}/${doc.type}/${Date.now()}`;
        }

        docPromises.push(
          this.prisma.kycDocument.create({
            data: {
              kycSubmissionId: submission.id,
              documentType: doc.type as KycDocumentType,
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

    const where: Prisma.KycSubmissionWhereInput = { ...this.kycTenantFilter(user) };

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
        ? { ...this.kycTenantFilter(user) }
        : { userId: user.sub, ...this.kycTenantFilter(user) },
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
    // Tenant-scoped fetch. getOne is already leak-safe: the owner/admin guard
    // below (`!isAdmin && submission.userId !== user.sub → Forbidden`) restricts
    // every non-admin caller to their OWN submission, so A4 leaves getOne as-is.
    // (ledger lacked that post-fetch guard — that is the one A4 fixes.)
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, ...this.kycTenantFilter(user) },
      include: {
        documents: true,
        statusHistory: { orderBy: { createdAt: 'desc' } },
        user: { select: { id: true, name: true, phone: true, role: true } },
        partner: true,
        // 3.4d: the detail-page field panel seeds its current state from these.
        verificationItems: {
          select: { fieldKey: true, decision: true, remark: true, source: true, verifiedAt: true },
        },
      },
    });

    if (!submission) throw new NotFoundException('KYC submission not found');

    // Partners may only view their OWN submission. Admins, MIS, and SALES reviewers
    // get tenant-wide read — sales work the tenant approval queue by stage (see
    // list(); owner decision 2026-06-19: "sales team can review"). Cross-tenant is
    // already prevented by kycTenantFilter on the fetch above; sensitive PII is
    // still masked below for any non-admin non-owner (a sales reviewer sees PAN/
    // bank as last-4).
    const PARTNER_ROLES = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];
    if (PARTNER_ROLES.includes(user.role) && submission.userId !== user.sub) {
      throw new ForbiddenException('Forbidden');
    }

    // ── Task 3.4e: DPDP read-masking ─────────────────────────────────────────
    // Mask sensitive fields (bank account, PAN, GST → last 4) for non-admin callers
    // who are NOT the submission owner. Admins and the owner (who entered the data)
    // see full values. NB: today a non-admin non-owner is already 403'd above, so this
    // is defensive cover for any future read access (e.g. sales approvers viewing a
    // submission). TODO: switch the privileged check to the `kyc:view_documents`
    // permission once the RBAC flag-gate is enforced (currently role-based).
    const masked = !this.isAdmin(user.role) && submission.userId !== user.sub;
    const partner = submission.partner
      ? this.maskPartnerSensitiveFields(submission.partner, masked)
      : null;

    return { submission: { ...submission, partner } };
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
      where: { id, ...this.kycTenantFilter(user) },
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
      where: { id, ...this.kycTenantFilter(user) },
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
  /**
   * Convenience "approve all" — approves all still-PENDING verification items,
   * then evaluates via the bridge (§5 locked decision).
   *
   * - If bridge → APPROVED: calls applyBridgeOutcome (activate + wallet + history + audit).
   * - If bridge → RE_UPLOAD_REQUIRED: some field was already REJECTED by a prior portal
   *   verify call → ConflictException (lists rejected fields). Entire tx rolls back; no mutation.
   * - If bridge → PENDING_GIFSY: impossible when we just set all pending items to APPROVED
   *   (the only way this stays PENDING is if < 7 items exist, which can't happen after
   *   the approve-all upsert writes all 7) — guarded defensively.
   *
   * B1: notification enqueued AFTER the tx resolves.
   * S1: RE_UPLOAD case is a ConflictException (never reaches applyBridgeOutcome's outlet check).
   */
  async approve(user: JwtPayload, id: string) {
    // GIFSY-only is enforced by @Roles on the controller; re-checked logically here.
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden — Gifsy Admin only');

    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, ...this.kycTenantFilter(user) },
      include: {
        user: true,
        partner: {
          include: {
            outlets: {
              where: { isPrimary: true, deletedAt: null },
              take: 1,
            },
          },
        },
      },
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

    const now = new Date();

    const notifyIntent = await this.prisma.$transaction(async (tx) => {
      // ── (a) Re-assert PENDING_GIFSY + tenant inside the tx ────────────────
      const sub = await tx.kycSubmission.findFirst({
        where: { id, status: 'PENDING_GIFSY', ...this.kycTenantFilter(user) },
        include: {
          user: true,
          partner: {
            include: {
              outlets: {
                where: { isPrimary: true, deletedAt: null },
                take: 1,
              },
            },
          },
        },
      });
      if (!sub) {
        // Raced — already moved or tenant mismatch.
        throw new ConflictException('Submission is no longer PENDING_GIFSY');
      }

      // ── (b) Approve all still-PENDING verification items (do NOT touch REJECTED) ──
      //
      // We cannot use a single upsert because Prisma's upsert.update block runs
      // unconditionally and would overwrite already-REJECTED items. Instead:
      //   Step 1: updateMany(where decision=PENDING) → APPROVED for existing rows.
      //   Step 2: For fields that have NO row yet, create them as APPROVED.
      //           (Load existing field keys first so we know which are missing.)
      const existingItems = await tx.kycVerificationItem.findMany({
        where: { kycSubmissionId: id },
        select: { fieldKey: true, decision: true },
      });
      const existingByKey = new Map(existingItems.map((it) => [it.fieldKey, it.decision]));

      // Step 1: flip all existing PENDING rows to APPROVED (leave REJECTED alone).
      await tx.kycVerificationItem.updateMany({
        where: {
          kycSubmissionId: id,
          decision: 'PENDING',
        },
        data: {
          decision: 'APPROVED',
          source: 'PORTAL',
          verifiedById: user.sub,
          verifiedAt: now,
        },
      });

      // Step 2: create rows for any of the 7 fields that have no row yet.
      const missingKeys = KYC_FIELD_KEYS.filter((k) => !existingByKey.has(k));
      if (missingKeys.length > 0) {
        await tx.kycVerificationItem.createMany({
          data: missingKeys.map((fieldKey) => ({
            kycSubmissionId: id,
            fieldKey,
            decision: 'APPROVED' as const,
            source: 'PORTAL' as const,
            verifiedById: user.sub,
            verifiedAt: now,
          })),
          skipDuplicates: true,
        });
      }

      // ── (c) Load all 7 items → bridge ─────────────────────────────────────
      const allItems = await tx.kycVerificationItem.findMany({
        where: { kycSubmissionId: id },
        select: { fieldKey: true, decision: true },
      });
      const bridgeResult = evaluateSubmission(allItems);

      // ── (d) Conflict check: any already-REJECTED field blocks a blanket approve ─
      if (bridgeResult.next === 'RE_UPLOAD_REQUIRED') {
        throw new ConflictException(
          `Cannot approve: fields [${bridgeResult.rejectedFields.join(', ')}] are rejected — resolve them first`,
        );
      }

      // ── (e) Apply side-effects via shared helper ──────────────────────────
      const applied = await this.applyBridgeOutcome(tx, sub, bridgeResult, 'PORTAL', user.sub, now);
      return applied.notification ?? null;
    });

    // B1: enqueue AFTER the tx commits (never inside the tx).
    if (notifyIntent) {
      await this.notify(
        notifyIntent.userId,
        notifyIntent.event,
        notifyIntent.body,
        notifyIntent.variables,
        notifyIntent.phone,
      );
    }

    return { message: 'KYC approved successfully' };
  }

  // ─── POST /v1/kyc/:id/verify ─────────────────────────────────────────────────
  /**
   * Field-level portal verification (Lane B) — Gifsy-only, #14.
   *
   * Approves or rejects a single field of a PENDING_GIFSY submission. After each
   * field action, runs the bridge and — if all 7 are now terminal — commits the
   * appropriate side-effects (APPROVED: activate + wallet; RE_UPLOAD: reKycFlags).
   *
   * B1: notification enqueued AFTER the tx.
   * S1: RE_UPLOAD outlet-before-flip throw inside applyBridgeOutcome.
   */
  async verifyField(user: JwtPayload, id: string, dto: VerifyKycFieldDto) {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden — Gifsy Admin only');

    const now = new Date();
    const { fieldKey, decision, remark } = dto;

    // Defense-in-depth (audit NIT): the DTO @ValidateIf already requires a remark on
    // REJECT, but re-assert here so any future non-HTTP caller can't store a
    // remark-less rejection (which would also break the dump round-trip).
    if (decision === 'REJECTED' && !remark?.trim()) {
      throw new BadRequestException('A remark is required when rejecting a field');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // ── (a) Re-assert PENDING_GIFSY + tenant ──────────────────────────────
      const submission = await tx.kycSubmission.findFirst({
        where: { id, status: 'PENDING_GIFSY', ...this.kycTenantFilter(user) },
        include: {
          user: true,
          partner: {
            include: {
              outlets: {
                where: { isPrimary: true, deletedAt: null },
                take: 1,
              },
            },
          },
        },
      });
      if (!submission) {
        throw new NotFoundException(
          'KYC submission not found, not PENDING_GIFSY, or does not belong to this tenant',
        );
      }

      // ── (b) Upsert the ONE field being verified ───────────────────────────
      await tx.kycVerificationItem.upsert({
        where: {
          kycSubmissionId_fieldKey: { kycSubmissionId: id, fieldKey },
        },
        create: {
          kycSubmissionId: id,
          fieldKey,
          decision,
          source: 'PORTAL',
          remark: remark ?? null,
          verifiedById: user.sub,
          verifiedAt: now,
        },
        update: {
          decision,
          source: 'PORTAL',
          remark: remark ?? null,
          verifiedById: user.sub,
          verifiedAt: now,
        },
      });

      // ── (c) Load all 7 items → bridge ─────────────────────────────────────
      const allItems = await tx.kycVerificationItem.findMany({
        where: { kycSubmissionId: id },
        select: { fieldKey: true, decision: true },
      });
      const bridgeResult = evaluateSubmission(allItems);

      // ── (d) Apply bridge outcome (only fires if all 7 are terminal) ───────
      let applied: { outcome: 'approved' | 'reupload' | 'recorded' | 'skipped'; notification?: CommitNotifyIntent } = { outcome: 'recorded' };
      if (bridgeResult.next !== 'PENDING_GIFSY') {
        applied = await this.applyBridgeOutcome(tx, submission, bridgeResult, 'PORTAL', user.sub, now);
      }

      return {
        submissionId: id,
        fieldKey,
        decision,
        bridgeResult,
        applied,
      };
    });

    // B1: enqueue AFTER the tx commits.
    if (result.applied.notification) {
      const n = result.applied.notification;
      await this.notify(n.userId, n.event, n.body, n.variables, n.phone);
    }

    return {
      submissionId: result.submissionId,
      fieldKey: result.fieldKey,
      fieldDecision: result.decision,
      derivedStatus: result.bridgeResult.next,
      approvedCount: result.bridgeResult.approvedCount,
      rejectedFields: result.bridgeResult.rejectedFields,
      outcome: result.applied.outcome,
    };
  }

  // ─── POST /v1/kyc/:id/reject ─────────────────────────────────────────────────
  async reject(user: JwtPayload, id: string, dto: RejectKycDto) {
    const { reason, requiredAction } = dto;
    const status = dto.status ?? 'REJECTED';

    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, ...this.kycTenantFilter(user) },
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
    // Intra-tenant read leak fix: a partner could read ANY submission's wallet
    // ledger in their tenant (PII). Restrict partner callers to their own
    // submission; admins + sales stay tenant-wide (mirrors list()).
    const PARTNER_ROLES = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'];
    const where: Prisma.KycSubmissionWhereInput = { id, ...this.kycTenantFilter(user) };
    if (PARTNER_ROLES.includes(user.role)) where.userId = user.sub; // a partner may only read their own KYC

    const submission = await this.prisma.kycSubmission.findFirst({
      where,
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
    const verifiedAt = new Date();
    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { verifiedAt },
    });

    // Verify the submission belongs to this user (tenant-scoped for consistency
    // with the rest of the service — userId alone is already single-tenant).
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id: submissionId, userId: user.sub, user: { clientId: user.clientId } },
    });
    if (!submission) throw new NotFoundException('KYC submission not found');

    // ── Task 3.5: Write a durable ConsentRecord on successful OTP verification ─
    // Idempotency note: if consent() is called twice for the same submission we
    // write a second ConsentRecord (each has its own OTP cycle so this is valid
    // auditable proof). The schema allows multiple records per submission (no
    // unique constraint on kycSubmissionId alone).
    await this.prisma.consentRecord.create({
      data: {
        userId: user.sub,
        kycSubmissionId: submissionId,
        consentType: 'KYC_TERMS',
        consentText: `KYC Terms & Conditions v${process.env.KYC_TERMS_VERSION ?? '1.0'}`,
        version: process.env.KYC_TERMS_VERSION ?? '1.0',
        consentedAt: verifiedAt,
        // ipAddress / deviceInfo: not available on this path — left null (DPDP §3.2)
      },
    });

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
      // A1 cross-tenant filter: GIFSY → {} (aggregate over all tenants), else
      // clientId-scoped — consistent with list()/getOne(). Filtering by the raw
      // user.clientId made a GIFSY operator see only their empty `gifsy` tenant.
      where: { status: 'APPROVED', ...this.kycTenantFilter(user) },
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
        ...this.kycTenantFilter(user),
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
      where: { status: 'RE_UPLOAD_REQUIRED', ...this.kycTenantFilter(user) },
    });
    const totalCount = await this.prisma.kycSubmission.count({
      where: { ...this.kycTenantFilter(user) },
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

  // ─── POST /v1/kyc/:id/re-kyc ─────────────────────────────────────────────────
  /**
   * Task 3.6 — Manual re-KYC trigger (Gifsy-only).
   *
   * Transitions an APPROVED submission to RE_KYC_REQUIRED and optionally sets
   * the reKycFlags on the primary outlet for the specified fieldKeys.
   *
   * B1: notification enqueued AFTER the tx.
   * S1: if fieldKeys are supplied but no primary outlet exists, throws inside the tx
   *     → full rollback, no half-commit.
   *
   * Permission: @Roles('GIFSY_ADMIN') + @RequirePermission('kyc:gifsy_approve').
   * Closest existing perm is kyc:gifsy_approve (the Gifsy-side approve action);
   * re-KYC is likewise a Gifsy-only workflow gate so it reuses the same perm.
   */
  async reKyc(user: JwtPayload, id: string, dto: ReKycDto) {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden — Gifsy Admin only');

    const { reason, fieldKeys } = dto;
    const now = new Date();

    const notifyIntent = await this.prisma.$transaction(async (tx) => {
      // Load and tenant-scope the submission.
      const submission = await tx.kycSubmission.findFirst({
        where: { id, ...this.kycTenantFilter(user) },
        include: {
          user: { select: { id: true, name: true, phone: true } },
          partner: {
            include: {
              outlets: {
                where: { isPrimary: true, deletedAt: null },
                take: 1,
                select: { id: true, reKycFlags: true },
              },
            },
          },
        },
      });

      if (!submission) throw new NotFoundException('KYC submission not found');

      // Only an APPROVED KYC can be sent back for re-KYC.
      if (submission.status !== 'APPROVED') {
        throw new ConflictException(
          `Re-KYC can only be triggered on an APPROVED submission (current status: "${submission.status}")`,
        );
      }

      // S1: if fieldKeys given, we must have a primary outlet to write reKycFlags.
      const primaryOutlet = submission.partner?.outlets[0] ?? null;
      if (fieldKeys?.length && !primaryOutlet) {
        throw new Error(
          `No primary outlet found for submission ${id} — cannot set reKycFlags for fields: ${fieldKeys.join(', ')}`,
        );
      }

      // Flip status → RE_KYC_REQUIRED.
      await tx.kycSubmission.update({
        where: { id },
        data: { status: 'RE_KYC_REQUIRED' as never },
      });

      // Optionally set reKycFlags on the primary outlet.
      if (fieldKeys?.length && primaryOutlet) {
        const flagsUpdate: Record<string, boolean> = {};
        for (const fk of fieldKeys) {
          for (const flag of KYC_FIELD_TO_REKYCFLAGS[fk] ?? []) {
            flagsUpdate[flag] = true;
          }
        }
        const existing = (primaryOutlet.reKycFlags ?? {}) as Record<string, boolean>;
        const merged = { ...existing, ...flagsUpdate };
        await tx.outlet.update({
          where: { id: primaryOutlet.id },
          data: { reKycFlags: merged },
        });
      }

      // KycStatusHistory
      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: id,
          fromStatus: 'APPROVED' as never,
          toStatus: 'RE_KYC_REQUIRED' as never,
          changedByUserId: user.sub,
          notes: reason,
          metadata: { stage: 'GIFSY', fieldKeys: fieldKeys ?? null },
        },
      });

      // AuditLog
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'KYC_SUBMISSION',
          entityId: id,
          actorId: user.sub,
          oldValues: { status: 'APPROVED' },
          newValues: { status: 'RE_KYC_REQUIRED' },
          metadata: { reason, fieldKeys: fieldKeys ?? null, triggeredAt: now.toISOString() },
        },
      });

      // Return notification intent — enqueued post-tx (B1).
      return {
        userId: submission.userId,
        event: 'KYC_RE_KYC_REQUIRED',
        body: `Your KYC requires re-verification. Reason: ${reason}`,
        variables: {
          name: submission.user.name ?? submission.user.phone,
          reason,
          fieldKeys: fieldKeys?.join(', ') ?? '',
        },
        phone: submission.user.phone ?? undefined,
      };
    });

    // B1: enqueue AFTER the tx commits.
    await this.notify(
      notifyIntent.userId,
      notifyIntent.event,
      notifyIntent.body,
      notifyIntent.variables,
      notifyIntent.phone,
    );

    return {
      message: 'Re-KYC triggered successfully',
      submissionId: id,
      newStatus: 'RE_KYC_REQUIRED',
    };
  }

  // ─── POST /v1/kyc/:id/gst-details ────────────────────────────────────────────
  /**
   * Task 3.4e — Capture entityType + gstRegistrationType on the ChannelPartner.
   *
   * Gifsy-only endpoint. Sets the two enum fields on the submission's partner
   * (tenant-scoped). Optionally stores gstLegalName/gstStatus in the
   * KycVerificationItem.evidence JSON for the GST_VALIDATION field.
   *
   * P6 seam: lib/invoice will read partner.entityType + partner.gstRegistrationType
   * here to determine TDS applicability and invoice category. Do NOT build invoice
   * computation in this task — leave this comment as the integration point.
   */
  async gstDetails(user: JwtPayload, id: string, dto: GstDetailsDto) {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden — Gifsy Admin only');

    const { entityType, gstRegistrationType, gstLegalName, gstStatus } = dto;

    // Load submission — tenant-scoped.
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id, ...this.kycTenantFilter(user) },
      include: { partner: { select: { id: true, clientId: true } } },
    });

    if (!submission) throw new NotFoundException('KYC submission not found');
    if (!submission.partner) throw new NotFoundException('No ChannelPartner linked to this submission');

    // Persist entityType + gstRegistrationType on the partner.
    await this.prisma.channelPartner.update({
      where: { id: submission.partner.id },
      data: { entityType, gstRegistrationType },
    });

    // If gstLegalName or gstStatus supplied, store in KycVerificationItem.evidence
    // for GST_VALIDATION (upsert so this is safe to call before or after field verify).
    if (gstLegalName !== undefined || gstStatus !== undefined) {
      const evidenceUpdate: Record<string, string | undefined> = {};
      if (gstLegalName !== undefined) evidenceUpdate.legalName = gstLegalName;
      if (gstStatus !== undefined) evidenceUpdate.status = gstStatus;

      await this.prisma.kycVerificationItem.upsert({
        where: {
          kycSubmissionId_fieldKey: { kycSubmissionId: id, fieldKey: 'GST_VALIDATION' },
        },
        create: {
          kycSubmissionId: id,
          fieldKey: 'GST_VALIDATION',
          decision: 'PENDING',
          evidence: evidenceUpdate,
        },
        update: {
          evidence: evidenceUpdate,
        },
      });
    }

    return {
      message: 'GST details captured successfully',
      submissionId: id,
      partnerId: submission.partner.id,
      entityType,
      gstRegistrationType,
    };
  }

  // ─── POST /v1/kyc/bulk-verify ────────────────────────────────────────────────
  /**
   * Lane A bulk upload: parse an xlsx, dry-run preview OR commit field-level
   * verification for all PENDING_GIFSY submissions in this tenant.
   *
   * apply=false (default) → parse only; return { updates, errors, summary }; 0 DB writes.
   * apply=true            → per-submission $transaction (§6); return per-row outcomes.
   *
   * Gifsy-admin only.  Tenant-scoped: only PENDING_GIFSY submissions for this
   * clientId are valid; the parser rejects any other submission ID.
   *
   * Failure-mode handling (reconcile §6):
   *   - Idempotency: step (a) re-asserts PENDING_GIFSY; the flip is a conditional
   *     updateMany (count===0 → skip) so a concurrent re-upload can't double-fire.
   *   - Partial-batch: per-submission tx → one row erroring leaves others committed.
   *   - No sync external side-effect: all DB writes happen inside the tx; notifications
   *     are enqueued (a NotificationQueue row, delivery is P7); no external call.
   */
  async bulkVerify(
    user: JwtPayload,
    file: Express.Multer.File,
    apply: boolean,
  ): Promise<BulkVerifyResult | BulkVerifyDryRunResult> {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden — Gifsy Admin only');

    if (!file?.buffer?.length) throw new BadRequestException('No file uploaded or file is empty');

    // ── Parse the xlsx ────────────────────────────────────────────────────────
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new BadRequestException('Uploaded file has no sheets');
    const ws = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      defval: '',
      raw: false, // all values as strings
    });

    // ── Load this tenant's valid PENDING_GIFSY submission IDs ─────────────────
    const pendingSubmissions = await this.prisma.kycSubmission.findMany({
      where: { status: 'PENDING_GIFSY', ...this.kycTenantFilter(user) },
      select: { id: true },
    });
    const validIds = new Set(pendingSubmissions.map((s) => s.id));

    const parseResult = parseKycApprovalSheet(rawRows, validIds);

    // ── Dry-run: no DB writes ─────────────────────────────────────────────────
    if (!apply) {
      return {
        committed: false,
        updates: parseResult.updates,
        errors: parseResult.errors,
        summary: parseResult.summary,
      };
    }

    // ── Commit: per-submission transactions ───────────────────────────────────
    const results: BulkVerifySubmissionResult[] = [];
    const now = new Date();
    let approved = 0;
    let reupload = 0;
    let recorded = 0;
    let skipped = 0;
    let commitErrors = 0;

    for (const update of parseResult.updates) {
      const { submissionId, fields } = update;
      try {
        const outcome = await this.commitSubmissionVerification(user, submissionId, fields, now);
        results.push({ submissionId, outcome: outcome.outcome, detail: outcome.detail });
        // Enqueue notifications ONLY after the tx has committed (audit B1) — a row
        // that threw never returns a notification, so a rolled-back approval can't notify.
        if (outcome.notification) {
          const n = outcome.notification;
          await this.notify(n.userId, n.event, n.body, n.variables, n.phone);
        }
        if (outcome.outcome === 'approved') approved++;
        else if (outcome.outcome === 'reupload') reupload++;
        else if (outcome.outcome === 'recorded') recorded++;
        else if (outcome.outcome === 'skipped') skipped++;
      } catch (err: unknown) {
        commitErrors++;
        results.push({
          submissionId,
          outcome: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      committed: true,
      results,
      errors: parseResult.errors,
      summary: {
        rowsParsed: parseResult.summary.rowsParsed,
        fieldsSet: parseResult.summary.fieldsSet,
        parseErrors: parseResult.summary.errors,
        approved,
        reupload,
        recorded,
        skipped,
        commitErrors,
      },
    };
  }

  // ─── Shared bridge side-effect applier (Lane A + Lane B) ────────────────────
  /**
   * Apply the side-effects corresponding to a bridge outcome inside an already-open
   * transaction. Called by BOTH Lane A (bulk commit) and Lane B (portal single-record
   * verify + approve) so the two paths can never diverge (reconcile §5 DRY rule).
   *
   * Guarantees:
   *   B1 — does NOT enqueue notifications; returns a CommitNotifyIntent that the
   *        caller enqueues AFTER the tx commits. A rolled-back tx never notifies.
   *   S1 — for RE_UPLOAD_REQUIRED, resolves the primary outlet BEFORE the status flip
   *        and throws if none, rolling back the entire tx (no half-commit).
   *
   * @param tx         The open Prisma interactive-transaction client.
   * @param submission The full submission row (with user + partner.outlets[0]).
   * @param bridgeResult  Result from evaluateSubmission.
   * @param source     'EXCEL' (bulk) or 'PORTAL' (single-record) — written to audit.
   * @param actorId    The acting admin's user ID.
   * @param now        Timestamp for approvedAt / verifiedAt fields.
   * @returns { outcome, notification? } — the notification intent is absent for PENDING_GIFSY.
   */
  private async applyBridgeOutcome(
    tx: Prisma.TransactionClient,
    submission: {
      id: string;
      userId: string;
      partnerId: string | null;
      user: { name: string | null; phone: string | null };
      partner: { outlets: Array<{ id: string; reKycFlags: Prisma.JsonValue | null }> } | null;
    },
    bridgeResult: BridgeResult,
    source: KycFieldSource,
    actorId: string,
    now: Date,
  ): Promise<{ outcome: 'approved' | 'reupload' | 'recorded' | 'skipped'; notification?: CommitNotifyIntent }> {
    const submissionId = submission.id;
    const sourceLabel = source === 'EXCEL' ? 'EXCEL_BULK' : 'PORTAL';

    if (bridgeResult.next === 'APPROVED') {
      // Conditional flip — race hardening (§6 NIT #5): only one concurrent writer
      // can win; count===0 means we lost the race → skip side-effects.
      const { count } = await tx.kycSubmission.updateMany({
        where: { id: submissionId, status: 'PENDING_GIFSY' },
        data: { status: 'APPROVED', approvedAt: now },
      });
      if (count === 0) {
        return { outcome: 'skipped' };
      }

      // Activate the user.
      await tx.user.update({
        where: { id: submission.userId },
        data: { status: 'ACTIVE' },
      });

      // Create wallet if not exists.
      if (submission.partnerId) {
        const existingWallet = await tx.wallet.findFirst({
          where: { partnerId: submission.partnerId },
        });
        if (!existingWallet) {
          await tx.wallet.create({ data: { partnerId: submission.partnerId } });
        }
      }

      // Audit + history.
      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: submissionId,
          fromStatus: 'PENDING_GIFSY',
          toStatus: 'APPROVED',
          changedByUserId: actorId,
          notes:
            source === 'EXCEL'
              ? 'Bulk Excel approval — all 7 fields APPROVED'
              : 'Portal single-record approval — all 7 fields APPROVED',
          metadata: { stage: 'GIFSY', source: sourceLabel },
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'APPROVE',
          entityType: 'KYC_SUBMISSION',
          entityId: submissionId,
          actorId,
          oldValues: { status: 'PENDING_GIFSY' },
          newValues: { status: 'APPROVED' },
          metadata: { stage: 'GIFSY', source: sourceLabel, submissionId, userId: submission.userId },
        },
      });

      // Return the notification intent — the caller enqueues it AFTER the tx commits
      // (audit B1: enqueuing here would persist on a separate connection and could
      // survive a rolled-back approval).
      return {
        outcome: 'approved',
        notification: {
          userId: submission.userId,
          event: 'KYC_APPROVED',
          body: 'Your KYC has been approved.',
          variables: { name: submission.user.name ?? submission.user.phone },
          phone: submission.user.phone ?? undefined,
        },
      };
    }

    if (bridgeResult.next === 'RE_UPLOAD_REQUIRED') {
      // Resolve the primary outlet FIRST — we must set reKycFlags, so if there is no
      // outlet we THROW (rolling back the whole tx) rather than flip status without the
      // flags that tell the partner what to fix (audit S1: no half-commit). The caller
      // counts the thrown row as 'error' and the status is never mutated.
      const primaryOutlet = submission.partner?.outlets[0] ?? null;
      if (!primaryOutlet) {
        throw new Error(
          `No primary outlet for submission ${submissionId} — cannot set reKycFlags ` +
            `(rejected: ${bridgeResult.rejectedFields.join(', ')})`,
        );
      }

      // Conditional flip — race hardening; count===0 means a concurrent writer won.
      const { count } = await tx.kycSubmission.updateMany({
        where: { id: submissionId, status: 'PENDING_GIFSY' },
        data: { status: 'RE_UPLOAD_REQUIRED' },
      });
      if (count === 0) {
        return { outcome: 'skipped' };
      }

      // Build the reKycFlags update: set all booleans for the rejected fields.
      const flagsUpdate: Record<string, boolean> = {};
      for (const rejectedField of bridgeResult.rejectedFields) {
        for (const flag of KYC_FIELD_TO_REKYCFLAGS[rejectedField] ?? []) {
          flagsUpdate[flag] = true;
        }
      }

      // Merge into existing reKycFlags (if any) — last-write-wins per flag.
      const existing = (primaryOutlet.reKycFlags ?? {}) as Record<string, boolean>;
      const merged: Prisma.InputJsonValue = { ...existing, ...flagsUpdate };

      await tx.outlet.update({
        where: { id: primaryOutlet.id },
        data: { reKycFlags: merged },
      });

      // Audit + history.
      await tx.kycStatusHistory.create({
        data: {
          kycSubmissionId: submissionId,
          fromStatus: 'PENDING_GIFSY',
          toStatus: 'RE_UPLOAD_REQUIRED',
          changedByUserId: actorId,
          notes: `${source === 'EXCEL' ? 'Bulk Excel' : 'Portal'} — rejected fields: ${bridgeResult.rejectedFields.join(', ')}`,
          metadata: {
            stage: 'GIFSY',
            source: sourceLabel,
            rejectedFields: bridgeResult.rejectedFields,
            outletId: primaryOutlet.id,
          },
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'REJECT',
          entityType: 'KYC_SUBMISSION',
          entityId: submissionId,
          actorId,
          oldValues: { status: 'PENDING_GIFSY' },
          newValues: { status: 'RE_UPLOAD_REQUIRED' },
          metadata: {
            stage: 'GIFSY',
            source: sourceLabel,
            rejectedFields: bridgeResult.rejectedFields,
            outletId: primaryOutlet.id,
          },
        },
      });

      // Notification intent — enqueued post-commit by the caller (audit B1).
      // TODO(P3.6): also notify the assigned sales owner (SalesUserAssignment lookup);
      // for now the partner (submission.userId) is told what to re-upload.
      return {
        outcome: 'reupload',
        notification: {
          userId: submission.userId,
          event: 'KYC_RE_UPLOAD_REQUIRED',
          body: `Your KYC requires re-upload for: ${bridgeResult.rejectedFields.join(', ')}`,
          variables: {
            name: submission.user.name ?? submission.user.phone,
            rejectedFields: bridgeResult.rejectedFields.join(', '),
          },
          phone: submission.user.phone ?? undefined,
        },
      };
    }

    // PENDING_GIFSY — partial progress recorded, no status change.
    return { outcome: 'recorded' };
  }

  /**
   * Commit one submission's field updates inside its own transaction.
   * Per §6: re-assert PENDING_GIFSY, upsert items, evaluate, branch.
   *
   * Returns the per-submission outcome.  Throws on unrecoverable DB error
   * so the caller can count it as 'error' without halting the batch.
   */
  private async commitSubmissionVerification(
    user: JwtPayload,
    submissionId: string,
    fields: KycVerifyUpdate['fields'],
    now: Date,
  ): Promise<CommitOutcome> {
    return this.prisma.$transaction(async (tx) => {
      // ── (a) Re-load + re-assert PENDING_GIFSY (idempotency guard) ─────────
      const submission = await tx.kycSubmission.findFirst({
        where: {
          id: submissionId,
          status: 'PENDING_GIFSY',
          ...this.kycTenantFilter(user),
        },
        include: {
          user: true,
          partner: {
            include: {
              outlets: {
                where: { isPrimary: true, deletedAt: null },
                take: 1,
              },
            },
          },
        },
      });

      // Not PENDING_GIFSY or not in this tenant → skip (idempotent)
      if (!submission) {
        return {
          submissionId,
          outcome: 'skipped' as const,
          detail: 'Submission is no longer PENDING_GIFSY or does not belong to this tenant',
        };
      }

      // ── (b) Upsert KycVerificationItem rows for fields in this update ────
      for (const [rawKey, fieldUpdate] of Object.entries(fields)) {
        const fieldKey = rawKey as KycFieldKey;
        if (!fieldUpdate) continue;
        await tx.kycVerificationItem.upsert({
          where: {
            kycSubmissionId_fieldKey: {
              kycSubmissionId: submissionId,
              fieldKey,
            },
          },
          create: {
            kycSubmissionId: submissionId,
            fieldKey,
            decision: fieldUpdate.decision,
            source: 'EXCEL',
            remark: fieldUpdate.remark ?? null,
            verifiedById: user.sub,
            verifiedAt: now,
          },
          update: {
            decision: fieldUpdate.decision,
            source: 'EXCEL',
            remark: fieldUpdate.remark ?? null,
            verifiedById: user.sub,
            verifiedAt: now,
          },
        });
      }

      // ── (c) Load all 7 items → bridge ─────────────────────────────────────
      const allItems = await tx.kycVerificationItem.findMany({
        where: { kycSubmissionId: submissionId },
        select: { fieldKey: true, decision: true },
      });

      const bridgeResult = evaluateSubmission(allItems);

      // ── (d) Branch on bridge outcome via shared applyBridgeOutcome ────────
      const applied = await this.applyBridgeOutcome(tx, submission, bridgeResult, 'EXCEL', user.sub, now);
      return { submissionId, ...applied };
    });
  }

  // ─── GET /v1/kyc/review-queue ────────────────────────────────────────────────
  /**
   * Returns all PENDING_GIFSY submissions for this tenant with their 7-field
   * verification state (decision + remark + source per field, defaulting missing
   * fields to PENDING). Used by the approvals UI to show queue items with n/7
   * progress dots and per-field status without a detail fetch per row.
   *
   * Reuses the same query shape as reviewDump (primary outlet + partner identity)
   * and the dumpFieldStates helper so the two paths stay in sync.
   */
  async reviewQueue(user: JwtPayload) {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden — Gifsy Admin only');

    const submissions = await this.prisma.kycSubmission.findMany({
      where: { status: 'PENDING_GIFSY', ...this.kycTenantFilter(user) },
      include: {
        // clientId = the record's own tenant — surfaced so the cross-tenant Gifsy
        // queue can label/filter each row by brand (gap #38).
        user: { select: { name: true, phone: true, clientId: true } },
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
        verificationItems: {
          select: { fieldKey: true, decision: true, remark: true, source: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const entries = submissions.map((s) => {
      const p = s.partner;
      const o = p?.outlets[0];
      const holder = p?.bankAccountHolder?.trim().toLowerCase();
      const owner = p?.ownerName?.trim().toLowerCase();

      return {
        submissionId: s.id,
        clientId: s.user.clientId,
        outletCode: o?.outletCode ?? '',
        outletName: o?.name ?? p?.businessName ?? '',
        ownerName: p?.ownerName ?? '',
        mobile: p?.phone ?? s.user.phone ?? '',
        partnerClass: o?.outletType?.name ?? o?.programName ?? '',
        gstNumber: p?.gstNumber ?? '',
        panNumber: p?.panNumber ?? '',
        address: [o?.addressLine1, o?.addressLine2].filter(Boolean).join(', '),
        city: o?.city ?? '',
        state: o?.state ?? '',
        pincode: o?.pincode ?? '',
        paymentMode: p?.paymentMode ?? '',
        bankName: p?.bankName ?? null,
        accountHolderName: p?.bankAccountHolder ?? null,
        accountNumber: p?.bankAccountNumber ?? null,
        ifscCode: p?.ifscCode ?? null,
        upiId: p?.upiId ?? null,
        boardGeo:
          s.boardPhotoLat != null && s.boardPhotoLng != null
            ? { lat: Number(s.boardPhotoLat), lng: Number(s.boardPhotoLng) }
            : null,
        nameMismatch: !!(holder && owner && holder !== owner),
        fields: this.dumpFieldStates(s.verificationItems),
      };
    });

    return { entries };
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
      where: { status: 'PENDING_GIFSY', ...this.kycTenantFilter(user) },
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
          // Fail CLOSED — never emit a raw private-object URL into the export.
          return undefined;
        }
      }
      return d.fileUrl && !d.fileUrl.startsWith('pending://') ? d.fileUrl : undefined;
    };
    const byType = (t: string) => docs.find((d) => d.documentType === t);

    // Prefer the distinct doc types (P3 doctype split); fall back to the legacy OTHER
    // filename heuristic for documents uploaded before the split (non-overlapping,
    // no guess when nothing matches).
    const others = docs.filter((d) => d.documentType === 'OTHER');
    const legacyBoard = others.find((d) => /board|store/i.test(d.fileName ?? ''));
    const legacyDecl = others.find((d) => d !== legacyBoard && /declar|self/i.test(d.fileName ?? ''));

    return {
      gstCertificateUrl: await sign(byType('GST_CERTIFICATE')),
      addressDocUrl: await sign(byType('SHOP_ESTABLISHMENT') ?? byType('TRADE_LICENSE')),
      selfDeclarationUrl: await sign(byType('SELF_DECLARATION') ?? legacyDecl),
      boardPhotoUrl: await sign(byType('STORE_BOARD_PHOTO') ?? legacyBoard),
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
