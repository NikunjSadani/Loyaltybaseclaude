import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, KycFieldKey, KycDocumentType, KycFieldSource } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { isFixedOtpAllowed } from '../common/fixed-otp';
import { generateNumericOtp } from '../common/otp';
import { sniffFileType } from '../common/file-signature';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { KYC_FIELD_KEYS, BridgeResult } from './kyc-verification.helper';
import { evaluateSubmission } from './kyc-verification.helper';
import {
  generateKycReviewDumpExcel,
  generateRejectedKycExcel,
  KycReviewDumpEntry,
  KycReviewDumpFieldState,
  RejectedKycRow,
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
import {
  descendantSalesUserIds,
  firstActiveApproverId,
} from '../sales/sales-hierarchy-access.helper';

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
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly msg91: Msg91Service,
    private readonly storage: StorageService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ─── Tokenized document-view (security-critical) ─────────────────────────────
  /**
   * Mint a self-contained, 30-day, single-document view token.
   *
   * The token is a JWT signed with the platform JWT_SECRET carrying ONLY:
   *   { sub: <kycDocumentId>, clientId: <clientId>, typ: 'docview' }
   * It is unforgeable (HMAC), scoped to exactly one document + one tenant, and
   * type-gated (`typ:'docview'`) so a normal access token can never be replayed
   * at the doc-view endpoint and vice-versa. Used to embed copy-pasteable
   * document links in the Outlet Master export.
   */
  signDocViewToken(docId: string, clientId: string): string {
    return this.jwt.sign(
      { sub: docId, clientId, typ: 'docview' },
      { secret: this.config.get('JWT_SECRET'), expiresIn: '30d' },
    );
  }

  /**
   * GET /v1/kyc/documents/view?token=<jwt> (PUBLIC) — stream a private KYC
   * document inline, authorised SOLELY by the token.
   *
   * Security contract — on ANY failure we throw a BARE NotFoundException (no
   * descriptive detail) so the endpoint never enumerates documents or leaks why a
   * request failed:
   *   - token missing / malformed / bad signature / expired → 404
   *   - payload.typ !== 'docview'                            → 404 (replay guard)
   *   - document not found                                   → 404
   *   - document's tenant ≠ token clientId                   → 404 (cross-tenant)
   *   - object missing / too large in GCS                    → 404
   *
   * Tenant scope is enforced by the token's `clientId` claim matched against the
   * document's real tenant (KycDocument → kycSubmission → user.clientId) — there
   * is no logged-in user on this public route, so the token IS the authority.
   */
  async viewDocument(token: string): Promise<{ bytes: Buffer; contentType: string; inline: boolean }> {
    const deny = () => new NotFoundException();

    if (!token || typeof token !== 'string') throw deny();

    let payload: { sub?: unknown; clientId?: unknown; typ?: unknown };
    try {
      // Pin HS256 (defense-in-depth: never accept alg:none or an asymmetric-key confusion).
      payload = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET'), algorithms: ['HS256'] });
    } catch {
      // Bad signature / expired / malformed — all collapse to a bare 404.
      throw deny();
    }

    // Type-gate: ONLY a 'docview' token may be used here. This rejects a replayed
    // access token (which has no `typ`) and any other token shape.
    if (payload.typ !== 'docview') throw deny();
    if (typeof payload.sub !== 'string' || typeof payload.clientId !== 'string') throw deny();

    const docId = payload.sub;
    const tokenClientId = payload.clientId;

    // Load the doc + walk to its real tenant: KycDocument → kycSubmission → user.clientId.
    const doc = await this.prisma.kycDocument.findUnique({
      where: { id: docId },
      select: {
        fileKey: true,
        mimeType: true,
        kycSubmission: { select: { user: { select: { clientId: true } } } },
      },
    });
    if (!doc) throw deny();

    // Cross-tenant guard: the document's owning tenant MUST equal the token's clientId.
    const docClientId = doc.kycSubmission?.user?.clientId;
    if (!docClientId || docClientId !== tokenClientId) throw deny();
    if (!doc.fileKey) throw deny();

    const file = await this.storage.downloadBytes(doc.fileKey);
    if (!file) throw deny();

    // Stored-XSS guard: a KYC document's mimeType is CLIENT-supplied at upload, and
    // this link is opened in the app origin (via the FE /api proxy). Only render
    // known-safe types INLINE; anything else (e.g. text/html, image/svg+xml) is
    // served as an octet-stream attachment so the browser downloads it — never
    // executes it. Mirrors the openDocument allowlist on the KYC review screen (K17).
    const SAFE = new Set([
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
    ]);
    const rawMime = (doc.mimeType || file.contentType || '').toLowerCase();
    const inline  = SAFE.has(rawMime);

    return {
      bytes: file.bytes,
      contentType: inline ? rawMime : 'application/octet-stream',
      inline,
    };
  }

  /** 6-digit OTP (100000–999999) via CSPRNG — see common/otp.ts (AF-10). */
  private generateOtpCode(): string {
    return generateNumericOtp();
  }

  /**
   * Guard the outlet-owner mobile entered for KYC: it must NOT already belong to
   * another enrolled partner/outlet in the tenant, and must NOT be a sales
   * employee's number. Format-tolerant match on the last 10 digits.
   * `exceptPartnerId` skips the partner being (re-)enrolled so Re-KYC of the same
   * outlet doesn't self-collide.
   */
  private async assertPhoneAvailable(clientId: string, rawMobile: string, exceptPartnerId?: string | null): Promise<void> {
    const mobile = (rawMobile ?? '').replace(/\D/g, '').slice(-10);
    if (mobile.length !== 10) {
      throw new BadRequestException('Enter a valid 10-digit mobile number');
    }

    const partnerClash = await this.prisma.channelPartner.findFirst({
      where: {
        clientId,
        phone: { endsWith: mobile },
        ...(exceptPartnerId ? { id: { not: exceptPartnerId } } : {}),
      },
      select: { businessName: true },
    });
    if (partnerClash) {
      throw new BadRequestException(
        `This number is already registered to another outlet${partnerClash.businessName ? ` (${partnerClash.businessName})` : ''}. Each outlet must have a unique contact number.`,
      );
    }

    const employeeClash = await this.prisma.salesUser.findFirst({
      where: { deletedAt: null, user: { clientId, phone: { endsWith: mobile } } },
      select: { user: { select: { name: true } } },
    });
    if (employeeClash) {
      throw new BadRequestException(
        `This number belongs to a sales employee${employeeClash.user?.name ? ` (${employeeClash.user.name})` : ''} and cannot be used for an outlet KYC.`,
      );
    }
  }

  /**
   * GET /v1/kyc/phone-available — pre-submit uniqueness probe for the new-KYC form.
   *
   * Answers ONLY: "is this phone already a sales employee (SalesUser) in THIS
   * tenant?" so the form can block enrolling an outlet whose owner phone collides
   * with a real team member — replacing a hardcoded fake roster in the FE.
   *
   * Tenant-safe: the SalesUser is reached through its related User, filtered by
   * `user.clientId === user.clientId` (the JWT's tenant); we NEVER query across
   * clientId. Soft-deleted employees are excluded (deletedAt: null). The phone is
   * normalized to its last 10 digits (strips +91/91/punctuation) before an
   * endsWith match, mirroring assertPhoneAvailable.
   *
   * PII-safe: returns ONLY { available, conflictType } — no employee name/id is
   * exposed. The OUTLET-duplicate check stays in the FE (it reads the rep's own
   * assigned-outlet list, which the rep is already authorized to see).
   */
  async checkPhoneAvailable(
    user: JwtPayload,
    rawPhone: string,
  ): Promise<{ available: boolean; conflictType: 'EMPLOYEE' | null }> {
    const mobile = (rawPhone ?? '').replace(/\D/g, '').slice(-10);
    if (mobile.length !== 10) {
      throw new BadRequestException('Enter a valid 10-digit mobile number');
    }

    const employeeClash = await this.prisma.salesUser.findFirst({
      where: { deletedAt: null, user: { clientId: user.clientId, phone: { endsWith: mobile } } },
      select: { id: true },
    });

    return employeeClash
      ? { available: false, conflictType: 'EMPLOYEE' }
      : { available: true, conflictType: null };
  }

  /**
   * POST /v1/kyc/consent-otp — send the outlet-owner consent OTP. Permanent path
   * is real MSG91 (prod); FIXED_OTP is honored ONLY where isFixedOtpAllowed (local
   * dev + staging UAT). Stores a KYC_CONSENT OtpCode that consent() verifies.
   * Re-validates the phone (employee / duplicate-outlet) as a gate before sending.
   */
  async sendConsentOtp(user: JwtPayload, dto: { submissionId: string; mobile: string }): Promise<{ success: boolean; expiresIn: number }> {
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { id: dto.submissionId, userId: user.sub, user: { clientId: user.clientId } },
      select: { id: true, partnerId: true },
    });
    if (!submission) throw new NotFoundException('KYC submission not found');

    await this.assertPhoneAvailable(user.clientId, dto.mobile, submission.partnerId);

    const mobile = dto.mobile.replace(/\D/g, '').slice(-10);
    const otp = this.generateOtpCode();

    // One active consent OTP per number.
    await this.prisma.otpCode.deleteMany({
      where: { phone: mobile, purpose: 'KYC_CONSENT', verifiedAt: null },
    });
    await this.prisma.otpCode.create({
      data: {
        phone: mobile,
        code: otp,
        purpose: 'KYC_CONSENT',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        maxAttempts: 3,
      },
    });

    // Real send in prod; a no-op when FIXED_OTP is honored (msg91 service handles it).
    await this.msg91.sendOtp(mobile, otp, 'SMS');
    return { success: true, expiresIn: 600 };
  }

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

    // AF-10: the client-supplied mimetype is untrusted (an HTML/SVG payload can be
    // uploaded as image/jpeg). Validate the REAL type from the file's magic bytes
    // and reject anything that isn't an allowed KYC document type; store the SNIFFED
    // mimetype so the view-side render decision (K17/K27 safe-mime allowlist) can
    // trust it rather than the client's claim.
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed) {
      throw new BadRequestException(
        'Unsupported or corrupt file. Upload a JPG, PNG, WEBP, GIF, or PDF.',
      );
    }

    // Tenant-foldered key so objects are partitioned per client.
    const key = this.storage.generateKey(
      `kyc/${user.clientId}`,
      file.originalname || `${dto.documentType}.${sniffed.ext}`,
    );
    const fileUrl = await this.storage.uploadFile(file.buffer, key, sniffed.mime);

    return {
      documentType: dto.documentType,
      fileKey: key,
      fileUrl,
      fileName: file.originalname ?? null,
      mimeType: sniffed.mime, // trusted (sniffed from bytes), not client-supplied
      fileSizeBytes: file.size,
    };
  }

  private isAdmin(role: string): boolean {
    return role === 'GIFSY_ADMIN' || role === 'CLIENT_ADMIN';
  }

  /**
   * Who may see UN-masked KYC PII (PAN / GST / bank account): the admins PLUS the
   * sales reviewers in the approval chain — they validate these values against the
   * submitted GST/PAN/cheque documents, so masking them to last-4 made the review
   * impossible (owner 2026-06-25). Access to the submission itself is already gated
   * by assertCanViewSubmission (own or downline), so this only un-masks for callers
   * who can already see the row. Pure observers (MIS_USER) and any other incidental
   * viewer stay masked.
   */
  private canSeeFullKycPii(role: string): boolean {
    return (
      this.isAdmin(role) ||
      ['SALES_ISR', 'SALES_SO', 'SALES_ASM', 'SALES_STATE_HEAD', 'SALES_HO'].includes(role)
    );
  }

  /**
   * Roles that READ tenant-wide (no sales-subtree scoping): the admins plus the
   * tenant-side read-only observer MIS_USER (DATA-VISIBILITY Q5). Used ONLY for
   * read-access scoping — NOT for writes (MIS can't approve: canFirstApprove is
   * false for it) and NOT for PII unmasking (masking still keys off isAdmin, so
   * MIS sees PAN/bank as last-4).
   */
  private canReadTenantWide(role: string): boolean {
    return this.isAdmin(role) || role === 'MIS_USER';
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

  /**
   * Resolve the calling sales user's reporting subtree (Q4 — a manager sees the
   * WHOLE downline's KYC). Returns the caller's SalesUser.id plus the User.ids of
   * every sales user in their subtree (self + all descendants), so list/view can
   * scope by submitter in one query. Returns null when the caller is not a sales
   * user (e.g. a partner owner) — those callers fall back to "own submissions only".
   * Tenant-scoped throughout.
   */
  private async resolveSalesScope(
    user: JwtPayload,
  ): Promise<{
    callerSalesUserId: string;
    subtreeUserIds: string[];
    subtreeSalesUserIds: Set<string>;
  } | null> {
    const caller = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });
    if (!caller) return null;

    const nodes = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true, userId: true },
    });
    const subtree = descendantSalesUserIds(caller.id, nodes);
    const subtreeUserIds = nodes.filter((n) => subtree.has(n.id)).map((n) => n.userId);
    return { callerSalesUserId: caller.id, subtreeUserIds, subtreeSalesUserIds: subtree };
  }

  /**
   * Guard a single-submission READ (getOne/ledger): a non-admin caller who is not
   * the submitter may view ONLY if the submitter is in their sales subtree (their
   * own downline). A sales manager who is NOT in the submitter's reporting chain —
   * or a partner (no SalesUser) — gets Forbidden. (Owner: "some other SO who is not
   * the reporting manager of the XSR cannot view anything about the outlet.")
   */
  private async assertCanViewSubmission(
    user: JwtPayload,
    submitterUserId: string,
    partnerId?: string | null,
  ): Promise<void> {
    if (this.canReadTenantWide(user.role)) return; // admins/Gifsy + MIS read tenant-wide
    if (submitterUserId === user.sub) return; // own submission
    const scope = await this.resolveSalesScope(user);
    if (!scope) {
      throw new ForbiddenException('Forbidden'); // partner / non-sales caller → own-only
    }
    // Path A — the submitter is in the caller's reporting subtree (the historical rule).
    if (scope.subtreeUserIds.includes(submitterUserId)) return;
    // Path B (reassignment-aware) — the submission's OUTLET is CURRENTLY assigned
    // (active SalesUserAssignment, unassignedAt null) to a sales user in the caller's
    // subtree. This aligns "can view detail" with "can see in the list" (buildOutlets):
    // after an outlet is reassigned to a new rep, the new rep's manager sees it in the
    // list and must be able to open it, even though the ORIGINAL submitter is in a
    // different branch. An UNRELATED SO (neither submitter-chain nor current-assignee-
    // chain) still falls through to Forbidden below. Tenant-scoped via outlet.clientId.
    if (partnerId) {
      const activeAssignment = await this.prisma.salesUserAssignment.findFirst({
        where: {
          unassignedAt: null,
          salesUserId: { in: Array.from(scope.subtreeSalesUserIds) },
          // Outlet carries its own tenant tag (clientId) — scope to this tenant so the
          // assignment lookup can never cross a tenant boundary.
          outlet: { partnerId, clientId: user.clientId },
        },
        select: { id: true },
      });
      if (activeAssignment) return;
    }
    throw new ForbiddenException('Forbidden');
  }

  /**
   * Guard a first-approval/rejection ACTION: only the submission's ROUTED approver
   * may act — the first ACTIVE manager up the submitter's reporting chain ("the next
   * level approves; if vacant, the level above"). A wrong-branch manager, or one
   * whose level no longer matches, is rejected even if their role nominally matches
   * the status. Admins/Gifsy are not subject to this (they act via their own queues).
   */
  private async assertRoutedApprover(
    user: JwtPayload,
    submitterUserId: string,
  ): Promise<void> {
    if (this.isAdmin(user.role)) return;

    const caller = await this.prisma.salesUser.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });
    const submitter = await this.prisma.salesUser.findFirst({
      where: { userId: submitterUserId, user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true },
    });
    if (!caller || !submitter) {
      throw new ForbiddenException('Only the submitting rep’s reporting manager can approve this KYC.');
    }

    const nodes = await this.prisma.salesUser.findMany({
      where: { user: { clientId: user.clientId }, deletedAt: null },
      select: { id: true, reportingToId: true, isActive: true },
    });
    if (firstActiveApproverId(submitter.id, nodes) !== caller.id) {
      throw new ForbiddenException('Only the submitting rep’s reporting manager can approve this KYC.');
    }
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

    // Best-effort PUSH trigger (PWA F5): on KYC approval, also enqueue a PUSH row
    // alongside the SMS so a PWA user is notified. Every approval path routes through
    // this helper with event='KYC_APPROVED', so this single hook covers them all.
    // Wrapped so push can NEVER break the KYC path.
    if (event === 'KYC_APPROVED') {
      await this.notifications
        .enqueue({
          userId,
          channel: 'PUSH',
          subject: 'KYC approved',
          body: 'Your KYC is approved.',
          variables: { event, ...variables },
        })
        .catch(() => {
          // Non-critical: push enqueue failures must not fail the request.
        });
    }
  }

  /**
   * Create a ChannelPartner with a partnerCode that is unique per (clientId,
   * partnerCode). The code is derived deterministically from the outletCode
   * (CP-<outletCode>) and a numeric suffix is appended on a P2002 collision.
   * A P2002 on the (clientId, gstNumber) unique is surfaced as a clean
   * BadRequestException (never a 500).
   */
  private async createPartnerWithUniqueCode(
    tx: Prisma.TransactionClient,
    args: {
      clientId: string;
      userId: string;
      outletCode: string;
      details: {
        businessName: string;
        ownerName: string;
        phone: string;
        gstNumber?: string;
        panNumber?: string;
        bankName?: string;
        bankAccountNumber?: string;
        bankAccountHolder?: string;
        ifscCode?: string;
        upiId?: string;
        paymentMode?: string;
      };
    },
  ): Promise<string> {
    const base = `CP-${args.outletCode}`;
    const MAX_ATTEMPTS = 20;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const partnerCode = attempt === 0 ? base : `${base}-${attempt}`;
      try {
        const created = await tx.channelPartner.create({
          data: {
            clientId: args.clientId,
            userId: args.userId,
            partnerCode,
            isActive: true,
            ...args.details,
          },
          select: { id: true },
        });
        return created.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // Identify which unique collided. Prisma exposes the target fields.
          const target = (e.meta?.target ?? []) as string[] | string;
          const fields = Array.isArray(target) ? target : [target];
          if (fields.some((f) => f.toLowerCase().includes('gst'))) {
            throw new BadRequestException(
              `This GST number is already registered to another partner in this tenant.`,
            );
          }
          if (fields.some((f) => f.toLowerCase().includes('userid'))) {
            // The owner User already owns a partner — a logic race; do not loop.
            throw new BadRequestException(
              `This owner already has a registered partner profile.`,
            );
          }
          // partnerCode collision → retry with the next suffix.
          continue;
        }
        throw e;
      }
    }
    throw new BadRequestException(
      `Could not generate a unique partner code for outlet ${args.outletCode}.`,
    );
  }

  /**
   * Insert the KycSubmission row. The duplicate-submission guard is scoped to the
   * resolved OUTLET partner (partnerId), NOT the rep, so a rep can have many
   * in-flight submissions across DIFFERENT outlets while a single outlet still
   * can't have two concurrent in-flight KYCs. `userId` stays the submitter/rep so
   * consent()/sendConsentOtp() ownership checks (submission.userId === user.sub)
   * keep passing for the rep.
   */
  private async createSubmissionRow(
    tx: Prisma.TransactionClient,
    args: {
      user: JwtPayload;
      dto: CreateKycDto;
      status: string;
      escalatedFrom: string | null;
      partnerId: string;
      inFlightStatuses: string[];
    },
  ) {
    const { user, dto, status, escalatedFrom, partnerId, inFlightStatuses } = args;

    const existing = await tx.kycSubmission.findFirst({
      where: {
        partnerId,
        status: { in: inFlightStatuses as never },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('You already have a pending KYC submission');
    }

    return tx.kycSubmission.create({
      data: {
        userId: user.sub,
        partnerId,
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
  }

  // ─── POST /v1/kyc ────────────────────────────────────────────────────────────
  async create(user: JwtPayload, dto: CreateKycDto) {
    // ── OUTLET-DRIVEN KYC ─────────────────────────────────────────────────────
    // The submission is FILED BY the rep (user.sub) but is ABOUT dto.outletId's
    // outlet/owner. We (a) resolve the target outlet, (b) resolve-or-create the
    // outlet-owner User (PENDING_VERIFICATION) + its ChannelPartner, (c) block
    // duplicates PER OUTLET-PARTNER (not per rep), then create the submission
    // with partnerId = the OUTLET's partner. Self-enrolment still works: an owner
    // submitting for their own outlet resolves their existing partner unchanged.

    // 1. Resolve the target outlet FIRST (tenant-scoped). dto.outletId is the
    //    Outlet `id` (CUID), confirmed from the FE (sales/kyc/new/page.tsx sends
    //    selectedOutlet.outletId = o.id, NOT outletCode).
    const outlet = await this.prisma.outlet.findFirst({
      where: { id: dto.outletId, clientId: user.clientId },
      include: { outletType: { select: { code: true } } },
    });
    if (!outlet) throw new NotFoundException('Outlet not found');

    // Guard the owner phone BEFORE any write (H1): it must not belong to a sales
    // EMPLOYEE or to a DIFFERENT existing partner/outlet. `exceptPartnerId` skips this
    // outlet's own partner so Re-KYC of the same outlet doesn't self-collide. This
    // prevents attaching the outlet's wallet/payouts (and the on-approval activation)
    // to the wrong account. Throws a clean 400.
    await this.assertPhoneAvailable(user.clientId, dto.mobile, outlet.partnerId ?? undefined);

    // Map outlet type code → owner UserRole. Unknown/other → SSS (default).
    const OUTLET_TYPE_TO_ROLE: Record<string, 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST'> = {
      SSS: 'SSS',
      WHOLESALER: 'WHOLESALER',
      SUB_STOCKIST: 'SUB_STOCKIST',
    };
    const ownerRole = OUTLET_TYPE_TO_ROLE[outlet.outletType?.code ?? ''] ?? 'SSS';

    // Common ChannelPartner detail patch (bank + identity) from the dto.
    const partnerDetails = {
      businessName: dto.partnerName,
      ownerName: dto.partnerName,
      phone: dto.mobile,
      // Normalise a blank/whitespace GST to undefined → stored as NULL, never ''.
      // The column is `@@unique([clientId, gstNumber])`; an empty string is a real
      // value that collides, so a SECOND outlet with no GST would hit P2002. NULLs
      // do not collide. (undefined also avoids clobbering an existing GST on update.)
      gstNumber: dto.gstNumber?.trim() || undefined,
      panNumber: dto.panNumber ?? undefined,
      bankName: dto.bankName ?? undefined,
      bankAccountNumber: dto.accountNumber ?? undefined,
      bankAccountHolder: dto.accountHolderName ?? undefined,
      ifscCode: dto.ifscCode ?? undefined,
      upiId: dto.upiId ?? undefined,
      paymentMode: dto.paymentMode ?? undefined,
    };

    // 2. Escalation routing — DB-backed via the real SalesUser reporting tree.
    //    Read-only; computed before the write transaction.
    const { status, escalatedFrom } = await this.resolveInitialRouting(user);

    const IN_FLIGHT_STATUSES = [
      'DRAFT',
      'SUBMITTED',
      'UNDER_REVIEW',
      'PENDING_SO_APPROVAL',
      'PENDING_ASM_APPROVAL',
      'PENDING_RSM_APPROVAL',
      'PENDING_GIFSY',
    ] as const;

    // 3. All resolve-or-create + submission writes in ONE transaction so a partial
    //    failure can't orphan a User without a ChannelPartner.
    const submission = await this.prisma.$transaction(async (tx) => {
      // 3a. Resolve-or-create the ChannelPartner that OWNS this outlet.
      let partnerId: string;

      if (outlet.partnerId) {
        // Re-KYC / already-owned outlet → update the existing partner's details.
        try {
          const updated = await tx.channelPartner.update({
            where: { id: outlet.partnerId },
            data: partnerDetails,
            select: { id: true },
          });
          partnerId = updated.id;
        } catch (e) {
          // A GST collision on @@unique([clientId,gstNumber]) → clean 400, not a 500 (M1).
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            const fields = ([] as string[]).concat((e.meta?.target ?? []) as string[]);
            if (fields.some((f) => String(f).toLowerCase().includes('gst'))) {
              throw new BadRequestException(
                'This GST number is already registered to another partner in this tenant.',
              );
            }
          }
          throw e;
        }
      } else {
        // Partner-less (brand-new) outlet → create the owner User + its partner.
        // assertPhoneAvailable() above already blocked the phone if it belongs to a
        // sales employee or an existing partner, so any user STILL found by this
        // phone is some OTHER account (e.g. an admin) and must NOT be repurposed as
        // an outlet owner (H1). Skip soft-deleted rows (M2). Reject cleanly.
        const existingUser = await tx.user.findFirst({
          where: { clientId: user.clientId, phone: dto.mobile, deletedAt: null },
          select: { id: true },
        });
        if (existingUser) {
          throw new BadRequestException(
            'This number is already registered to another account and cannot be used for an outlet.',
          );
        }

        // Create the owner User in PENDING_VERIFICATION (NOT a usable login until
        // GIFSY approval flips it to ACTIVE), then its ChannelPartner.
        const created = await tx.user.create({
          data: {
            clientId: user.clientId,
            phone: dto.mobile,
            name: dto.partnerName,
            role: ownerRole,
            status: 'PENDING_VERIFICATION',
          },
          select: { id: true },
        });
        partnerId = await this.createPartnerWithUniqueCode(tx, {
          clientId: user.clientId,
          userId: created.id,
          outletCode: outlet.outletCode,
          details: partnerDetails,
        });
      }

      // 3b. Link the outlet to the resolved partner (if needed) AND persist the
      //     KYC-captured address onto the OUTLET. The submitted address lives on
      //     Outlet, not ChannelPartner (schema: `addressLine1 // captured at KYC`),
      //     and was previously never written — so the reviewer saw a blank address.
      //     Always write the address so the latest submission's address is shown.
      await tx.outlet.update({
        where: { id: outlet.id },
        data: {
          ...(outlet.partnerId !== partnerId ? { partnerId } : {}),
          addressLine1: dto.address,
          city: dto.city,
          state: dto.state,
          pincode: dto.pincode,
        },
      });

      // 3c. Create the submission (duplicate guard scoped to THIS partner).
      return this.createSubmissionRow(tx, {
        user,
        dto,
        status,
        escalatedFrom,
        partnerId,
        inFlightStatuses: [...IN_FLIGHT_STATUSES],
      });
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

    // Sales hierarchy scoping (Q4 + owner 2026-06-24): a sales manager sees their
    // WHOLE downline's KYC (every status — the FE "Approval Pending" tab filters to
    // the caller's level); a leaf rep sees their own. The old per-level tenant-wide
    // status filter leaked every SO's queue to every other SO — replaced here. The
    // submitter (KycSubmission.userId = the rep who filed it) must be in the caller's
    // subtree. Admins/MIS/Gifsy stay tenant-wide / cross-tenant.
    let submitterScope: string[] | null = null;
    if (!this.canReadTenantWide(user.role)) {
      const scope = await this.resolveSalesScope(user);
      submitterScope = scope ? scope.subtreeUserIds : [user.sub];
      where.userId = { in: submitterScope };
    }

    if (q.status && this.canReadTenantWide(user.role)) {
      where.status = q.status;
    }

    const [submissions, total] = await Promise.all([
      this.prisma.kycSubmission.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, phone: true } },
          // Identity shown on the sales KYC list = the OUTLET (name/code/phone), with
          // businessName kept only as a fallback. The submitter (user) stays the rep.
          partner: {
            select: {
              id: true,
              businessName: true,
              ownerName: true,
              phone: true,
              outlets: {
                select: {
                  id: true,
                  name: true,
                  outletCode: true,
                  phone: true,
                  programName: true,
                  programCategory: true,
                  outletType: { select: { code: true } },
                },
              },
            },
          },
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
      where: this.canReadTenantWide(user.role)
        ? { ...this.kycTenantFilter(user) }
        : { userId: { in: submitterScope ?? [user.sub] }, ...this.kycTenantFilter(user) },
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
        // partner.outlets[].outletCode is the human "outlet ID" surfaced in the detail header
        // (KYC is partner-keyed; the enrolled outlet's code lives on the partner's outlets).
        partner: { include: { outlets: { select: {
          id: true, name: true, outletCode: true, phone: true,
          // Address lives on the Outlet (captured at KYC) — surfaced so the reviewer
          // can see the submitted address (ChannelPartner has no address columns).
          addressLine1: true, addressLine2: true, city: true, state: true, pincode: true,
          // outletType.code (SSS/WHOLESALER/SUB_STOCKIST) drives the sales-app
          // "Redeem for Outlet" gate (redeemGiftWholesalerOnly). Without it the FE
          // sees outletType=undefined and the wholesaler-only gate hides redeem for
          // EVERY outlet — including genuine wholesalers.
          outletType: { select: { code: true } },
        } } } },
        // 3.4d: the detail-page field panel seeds its current state from these.
        verificationItems: {
          select: { fieldKey: true, decision: true, remark: true, source: true, verifiedAt: true },
        },
      },
    });

    if (!submission) throw new NotFoundException('KYC submission not found');

    // Access scoping (owner 2026-06-24): a partner sees only their OWN submission;
    // a sales caller sees their own + their DOWNLINE's (Q4) — an SO outside the
    // submitting rep's reporting chain is Forbidden ("cannot view anything about the
    // outlet"). Admins/MIS/Gifsy get tenant-wide / cross-tenant read. Cross-tenant is
    // already prevented by kycTenantFilter above; PII is still masked below for any
    // non-admin non-owner (a sales reviewer sees PAN/bank as last-4). partnerId widens
    // the read to the outlet's CURRENT assignee chain (reassignment case — matches the
    // list/targets views in buildOutlets), not just the original submitter chain.
    await this.assertCanViewSubmission(user, submission.userId, submission.partnerId);

    // ── Task 3.4e: DPDP read-masking ─────────────────────────────────────────
    // Mask sensitive fields (bank account, PAN, GST → last 4) for non-admin callers
    // who are NOT the submission owner. Admins and the owner (who entered the data)
    // see full values. NB: today a non-admin non-owner is already 403'd above, so this
    // is defensive cover for any future read access (e.g. sales approvers viewing a
    // submission). TODO: switch the privileged check to the `kyc:view_documents`
    // permission once the RBAC flag-gate is enforced (currently role-based).
    const masked = !this.canSeeFullKycPii(user.role) && submission.userId !== user.sub;
    const partner = submission.partner
      ? this.maskPartnerSensitiveFields(submission.partner, masked)
      : null;

    // Resolve a viewable URL per document so the reviewer (sales SO/ASM or Gifsy
    // admin) can actually OPEN each uploaded doc/photo. GCS objects are private —
    // they only render via a short-lived signed URL; legacy inline data URLs pass
    // through; `pending://` placeholders (no file uploaded yet) resolve to null.
    // Inline docs sequentially under a per-RESPONSE byte budget. KycDocument has no
    // unique (submission, type) constraint, so a submission could in theory accrete
    // many ≤5MB uploads; without an aggregate cap, inlining them all would build a
    // huge JSON in memory. Once the budget is spent, remaining docs resolve to null
    // (the FE shows a placeholder) rather than ballooning the payload.
    const MAX_INLINE_BYTES = 24 * 1024 * 1024; // ~24MB across all docs in one review
    let remaining = MAX_INLINE_BYTES;
    const documents: Array<(typeof submission.documents)[number] & { viewUrl: string | null }> = [];
    for (const d of submission.documents) {
      const viewUrl = remaining > 0 ? await this.resolveDocumentViewUrl(d, remaining) : null;
      if (viewUrl) remaining -= viewUrl.length;
      documents.push({ ...d, viewUrl });
    }

    return { submission: { ...submission, partner, documents } };
  }

  /** A browser-renderable read URL for a single KYC document. Fails CLOSED:
   *  a not-yet-uploaded `pending://` ref or any read error resolves to null so the
   *  caller never leaks a raw private-object URL (the FE shows a placeholder).
   *
   *  GCS objects are PRIVATE — we inline them as base64 `data:` URLs read via the
   *  runtime SA's objectAdmin grant, deliberately NOT via V4 signed URLs. Signed
   *  URLs require the SA to sign blobs over IAM, which is unreliable on Cloud Run
   *  here (every signed URL came back null at runtime) and impossible locally (no
   *  keyfile); object READ works wherever uploads work. Already-inline data URLs
   *  (e.g. SIGNATURE, legacy base64) pass through untouched. */
  private async resolveDocumentViewUrl(
    d: { fileUrl: string; fileKey: string; mimeType?: string | null },
    maxBytes = 8 * 1024 * 1024,
  ): Promise<string | null> {
    if (!d.fileUrl || d.fileUrl.startsWith('pending://')) return null;
    if (d.fileUrl.startsWith('data:')) return d.fileUrl; // already inline
    if (d.fileKey && d.fileUrl.startsWith('https://storage.googleapis.com/')) {
      try {
        return await this.storage.downloadAsDataUrl(d.fileKey, d.mimeType ?? undefined, maxBytes);
      } catch (err) {
        // Don't swallow silently — a read failure here is exactly why the reviewer
        // sees a blank doc; log it so the cause is visible in Cloud Run logs.
        this.logger.warn(
          `KYC doc inline failed for ${d.fileKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }
    return null;
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

    // …and only the ROUTED approver (the submitting rep's first active manager up
    // the chain) may act — a same-level manager in a different branch is rejected.
    await this.assertRoutedApprover(user, submission.userId);

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
          // Self-describe the row (mirrors reject()) so the sales timeline can show
          // the approver stage/role without a separate User join.
          metadata: { stage: 'FIRST_APPROVER', approverRole: user.role },
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
        // S3 nit: surface the blocked blanket-approve server-side (the client only
        // sees the 409) so the conflict is traceable in logs.
        this.logger.warn(
          `Blanket approve blocked for submission ${id}: rejected fields [${bridgeResult.rejectedFields.join(', ')}] → RE_UPLOAD_REQUIRED.`,
        );
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

    // A field approver may reject only as the ROUTED approver (the submitting rep's
    // first active manager). Gifsy admin is exempt (acts at the final stage).
    if (!isGifsyAdmin) {
      await this.assertRoutedApprover(user, submission.userId);
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

    // A sales caller may read the ledger only for their own + downline submissions
    // (Q4) OR for an outlet currently assigned into their subtree (reassignment case —
    // same widening as getOne, so the ledger read matches what the list exposes); an
    // out-of-chain manager is Forbidden. (Partner callers are already scoped to their
    // own via the where.userId filter above → a foreign id 404s here.)
    await this.assertCanViewSubmission(user, submission.userId, submission.partnerId);

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
    // FIXED_OTP is a dev/staging-only bypass (gated by isFixedOtpAllowed; always
    // refused on the prod DB). Permanent path is the real MSG91 code stored above.
    const fixedOtp = isFixedOtpAllowed() ? process.env.FIXED_OTP : undefined;
    const otpMatches = otpRecord.code === otp || (!!fixedOtp && otp === fixedOtp);
    if (!otpMatches) {
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

    // Defense-in-depth (GLm-3): scope to the caller's tenant via the related
    // submission, like every other query in this method. Today slaMetrics is
    // GIFSY-only (kycTenantFilter → {} = all tenants, by design), so this is a
    // no-op for the live caller; it prevents a cross-tenant rejection-reason leak
    // if this metric is ever opened to a CLIENT_ADMIN.
    const rejectionHistory = await this.prisma.kycStatusHistory.findMany({
      where: {
        toStatus: 'REJECTED',
        notes: { not: null },
        kycSubmission: { ...this.kycTenantFilter(user) },
      },
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
   * S1: if fieldKeys are supplied but no primary outlet exists, throws a ConflictException
   *     inside the tx → full rollback, no half-commit. (item #1: a clean 409, not a raw
   *     Error → 500, and the message does not leak the internal submission id.)
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
        // Clean 409 instead of a raw Error → 500. Do not leak the internal submission
        // id or the field list in the client message; the tx rolls back (no status flip).
        throw new ConflictException(
          'Cannot set re-KYC field flags: this submission has no active outlet to attach them to. Activate the outlet first.',
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
   *        and throws if none, rolling back the entire tx (no half-commit). item #1: the
   *        throw is a ConflictException (clean 409, no internal-id leak) — not a raw Error.
   *   item #2 — for APPROVED, also flips the partner's outlet(s) to isActive=true so they
   *        become visible to targets/credits/payouts (outlets are created isActive=false).
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
      partner: {
        userId: string;
        outlets: Array<{ id: string; reKycFlags: Prisma.JsonValue | null }>;
      } | null;
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

      // Activate the OUTLET OWNER — NOT the submitter. For sales-assisted KYC the
      // submitter (submission.userId) is the REP, whose login must stay as-is;
      // the account that becomes login-able is the outlet owner = the submission's
      // partner's user. For self-enrolment partner.userId === submission.userId so
      // behavior is unchanged. Legacy rows with no partner fall back to the
      // submitter (no regression).
      const ownerUserId = submission.partner?.userId ?? submission.userId;

      // Login-identity change on approval: a re-KYC may have updated the partner's
      // number on the ChannelPartner (the contact phone). On approval the LOGIN phone
      // officially moves to that number — sync User.phone (the OTP login identity) and
      // REVOKE the partner's existing sessions so the old number can no longer log in
      // and they must re-authenticate on the new one (owner decision). A first-time
      // approval is a no-op here (the owner User was created with the same number, and
      // it has no sessions yet). Mirrors the admin user-edit "force re-login on phone
      // change" guarantee, which partners previously lacked.
      const ownerRow = await tx.user.findUnique({
        where: { id: ownerUserId },
        select: { phone: true, clientId: true },
      });
      const partnerRow = submission.partnerId
        ? await tx.channelPartner.findUnique({
            where: { id: submission.partnerId },
            select: { phone: true },
          })
        : null;
      const newPhone = partnerRow?.phone;
      let loginPhoneChanged = false;
      if (newPhone && ownerRow && newPhone !== ownerRow.phone) {
        // Never create two users sharing one login number in a tenant (the small
        // submit→approval window could let another account claim it). If taken, keep
        // the existing login and log it — the contact number still updated.
        const clash = await tx.user.findFirst({
          where: { clientId: ownerRow.clientId, phone: newPhone, deletedAt: null, id: { not: ownerUserId } },
          select: { id: true },
        });
        if (clash) {
          this.logger.warn(
            `KYC approval: login-phone sync skipped for user ${ownerUserId} — ${newPhone} already in use in tenant ${ownerRow.clientId}`,
          );
        } else {
          loginPhoneChanged = true;
        }
      }

      await tx.user.update({
        where: { id: ownerUserId },
        data: { status: 'ACTIVE', ...(loginPhoneChanged ? { phone: newPhone } : {}) },
      });
      if (loginPhoneChanged) {
        await tx.userSession.updateMany({
          where: { userId: ownerUserId, revokedAt: null },
          data: { revokedAt: now },
        });
        this.logger.log(`KYC approval: login phone changed for user ${ownerUserId} → sessions revoked`);
      }

      // Create wallet if not exists.
      if (submission.partnerId) {
        const existingWallet = await tx.wallet.findFirst({
          where: { partnerId: submission.partnerId },
        });
        if (!existingWallet) {
          await tx.wallet.create({ data: { partnerId: submission.partnerId } });
        }

        // Activate the owning partner's outlet(s). Outlets are created PENDING
        // (isActive=false, see admin-outlets buildOutletCreate); KYC approval is the
        // event that brings them live so they become visible to targets/credits/payouts.
        // KYC owns this side-effect (distinct from the admin-outlets upsert path). Scope:
        //   - partnerId match (the approved partner's outlets only)
        //   - deletedAt: null (never resurrect a soft-deleted outlet)
        //   - kycIntent != NOT_INTERESTED (an outlet the agent explicitly declined stays
        //     deactivated — notInterested() set isActive=false deliberately)
        // Tenant-safe: outlets are reached via partnerId, and the partner itself was
        // already tenant-resolved by the submission load.
        await tx.outlet.updateMany({
          where: {
            partnerId: submission.partnerId,
            deletedAt: null,
            // kycIntent is nullable — a freshly-created outlet awaiting KYC has it NULL.
            // Prisma's `{ not: 'X' }` compiles to `<> 'X'`, which is NULL (not TRUE) for
            // NULL rows, so a bare `not` would SILENTLY EXCLUDE the common null-intent
            // outlets (approval no-op). Match null OR not-declined explicitly.
            OR: [{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }],
          },
          data: { isActive: true, reactivatedAt: now },
        });
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
        // No active primary outlet to carry the reKycFlags. Fail with a clean 409
        // (not a raw Error → 500) and DO NOT leak the internal submission id or the
        // partner's internal field list in the client-facing message. The rejected
        // fields + submissionId are still recorded in the thrown context via the
        // status/audit rows? No — we throw BEFORE the status flip, so the whole tx
        // rolls back (audit S1: no half-commit). Operators see detail in server logs.
        throw new ConflictException(
          'Cannot record re-upload: this submission has no active outlet to attach the re-KYC flags to. Activate the outlet first.',
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

  // ─── GET /v1/kyc/rejected-export ─────────────────────────────────────────────
  /**
   * "Rejected outlets" export: one xlsx row per REJECTED submission, with the full
   * KYC payload PLUS exactly which fields the Gifsy admin rejected and the per-field
   * remark. Scoped EXACTLY like the on-screen list (`kycTenantFilter`) so the rows
   * match what the admin sees on the Rejected filter (Gifsy = cross-tenant; a tenant
   * admin = own tenant only). Pure layout in kyc-review-dump.ts; this assembles rows.
   *
   * Rejected-date + rejected-by come from the KycStatusHistory row whose
   * toStatus = REJECTED (the most recent such transition); the actor name is resolved
   * from changedByUserId. Overall reason = KycSubmission.rejectionReason.
   */
  async rejectedExport(user: JwtPayload): Promise<Buffer> {
    if (user.role !== 'GIFSY_ADMIN') throw new ForbiddenException('Forbidden - Gifsy Admin only');

    const submissions = await this.prisma.kycSubmission.findMany({
      where: { status: 'REJECTED', ...this.kycTenantFilter(user) },
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
        verificationItems: { select: { fieldKey: true, decision: true, remark: true, source: true } },
        // Rejected-date + actor: the (latest) transition INTO the REJECTED status.
        statusHistory: {
          where: { toStatus: 'REJECTED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true, changedByUserId: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Resolve the rejecter names in one round-trip (avoid an N+1 user lookup).
    const actorIds = Array.from(
      new Set(submissions.map((s) => s.statusHistory[0]?.changedByUserId).filter((v): v is string => !!v)),
    );
    const actors = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    const rows: RejectedKycRow[] = submissions.map((s) => {
      const p = s.partner;
      const o = p?.outlets[0];
      const hist = s.statusHistory[0];
      const rejectedAt = hist?.createdAt ?? s.reviewedAt ?? null;
      const submittedAt = s.submittedAt ?? s.createdAt;
      // SLA age = submitted → rejected, in whole hours (omit when either is missing).
      const slaAgeHrs =
        submittedAt && rejectedAt
          ? Math.max(0, Math.round((rejectedAt.getTime() - submittedAt.getTime()) / 3_600_000))
          : undefined;
      const fieldStates = this.dumpFieldStates(s.verificationItems);
      const fields = {} as RejectedKycRow['fields'];
      for (const k of KYC_FIELD_KEYS) {
        fields[k] = { decision: fieldStates[k].decision, remark: fieldStates[k].remark };
      }
      return {
        outletCode: o?.outletCode ?? '',
        outletName: o?.name ?? p?.businessName ?? '',
        ownerName: p?.ownerName ?? '',
        mobile: p?.phone ?? s.user.phone ?? '',
        salesRep: s.user.name ?? '',
        submittedDate: submittedAt ? submittedAt.toISOString().slice(0, 10) : '',
        rejectedDate: rejectedAt ? rejectedAt.toISOString().slice(0, 10) : '',
        rejectedBy: (hist?.changedByUserId && actorName.get(hist.changedByUserId)) || '',
        rejectionReason: s.rejectionReason ?? '',
        slaAgeHrs,
        fields,
        gstNumber: p?.gstNumber ?? '',
        panNumber: p?.panNumber ?? '',
        address: [o?.addressLine1, o?.addressLine2].filter(Boolean).join(', '),
        city: o?.city ?? '',
        state: o?.state ?? '',
        pincode: o?.pincode ?? '',
        bankName: p?.bankName ?? undefined,
        accountHolderName: p?.bankAccountHolder ?? undefined,
        accountNumber: p?.bankAccountNumber ?? undefined,
        ifscCode: p?.ifscCode ?? undefined,
        upiId: p?.upiId ?? undefined,
      };
    });

    return generateRejectedKycExcel(rows);
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
   *
   * KNOWN RESIDUAL (2026-06-25): this export still uses V4 getSignedUrl, which fails
   * on Cloud Run here (same root cause that made the portal-review images blank — see
   * resolveDocumentViewUrl, now switched to inline reads). So these Excel doc links
   * come back blank in that environment. Not switched to data: URLs because an Excel
   * cell can't carry a multi-MB data URL as a clickable link — the proper fix is at
   * the IAM/signing layer (or a per-doc redirect endpoint). Fails CLOSED meanwhile.
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
