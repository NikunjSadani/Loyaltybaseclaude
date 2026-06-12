import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KycSubmission } from '@prisma/client';

type SalesRole = 'XSR' | 'SO' | 'ASM' | 'RSM' | 'ZM' | 'NM';
type RolePhones = Record<SalesRole, string>;

const REPORTS_TO: Partial<Record<SalesRole, SalesRole>> = {
  XSR: 'SO', SO: 'ASM', ASM: 'RSM', RSM: 'ZM', ZM: 'NM',
};
const BACKEND_ROLE_TO_SALES: Record<string, SalesRole> = {
  SALES_ISR: 'XSR', SALES_SO: 'SO', SALES_ASM: 'ASM',
  SALES_STATE_HEAD: 'RSM', SALES_HO: 'NM',
};
const APPROVER_TO_STATUS: Partial<Record<SalesRole, string>> = {
  SO: 'PENDING_SO_APPROVAL', ASM: 'PENDING_ASM_APPROVAL',
  RSM: 'PENDING_RSM_APPROVAL', ZM: 'PENDING_RSM_APPROVAL', NM: 'PENDING_RSM_APPROVAL',
};
const FIELD_APPROVAL_STATUSES = new Set([
  'PENDING_SO_APPROVAL', 'PENDING_ASM_APPROVAL', 'PENDING_RSM_APPROVAL',
]);

function resolveApprover(submitterRole: SalesRole, phones: RolePhones): SalesRole {
  let current: SalesRole | undefined = REPORTS_TO[submitterRole];
  while (current) {
    if (phones[current] !== '') return current;
    current = REPORTS_TO[current];
  }
  return 'NM';
}

function canApproveStatus(role: string, status: string): boolean {
  return (
    (role === 'SALES_SO'         && status === 'PENDING_SO_APPROVAL')  ||
    (role === 'SALES_ASM'        && status === 'PENDING_ASM_APPROVAL') ||
    (role === 'SALES_STATE_HEAD' && status === 'PENDING_RSM_APPROVAL')
  );
}

