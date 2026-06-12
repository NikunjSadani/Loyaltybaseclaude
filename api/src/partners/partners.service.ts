import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelPartner } from '@prisma/client';
import { AuthService } from '../auth/auth.service';

const CLASS_PREFIX: Record<string, string> = {
  CP_01: 'RT',  // Retailer
  CP_02: 'WS',  // Wholesaler
  CP_03: 'SS',  // Sub-Stockist
};

interface CreatePartnerDto {
  clientId:        string;
  userId:          string;
  partnerClassCode: string;
  businessName:    string;
  ownerName:       string;
  phone:           string;
  email?:          string;
  gstNumber?:      string;
  panNumber?:      string;
}

@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Create ───────────────────────────────────────────────────────────────────

  async createPartner(dto: CreatePartnerDto): Promise<ChannelPartner> {
    // Check user exists and belongs to client
    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, clientId: dto.clientId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('User not found for this client.');

    // Check no duplicate partner for this user
    const existing = await this.prisma.channelPartner.findFirst({
      where: { userId: dto.userId },
    });
    if (existing) throw new ConflictException('A partner profile already exists for this user.');

    // Resolve partner class config
    const partnerClass = await this.prisma.partnerClassConfig.findFirst({
      where: { code: dto.partnerClassCode as any, clientId: dto.clientId },
    });
    if (!partnerClass) throw new NotFoundException(`Partner class ${dto.partnerClassCode} not found.`);

    const partnerCode = this.generatePartnerCode(dto.partnerClassCode, dto.clientId);

    const partner = await this.prisma.channelPartner.create({
      data: {
        clientId:       dto.clientId,
        userId:         dto.userId,
        partnerClassId: partnerClass.id,
        partnerCode,
        businessName:   dto.businessName,
        ownerName:      dto.ownerName,
        phone:          dto.phone,
        email:          dto.email,
        gstNumber:      dto.gstNumber,
        panNumber:      dto.panNumber,
      },
    });

    // Auto-create wallet for new partner (always starts at 0)
    await this.prisma.wallet.create({
      data: { partnerId: partner.id },
    });

    this.logger.log(`Partner created: ${partnerCode} (client: ${dto.clientId})`);
    return partner;
  }

  // ── Read ─────────────────────────────────────────────────────────────────────

  async findById(id: string, clientId: string): Promise<ChannelPartner> {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { id, clientId, deletedAt: null },
    });
    if (!partner) throw new NotFoundException('Partner not found.');
    return partner;
  }

  async findByUserId(userId: string, clientId: string): Promise<ChannelPartner | null> {
    return this.prisma.channelPartner.findFirst({
      where: { userId, clientId, deletedAt: null },
    });
  }

  async listPartners(
    clientId: string,
    opts: { partnerClassCode?: string; isActive?: boolean; page?: number; limit?: number } = {},
  ) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;

    const where: any = { clientId, deletedAt: null };
    if (opts.isActive !== undefined) where.isActive = opts.isActive;

    const [data, total] = await Promise.all([
      this.prisma.channelPartner.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: { partnerClass: true, currentTier: true },
      }),
      this.prisma.channelPartner.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  // ── Points helpers ────────────────────────────────────────────────────────────

  /**
   * Convert paise to loyalty points.
   * Business rule: 1 point = ₹1 = 100 paise
   */
  paiseToPoints(paise: number): number {
    return Math.floor(paise / AuthService.POINTS_TO_PAISE);
  }

  // ── Code generation ───────────────────────────────────────────────────────────

  generatePartnerCode(partnerClassCode: string, clientId: string): string {
    const prefix    = CLASS_PREFIX[partnerClassCode] ?? 'PT';
    const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
    const random    = Math.random().toString(36).toUpperCase().slice(2, 5);
    return `${prefix}-${timestamp}${random}`;
  }
}
