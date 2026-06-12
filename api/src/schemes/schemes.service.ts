import {
  Injectable, BadRequestException, NotFoundException,
  ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Scheme } from '@prisma/client';

interface CreateSchemeDto {
  clientId:        string;
  code:            string;
  name:            string;
  description?:    string;
  schemeType:      string;
  rewardType:      string;
  startDate:       string;
  endDate:         string;
  pointsPerRupee?: number;
  fixedPoints?:    number;
  maxPointsPerCycle?: number;
  budgetPaise?:    number;
  holdingPeriodDays?: number;
  isStackable?:    boolean;
  priority?:       number;
  termsAndConditions?: string;
  createdByUserId?: string;
}

@Injectable()
export class SchemesService {
  private readonly logger = new Logger(SchemesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async createScheme(dto: CreateSchemeDto): Promise<Scheme> {
    const start = new Date(dto.startDate);
    const end   = new Date(dto.endDate);

    if (end <= start) {
      throw new BadRequestException('endDate must be after startDate.');
    }

    const conflict = await this.prisma.scheme.findFirst({
      where: { clientId: dto.clientId, code: dto.code, deletedAt: null },
    });
    if (conflict) {
      throw new ConflictException(`Scheme code "${dto.code}" already exists for this client.`);
    }

    const scheme = await this.prisma.scheme.create({
      data: {
        clientId:          dto.clientId,
        code:              dto.code,
        name:              dto.name,
        description:       dto.description ?? null,
        schemeType:        dto.schemeType as any,
        rewardType:        dto.rewardType as any,
        status:            'DRAFT' as any,
        startDate:         start,
        endDate:           end,
        pointsPerRupee:    dto.pointsPerRupee ?? null,
        fixedPoints:       dto.fixedPoints ?? null,
        maxPointsPerCycle: dto.maxPointsPerCycle ?? null,
        budgetPaise:       dto.budgetPaise ?? null,
        holdingPeriodDays: dto.holdingPeriodDays ?? 30,
        isStackable:       dto.isStackable ?? false,
        priority:          dto.priority ?? 0,
        termsAndConditions: dto.termsAndConditions ?? null,
        createdByUserId:   dto.createdByUserId ?? null,
      },
    });

    this.logger.log(`Scheme created: ${scheme.code} (${dto.clientId})`);
    return scheme;
  }

  // ── Activate ──────────────────────────────────────────────────────────────

  async activateScheme(schemeId: string, clientId: string): Promise<Scheme> {
    const scheme = await this.findOrThrow(schemeId, clientId);
    if (!['DRAFT', 'PAUSED'].includes(scheme.status)) {
      throw new BadRequestException(
        `Only DRAFT or PAUSED schemes can be activated. Current: ${scheme.status}.`,
      );
    }
    return this.prisma.scheme.update({
      where: { id: schemeId },
      data:  { status: 'ACTIVE' as any },
    });
  }

  // ── Pause ─────────────────────────────────────────────────────────────────

  async pauseScheme(schemeId: string, clientId: string): Promise<Scheme> {
    const scheme = await this.findOrThrow(schemeId, clientId);
    if (scheme.status !== 'ACTIVE') {
      throw new BadRequestException(`Only ACTIVE schemes can be paused. Current: ${scheme.status}.`);
    }
    return this.prisma.scheme.update({
      where: { id: schemeId },
      data:  { status: 'PAUSED' as any },
    });
  }

  // ── Eligibility check ─────────────────────────────────────────────────────

  /**
   * Check if a partner is eligible for a scheme.
   * Rules:
   *  - No eligibility rows → everyone eligible
   *  - Inclusion rows present → partner must match at least one
   *  - Exclusion rows → partner must NOT match any
   */
  async isPartnerEligible(
    schemeId:         string,
    partnerId:        string,
    partnerClassCode: string,
  ): Promise<boolean> {
    const rules = await this.prisma.schemeEligibility.findMany({
      where: { schemeId },
    });

    if (rules.length === 0) return true;

    const exclusions = rules.filter(r => r.isExclusion);
    const inclusions = rules.filter(r => !r.isExclusion);

    // Explicit exclusion
    const excluded = exclusions.some(
      r => r.partnerClassCode === partnerClassCode || r.specificPartnerId === partnerId,
    );
    if (excluded) return false;

    // If inclusion rules exist, partner must match one
    if (inclusions.length > 0) {
      return inclusions.some(
        r => r.partnerClassCode === partnerClassCode || r.specificPartnerId === partnerId,
      );
    }

    return true;
  }

  // ── Points calculation (pure) ─────────────────────────────────────────────

  /**
   * @param amountPaise       Invoice net amount in paise
   * @param pointsPerRupee    Rate (e.g. 1 = 1 pt per ₹1)
   * @param fixedPoints       If set, overrides rate-based calculation
   * @param maxPointsPerCycle Cap per scheme cycle
   */
  calculateEarnedPoints(
    amountPaise:        number,
    pointsPerRupee:     number,
    fixedPoints?:       number,
    maxPointsPerCycle?: number,
  ): number {
    let points: number;

    if (fixedPoints !== undefined) {
      points = fixedPoints;
    } else {
      const rupees = amountPaise / 100;
      points = Math.floor(rupees * pointsPerRupee);
    }

    if (maxPointsPerCycle !== undefined) {
      points = Math.min(points, maxPointsPerCycle);
    }

    return points;
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listSchemes(
    clientId: string,
    opts: { status?: string; page?: number; limit?: number } = {},
  ) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;
    const where: any = { clientId, deletedAt: null };
    if (opts.status) where.status = opts.status;

    const [data, total] = await Promise.all([
      this.prisma.scheme.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { rules: true, eligibility: true },
      }),
      this.prisma.scheme.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async findOrThrow(schemeId: string, clientId: string): Promise<Scheme> {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, clientId, deletedAt: null },
    });
    if (!scheme) throw new NotFoundException(`Scheme ${schemeId} not found.`);
    return scheme;
  }
}