interface SubmitKycDto {
  submitterRole: string; submitterUserId: string;
  partnerId: string; clientId: string; phones: RolePhones;
}
interface BulkGstRow       { kycId: string; gstVerified: boolean; reason: string; }
interface BulkPennyDropRow { kycId: string; bankVerified: boolean; reason: string; }
export interface BulkResult { processed: number; verified: number; rejected: number; errors: string[]; }

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  constructor(private readonly prisma: PrismaService) {}

  async submitKyc(dto: SubmitKycDto): Promise<KycSubmission> {
    const salesRole = BACKEND_ROLE_TO_SALES[dto.submitterRole];
    if (!salesRole) throw new ForbiddenException('This role cannot submit KYC forms.');
    const approver      = resolveApprover(salesRole, dto.phones);
    const initialStatus = APPROVER_TO_STATUS[approver] ?? 'PENDING_SO_APPROVAL';
    const submission = await this.prisma.kycSubmission.create({
      data: { userId: dto.submitterUserId, partnerId: dto.partnerId, status: initialStatus as any },
    });
    await this.recordStatusHistory(submission.id, null, initialStatus, dto.submitterUserId,
      `KYC submitted by ${dto.submitterRole} — routed to ${approver}`);
    return submission;
  }

  async firstApprove(kycId: string, approverRole: string, approverUserId: string): Promise<KycSubmission> {
    const kyc = await this.findOrThrow(kycId);
    if (!FIELD_APPROVAL_STATUSES.has(kyc.status))
      throw new ForbiddenException(`KYC is not awaiting field approval (current: ${kyc.status}).`);
    if (!canApproveStatus(approverRole, kyc.status))
      throw new ForbiddenException(`${approverRole} cannot approve a KYC in status ${kyc.status}.`);
    const updated = await this.prisma.kycSubmission.update({
      where: { id: kycId },
      data:  { status: 'PENDING_GIFSY' as any, reviewedAt: new Date() },
    });
    await this.recordStatusHistory(kycId, kyc.status, 'PENDING_GIFSY', approverUserId, `Field approved by ${approverRole}`);
    return updated;
  }

  async rejectKyc(kycId: string, rejectorRole: string, rejectorUserId: string, reason: string): Promise<KycSubmission> {
    if (!reason?.trim()) throw new BadRequestException('Rejection reason is required.');
    const kyc = await this.findOrThrow(kycId);
    const updated = await this.prisma.kycSubmission.update({
      where: { id: kycId },
      data:  { status: 'REJECTED' as any, rejectionReason: reason, reviewedAt: new Date() },
    });
    await this.recordStatusHistory(kycId, kyc.status, 'REJECTED', rejectorUserId, `Rejected by ${rejectorRole}: ${reason}`);
    return updated;
  }

  async processBulkGstVerification(rows: BulkGstRow[], adminUserId: string): Promise<BulkResult> {
    const result: BulkResult = { processed: 0, verified: 0, rejected: 0, errors: [] };
    for (const row of rows) {
      result.processed++;
      try {
        const kyc = await this.prisma.kycSubmission.findFirst({ where: { id: row.kycId, status: 'PENDING_GIFSY' as any } });
        if (!kyc) { result.errors.push(`${row.kycId}: not found or not in PENDING_GIFSY`); continue; }
        const newMeta = { ...((kyc as any).metadata ?? {}), gstVerified: row.gstVerified, gstVerificationNote: row.reason, gstVerifiedAt: new Date().toISOString(), gstVerifiedBy: adminUserId };
        await (this.prisma.kycSubmission.update as any)({ where: { id: row.kycId }, data: { metadata: newMeta } });
        await this.recordStatusHistory(row.kycId, 'PENDING_GIFSY', 'PENDING_GIFSY', adminUserId, `GST ${row.gstVerified ? 'verified' : 'rejected'}: ${row.reason}`);
        row.gstVerified ? result.verified++ : result.rejected++;
      } catch (e) { result.errors.push(`${row.kycId}: ${(e as Error).message}`); }
    }
    return result;
  }

  async processBulkPennyDrop(rows: BulkPennyDropRow[], adminUserId: string): Promise<BulkResult> {
    const result: BulkResult = { processed: 0, verified: 0, rejected: 0, errors: [] };
    for (const row of rows) {
      result.processed++;
      try {
        const kyc = await this.prisma.kycSubmission.findFirst({ where: { id: row.kycId, status: 'PENDING_GIFSY' as any } });
        if (!kyc) { result.errors.push(`${row.kycId}: not found`); continue; }
        const newMeta = { ...((kyc as any).metadata ?? {}), pennyDropNote: row.reason, pennyDropBy: adminUserId };
        await (this.prisma.kycSubmission.update as any)({
          where: { id: row.kycId },
          data: { pennydropStatus: row.bankVerified ? 'VERIFIED' : 'FAILED', pennydropVerifiedAt: new Date(), metadata: newMeta },
        });
        await this.recordStatusHistory(row.kycId, 'PENDING_GIFSY', 'PENDING_GIFSY', adminUserId, `Penny drop ${row.bankVerified ? 'verified' : 'failed'}: ${row.reason}`);
        row.bankVerified ? result.verified++ : result.rejected++;
      } catch (e) { result.errors.push(`${row.kycId}: ${(e as Error).message}`); }
    }
    return result;
  }

  async gifsyFinalApprove(kycId: string, adminUserId: string): Promise<KycSubmission> {
    const kyc  = await this.findOrThrow(kycId);
    if (kyc.status !== 'PENDING_GIFSY') throw new ForbiddenException(`KYC must be in PENDING_GIFSY status. Current: ${kyc.status}`);
    const meta = (kyc as any).metadata ?? {};
    if (kyc.pennydropStatus !== 'VERIFIED') throw new BadRequestException('Bank account (penny drop) verification is not complete.');
    if (!meta.gstVerified)                  throw new BadRequestException('GST verification is not complete.');
    if (!meta.photoApproved)                throw new BadRequestException('Photo verification is not complete.');
    const updated = await this.prisma.kycSubmission.update({
      where: { id: kycId },
      data:  { status: 'APPROVED' as any, approvedAt: new Date(), reviewedAt: new Date() },
    });
    if (kyc.partnerId) {
      await this.prisma.channelPartner.update({ where: { id: kyc.partnerId }, data: { isActive: true, onboardedAt: new Date() } });
    }
    await this.recordStatusHistory(kycId, 'PENDING_GIFSY', 'APPROVED', adminUserId, 'All verifications passed — KYC approved by Gifsy');
    return updated;
  }

  async approvePhoto(kycId: string, adminUserId: string, approved: boolean, reason?: string): Promise<void> {
    const kyc  = await this.findOrThrow(kycId);
    const meta = (kyc as any).metadata ?? {};
    const newMeta = { ...meta, photoApproved: approved, photoRejectNote: reason ?? null, photoReviewedAt: new Date().toISOString(), photoReviewedBy: adminUserId };
    await (this.prisma.kycSubmission.update as any)({ where: { id: kycId }, data: { metadata: newMeta } });
  }

  async listSubmissions(opts: { status?: string; page?: number; limit?: number } = {}) {
    const page = opts.page ?? 1; const limit = opts.limit ?? 20; const skip = (page - 1) * limit;
    const where: any = {};
    if (opts.status) where.status = opts.status;
    const [data, total] = await Promise.all([
      this.prisma.kycSubmission.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' }, include: { documents: true } }),
      this.prisma.kycSubmission.count({ where }),
    ]);
    return { data, total, page };
  }

  isSlaBreach(submittedAt: Date, slaHours: number): boolean {
    return (Date.now() - submittedAt.getTime()) / (1000 * 60 * 60) > slaHours;
  }

  // ── Outlet photos ─────────────────────────────────────────────────────────
  //
  // Returns the OUTLET_PHOTO and SHOP_ESTABLISHMENT documents attached to a
  // KYC submission so the outlet information page can show the site photos
  // taken by the XSR during their visit — ordered oldest-first (chronological).

  async getOutletPhotos(kycId: string) {
    await this.findOrThrow(kycId);

    return this.prisma.kycDocument.findMany({
      where: {
        kycSubmissionId: kycId,
        documentType:    { in: ['OUTLET_PHOTO', 'SHOP_ESTABLISHMENT'] as any[] },
        status:          { not: 'REJECTED' as any },
      },
      select: {
        id:           true,
        fileUrl:      true,
        documentType: true,
        status:       true,
        createdAt:    true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async findOrThrow(kycId: string): Promise<KycSubmission> {
    const kyc = await this.prisma.kycSubmission.findFirst({ where: { id: kycId } });
    if (!kyc) throw new NotFoundException(`KYC submission ${kycId} not found.`);
    return kyc;
  }

  private async recordStatusHistory(kycId: string, fromStatus: string | null, toStatus: string, userId: string, notes?: string): Promise<void> {
    // Snapshot the reviewer's identity at this moment so the audit trail
    // remains accurate even if the employee later resigns or is restructured
    const actor = await this.prisma.user.findUnique({
      where:   { id: userId },
      include: { salesUser: { select: { employeeCode: true } } },
    });

    await this.prisma.kycStatusHistory.create({
      data: {
        kycSubmissionId:  kycId,
        fromStatus:       fromStatus as any,
        toStatus:         toStatus as any,
        changedByUserId:  userId,
        notes,
        changedByName:    actor?.name    ?? null,
        changedByPhone:   actor?.phone   ?? null,
        changedByEmpCode: actor?.salesUser?.employeeCode ?? null,
      },
    });
  }
}
