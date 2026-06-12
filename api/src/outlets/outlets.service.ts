import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Outlet } from '@prisma/client';

interface CreateOutletDto {
  partnerId:    string;
  outletTypeId: string;
  name:         string;
  ownerName?:   string;
  phone?:       string;
  addressLine1: string;
  addressLine2?: string;
  city:         string;
  district?:    string;
  state:        string;
  pincode:      string;
  latitude?:    number;
  longitude?:   number;
}

@Injectable()
export class OutletsService {
  private readonly logger = new Logger(OutletsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async createOutlet(dto: CreateOutletDto): Promise<Outlet> {
    const partner = await this.prisma.channelPartner.findFirst({
      where: { id: dto.partnerId, deletedAt: null },
    });
    if (!partner) throw new NotFoundException('Partner not found.');

    const outletType = await this.prisma.outletType.findFirst({
      where: { id: dto.outletTypeId, isActive: true },
    });
    if (!outletType) throw new NotFoundException('Outlet type not found.');

    // First outlet for this partner → auto-primary
    const existingPrimary = await this.prisma.outlet.findFirst({
      where: { partnerId: dto.partnerId, isPrimary: true, deletedAt: null },
    });
    const isPrimary = !existingPrimary;

    const outletCode = this.generateOutletCode(outletType.code);

    const outlet = await this.prisma.outlet.create({
      data: {
        partnerId:    dto.partnerId,
        outletTypeId: dto.outletTypeId,
        outletCode,
        name:         dto.name,
        ownerName:    dto.ownerName ?? null,
        phone:        dto.phone ?? null,
        addressLine1: dto.addressLine1,
        addressLine2: dto.addressLine2 ?? null,
        city:         dto.city,
        district:     dto.district ?? null,
        state:        dto.state,
        pincode:      dto.pincode,
        latitude:     dto.latitude ?? null,
        longitude:    dto.longitude ?? null,
        isPrimary,
      },
    });

    this.logger.log(`Outlet created: ${outletCode} for partner ${dto.partnerId}`);
    return outlet;
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listOutlets(opts: {
    partnerId?: string;
    state?:     string;
    isActive?:  boolean;
    page?:      number;
    limit?:     number;
  } = {}) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const skip  = (page - 1) * limit;
    const where: any = { deletedAt: null };

    if (opts.partnerId)             where.partnerId = opts.partnerId;
    if (opts.state)                 where.state     = opts.state;
    if (opts.isActive !== undefined) where.isActive  = opts.isActive;

    const [data, total] = await Promise.all([
      this.prisma.outlet.findMany({
        where, skip, take: limit,
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        include: { outletType: true },
      }),
      this.prisma.outlet.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  // ── Get by ID ─────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Outlet> {
    const outlet = await this.prisma.outlet.findFirst({
      where: { id, deletedAt: null },
    });
    if (!outlet) throw new NotFoundException(`Outlet ${id} not found.`);
    return outlet;
  }

  // ── Soft delete ───────────────────────────────────────────────────────────

  async deleteOutlet(id: string, partnerId: string): Promise<void> {
    const outlet = await this.prisma.outlet.findFirst({
      where: { id, partnerId, deletedAt: null },
    });
    if (!outlet) throw new NotFoundException('Outlet not found.');

    if (outlet.isPrimary) {
      throw new BadRequestException(
        'Cannot delete the primary outlet. Set another outlet as primary first.',
      );
    }

    await this.prisma.outlet.update({
      where: { id },
      data:  { deletedAt: new Date(), isActive: false },
    });
  }

  // ── Code generation ───────────────────────────────────────────────────────

  generateOutletCode(outletTypeCode: string): string {
    const ts  = Date.now().toString(36).toUpperCase().slice(-4);
    const rnd = Math.random().toString(36).toUpperCase().slice(2, 5);
    return `${outletTypeCode}-${ts}${rnd}`;
  }
}
