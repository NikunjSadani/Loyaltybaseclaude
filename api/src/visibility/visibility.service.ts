import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVisibilityProgramDto, UpdateVisibilityProgramDto } from './dto/visibility-admin.dto';

interface SubmitPhotoDto {
  programId:  string;
  outletId:   string;
  imageUrl:   string;
  latitude?:  number | null;
  longitude?: number | null;
  notes?:     string;
}

interface ListOpts {
  status?:  string;
  page?:    number;
  limit?:   number;
}

@Injectable()
export class VisibilityService {
  private readonly logger = new Logger(VisibilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Admin: Program management ─────────────────────────────────────────────

  async listPrograms(clientId: string, opts: ListOpts) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;

    const where: any = { clientId, deletedAt: null };
    if (opts.status) where.status = opts.status;

    const [data, total] = await Promise.all([
      this.prisma.visibilityProgram.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
      }),
      this.prisma.visibilityProgram.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  async createProgram(clientId: string, creatorId: string, dto: CreateVisibilityProgramDto) {
    return this.prisma.visibilityProgram.create({
      data: {
        clientId,
        code:                  dto.code,
        name:                  dto.name,
        description:           dto.description           ?? null,
        startDate:             new Date(dto.startDate),
        endDate:               new Date(dto.endDate),
        pointsPerSubmission:   dto.pointsPerSubmission,
        maxSubmissionsPerMonth: dto.maxSubmissionsPerMonth ?? null,
        eligibleClasses:       (dto.eligibleClasses ?? []) as any,
        createdByUserId:       creatorId,
        status:                'DRAFT' as any,
      },
    });
  }

  async updateProgram(id: string, clientId: string, dto: UpdateVisibilityProgramDto) {
    const program = await this.prisma.visibilityProgram.findFirst({
      where: { id, clientId, deletedAt: null },
    });
    if (!program) throw new NotFoundException('Program not found');

    const data: any = { ...dto };
    if (dto.startDate) data.startDate = new Date(dto.startDate);
    if (dto.endDate)   data.endDate   = new Date(dto.endDate);

    return this.prisma.visibilityProgram.update({ where: { id }, data });
  }

  // ── Submit photo ───────────────────────────────────────────────────────────

  async submitPhoto(userId: string, clientId: string, dto: SubmitPhotoDto) {
    const program = await this.prisma.visibilityProgram.findFirst({
      where: { id: dto.programId, clientId, status: 'ACTIVE' as any },
    });
    if (!program) {
      throw new NotFoundException('Visibility program not found or not active');
    }

    const partner = await this.prisma.channelPartner.findFirst({
      where: { userId, clientId },
    });
    if (!partner) throw new NotFoundException('Partner account not found');

    const submission = await this.prisma.visibilitySubmission.create({
      data: {
        programId:  dto.programId,
        partnerId:  partner.id,
        outletId:   dto.outletId,
        imageUrls:  [dto.imageUrl],
        latitude:   dto.latitude   !== null ? dto.latitude   : undefined,
        longitude:  dto.longitude  !== null ? dto.longitude  : undefined,
        status:     'DRAFT' as any,
      },
    });

    this.logger.log(`Visibility submission created: ${submission.id}`);
    return submission;
  }

  // ── Approve ────────────────────────────────────────────────────────────────

  async approveSubmission(submissionId: string, reviewerId: string, clientId: string) {
    const submission = await this.prisma.visibilitySubmission.findFirst({
      where: { id: submissionId, program: { clientId } },
      include: { program: true },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    const pts = submission.program.pointsPerSubmission;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Update submission status + award points
      const approved = await tx.visibilitySubmission.update({
        where: { id: submissionId },
        data:  {
          status:          'APPROVED' as any,
          reviewedByUserId: reviewerId,
          reviewedAt:      new Date(),
          pointsAwarded:   pts,
        },
      });

      // Log approval
      await tx.visibilityApproval.create({
        data: {
          submissionId,
          reviewerUserId: reviewerId,
          fromStatus:     submission.status as any,
          toStatus:       'APPROVED' as any,
        },
      });

      // Award points to partner wallet
      const wallet = await tx.wallet.findFirst({ where: { partnerId: submission.partnerId } });
      if (wallet) {
        await tx.wallet.update({
          where: { partnerId: submission.partnerId },
          data:  {
            redeemablePoints: { increment: pts },
            earnedPoints:     { increment: pts },
            lifetimeEarned:   { increment: pts },
          },
        });

        await tx.walletTransaction.create({
          data: {
            walletId:        wallet.id,
            transactionType: 'CREDIT_POINTS_EARNED' as any,
            points:          pts,
            balanceBefore:   wallet.redeemablePoints,
            balanceAfter:    wallet.redeemablePoints + pts,
            balanceType:     'redeemablePoints',
            referenceType:   'VISIBILITY_SUBMISSION',
            referenceId:     submissionId,
            description:     `Visibility approval: ${submission.program.name}`,
          },
        });

        await tx.pointsLedger.create({
          data: {
            walletId:        wallet.id,
            transactionType: 'EARN' as any,
            points:          pts,
            sourceType:      'VISIBILITY_SUBMISSION',
            sourceId:        submissionId,
          },
        });
      }

      return approved;
    });

    this.logger.log(`Visibility submission approved: ${submissionId} (+${pts} pts)`);
    return updated;
  }

  // ── Reject ─────────────────────────────────────────────────────────────────

  async rejectSubmission(
    submissionId: string,
    reviewerId:   string,
    clientId:     string,
    reason:       string,
  ) {
    const submission = await this.prisma.visibilitySubmission.findFirst({
      where: { id: submissionId, program: { clientId } },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    const updated = await this.prisma.visibilitySubmission.update({
      where: { id: submissionId },
      data:  {
        status:           'REJECTED' as any,
        reviewedByUserId: reviewerId,
        reviewedAt:       new Date(),
        rejectionReason:  reason,
      },
    });

    await this.prisma.visibilityApproval.create({
      data: {
        submissionId,
        reviewerUserId: reviewerId,
        fromStatus:     submission.status as any,
        toStatus:       'REJECTED' as any,
        notes:          reason,
      },
    });

    return updated;
  }

  // ── List submissions ───────────────────────────────────────────────────────

  async listSubmissions(clientId: string, opts: ListOpts) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;

    const where: any = { program: { clientId } };
    if (opts.status) where.status = opts.status;

    const [data, total] = await Promise.all([
      this.prisma.visibilitySubmission.findMany({
        where, skip, take: limit,
        orderBy:  { createdAt: 'desc' },
        include: {
          program: { select: { id: true, name: true, pointsPerSubmission: true } },
          partner: { select: { id: true, businessName: true } },
        },
      }),
      this.prisma.visibilitySubmission.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
