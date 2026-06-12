import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Sku } from '@prisma/client';

interface CreateSkuDto {
  clientId:          string;
  skuCode:           string;
  name:              string;
  description?:      string;
  brand?:            string;
  uom:               string;
  packSize?:         number;
  mrpPaise:          number;
  dealerPricePaise?: number;
  imageUrl?:         string;
  isTaxable?:        boolean;
  hsn?:              string;
  gstRate?:          number;
  categoryIds?:      string[];
}

@Injectable()
export class SkusService {
  private readonly logger = new Logger(SkusService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async createSku(dto: CreateSkuDto): Promise<Sku> {
    const conflict = await this.prisma.sku.findFirst({
      where: { clientId: dto.clientId, skuCode: dto.skuCode, deletedAt: null },
    });
    if (conflict) {
      throw new ConflictException(`SKU code "${dto.skuCode}" already exists for this client.`);
    }

    const sku = await this.prisma.sku.create({
      data: {
        clientId:          dto.clientId,
        skuCode:           dto.skuCode,
        name:              dto.name,
        description:       dto.description ?? null,
        brand:             dto.brand ?? null,
        uom:               dto.uom,
        packSize:          dto.packSize ?? null,
        mrpPaise:          dto.mrpPaise,
        dealerPricePaise:  dto.dealerPricePaise ?? null,
        imageUrl:          dto.imageUrl ?? null,
        isTaxable:         dto.isTaxable ?? true,
        hsn:               dto.hsn ?? null,
        gstRate:           dto.gstRate ?? null,
      },
    });

    // Optional category mappings
    if (dto.categoryIds?.length) {
      await this.prisma.skuCategoryMapping.createMany({
        data: dto.categoryIds.map((catId, idx) => ({
          skuId:      sku.id,
          categoryId: catId,
          isPrimary:  idx === 0,
        })),
        skipDuplicates: true,
      });
    }

    this.logger.log(`SKU created: ${dto.skuCode} (${dto.clientId})`);
    return sku;
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listSkus(
    clientId: string,
    opts: { brand?: string; isActive?: boolean; page?: number; limit?: number } = {},
  ) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const skip  = (page - 1) * limit;
    const where: any = { clientId, deletedAt: null };

    if (opts.brand)                 where.brand    = opts.brand;
    if (opts.isActive !== undefined) where.isActive = opts.isActive;

    const [data, total] = await Promise.all([
      this.prisma.sku.findMany({
        where, skip, take: limit,
        orderBy: { name: 'asc' },
        include: { categoryMappings: { include: { category: true } } },
      }),
      this.prisma.sku.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  // ── Find by code ──────────────────────────────────────────────────────────

  async findByCode(skuCode: string, clientId: string): Promise<Sku> {
    const sku = await this.prisma.sku.findFirst({
      where: { skuCode, clientId, deletedAt: null },
    });
    if (!sku) throw new NotFoundException(`SKU "${skuCode}" not found.`);
    return sku;
  }

  // ── Find by ID ────────────────────────────────────────────────────────────

  async findById(id: string, clientId: string): Promise<Sku> {
    const sku = await this.prisma.sku.findFirst({
      where: { id, clientId, deletedAt: null },
    });
    if (!sku) throw new NotFoundException(`SKU ${id} not found.`);
    return sku;
  }

  // ── Soft delete ───────────────────────────────────────────────────────────

  async deleteSku(id: string, clientId: string): Promise<void> {
    const sku = await this.prisma.sku.findFirst({
      where: { id, clientId, deletedAt: null },
    });
    if (!sku) throw new NotFoundException('SKU not found.');

    await this.prisma.sku.update({
      where: { id },
      data:  { deletedAt: new Date(), isActive: false },
    });
  }
}
