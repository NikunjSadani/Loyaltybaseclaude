import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator } from '../common/tenant-scope';
import {
  CreateGiftCategoryDto,
  CreateGiftMasterDto,
  ListGiftMastersQueryDto,
  PublishGiftMasterDto,
  UpdateGiftCategoryDto,
  UpdateGiftMasterDto,
} from './dto/gift-catalogue.dto';

/**
 * Gift Catalogue (Wave 1) — the PLATFORM master + shared taxonomy + publish-to-tenant
 * pipeline. Gifsy-operator-only at the DATA BOUNDARY: every method re-checks
 * isGifsyOperator (defence-in-depth behind the controller @Roles). Vendor authoring
 * is Wave 2 and deliberately absent here (clear seams left inline).
 *
 * Publish maps a GiftMaster into per-tenant RewardCatalog rows (Option R, §3): the
 * SAME row members browse and orders FK — so live redemptions are untouched. Master
 * CONTENT edits propagate to published rows; the per-tenant ₹ selling price / points
 * cost are NEVER auto-overwritten (§4).
 */
@Injectable()
export class GiftCatalogueService {
  private readonly logger = new Logger(GiftCatalogueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /** Data-boundary guard — Gifsy operator (owner or permission-gated staff) only. */
  private assertOperator(user: JwtPayload) {
    if (!isGifsyOperator(user)) {
      throw new ForbiddenException('Gift catalogue administration is Gifsy-operator only');
    }
  }

  // ── Wire mappers (list → { items }; detail → FLAT) ──────────────────────────
  // The FE mirrors `fulfilmentChannel` (stored as the `defaultFulfilmentChannel`
  // column) and `categoryName` (from the joined category); imageUrls is a string[].

  /** GiftMasterSummary row for the list. */
  private toMasterSummary(m: {
    id: string;
    code: string;
    name: string;
    categoryId: string;
    mrpPaise: number | null;
    redemptionMode: unknown;
    defaultFulfilmentChannel: unknown;
    status: unknown;
    stockQuantity: number | null;
    imageUrls: unknown;
    updatedAt?: Date;
    category?: { name: string } | null;
    _count?: { catalogItems: number };
  }) {
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      categoryId: m.categoryId,
      categoryName: m.category?.name ?? null,
      mrpPaise: m.mrpPaise,
      redemptionMode: m.redemptionMode,
      fulfilmentChannel: m.defaultFulfilmentChannel,
      status: m.status,
      stockQuantity: m.stockQuantity,
      imageUrls: Array.isArray(m.imageUrls) ? m.imageUrls : [],
      publishedTenantCount: m._count?.catalogItems,
      updatedAt: m.updatedAt,
    };
  }

  /** Flat GiftMasterDetail (summary + description + T&C). */
  private toMasterDetail(m: {
    id: string;
    code: string;
    name: string;
    categoryId: string;
    mrpPaise: number | null;
    redemptionMode: unknown;
    defaultFulfilmentChannel: unknown;
    status: unknown;
    stockQuantity: number | null;
    imageUrls: unknown;
    updatedAt?: Date;
    description: string | null;
    termsAndConditions: string | null;
    category?: { name: string } | null;
  }) {
    return {
      ...this.toMasterSummary(m),
      description: m.description ?? '',
      termsAndConditions: m.termsAndConditions ?? '',
    };
  }

  // ── GiftCategory (platform shared taxonomy) ────────────────────────────────

  async createCategory(user: JwtPayload, dto: CreateGiftCategoryDto) {
    this.assertOperator(user);
    if (dto.parentId) {
      const parent = await this.prisma.giftCategory.findFirst({ where: { id: dto.parentId } });
      if (!parent) throw new BadRequestException('Parent gift category not found');
    }
    const clash = await this.prisma.giftCategory.findFirst({ where: { code: dto.code } });
    if (clash) throw new ConflictException('A gift category with this code already exists');

    const category = await this.prisma.giftCategory.create({
      data: {
        parentId: dto.parentId ?? null,
        code: dto.code,
        name: dto.name,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    return category;
  }

  async listCategories(user: JwtPayload) {
    this.assertOperator(user);
    const items = await this.prisma.giftCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return { items };
  }

  async updateCategory(user: JwtPayload, id: string, dto: UpdateGiftCategoryDto) {
    this.assertOperator(user);
    const existing = await this.prisma.giftCategory.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Gift category not found');
    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) throw new BadRequestException('A category cannot be its own parent');
      const parent = await this.prisma.giftCategory.findFirst({ where: { id: dto.parentId } });
      if (!parent) throw new BadRequestException('Parent gift category not found');
    }
    if (dto.code !== undefined && dto.code !== existing.code) {
      const clash = await this.prisma.giftCategory.findFirst({ where: { code: dto.code } });
      if (clash) throw new ConflictException('A gift category with this code already exists');
    }
    const category = await this.prisma.giftCategory.update({
      where: { id },
      data: {
        code: dto.code,
        name: dto.name,
        parentId: dto.parentId,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });
    return category;
  }

  /**
   * Delete a gift category (hard delete). Blocked when it still has child categories
   * or any GiftMaster filed under it — the FE guards children client-side, but the BE
   * is the source of truth so we re-check both here.
   */
  async deleteCategory(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const existing = await this.prisma.giftCategory.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Gift category not found');

    const children = await this.prisma.giftCategory.count({ where: { parentId: id } });
    if (children > 0) {
      throw new ConflictException('Move or delete its sub-categories before deleting this category');
    }
    const inUse = await this.prisma.giftMaster.count({ where: { categoryId: id, deletedAt: null } });
    if (inUse > 0) {
      throw new ConflictException('This category is in use by one or more gift masters');
    }
    await this.prisma.giftCategory.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ── GiftMaster CRUD ─────────────────────────────────────────────────────────

  async createMaster(user: JwtPayload, dto: CreateGiftMasterDto) {
    this.assertOperator(user);
    const category = await this.prisma.giftCategory.findFirst({ where: { id: dto.categoryId } });
    if (!category) throw new BadRequestException('Gift category not found');

    const clash = await this.prisma.giftMaster.findFirst({
      where: { code: dto.code, deletedAt: null },
    });
    if (clash) throw new ConflictException('A gift master with this code already exists');

    const master = await this.prisma.giftMaster.create({
      data: {
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        mrpPaise: dto.mrpPaise,
        redemptionMode: dto.redemptionMode,
        defaultFulfilmentChannel: dto.fulfilmentChannel,
        termsAndConditions: dto.termsAndConditions,
        stockQuantity: dto.stockQuantity,
        status: dto.status,
        createdByUserId: user.sub,
      },
      include: { category: { select: { name: true } } },
    });
    return this.toMasterDetail(master);
  }

  async listMasters(user: JwtPayload, q: ListGiftMastersQueryDto) {
    this.assertOperator(user);
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const skip = (page - 1) * limit;
    const where: Prisma.GiftMasterWhereInput = { deletedAt: null };
    if (q.status) where.status = q.status;
    if (q.categoryId) where.categoryId = q.categoryId;

    const [masters, total] = await Promise.all([
      this.prisma.giftMaster.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, code: true } },
          _count: { select: { catalogItems: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.giftMaster.count({ where }),
    ]);
    return {
      items: masters.map((m) => this.toMasterSummary(m)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getMaster(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const master = await this.prisma.giftMaster.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: { select: { id: true, name: true, code: true } },
      },
    });
    if (!master) throw new NotFoundException('Gift master not found');
    return this.toMasterDetail(master);
  }

  /**
   * Update a GiftMaster. CONTENT edits (name/description/images/mrp/mode/T&C/category)
   * PROPAGATE to every published RewardCatalog row; the per-tenant selling price /
   * pointsCost / row status are NEVER touched here (§4). A category change also
   * re-maps each tenant row's giftCategoryId + re-ensures the mirrored RewardCategory.
   */
  async updateMaster(user: JwtPayload, id: string, dto: UpdateGiftMasterDto) {
    this.assertOperator(user);
    const existing = await this.prisma.giftMaster.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundException('Gift master not found');

    if (dto.categoryId !== undefined) {
      const category = await this.prisma.giftCategory.findFirst({ where: { id: dto.categoryId } });
      if (!category) throw new BadRequestException('Gift category not found');
    }
    if (dto.code !== undefined && dto.code !== existing.code) {
      const clash = await this.prisma.giftMaster.findFirst({
        where: { code: dto.code, deletedAt: null, id: { not: id } },
      });
      if (clash) throw new ConflictException('A gift master with this code already exists');
    }

    const master = await this.prisma.giftMaster.update({
      where: { id },
      data: {
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        mrpPaise: dto.mrpPaise,
        redemptionMode: dto.redemptionMode,
        defaultFulfilmentChannel: dto.fulfilmentChannel,
        termsAndConditions: dto.termsAndConditions,
        stockQuantity: dto.stockQuantity,
        status: dto.status,
      },
      include: { category: { select: { name: true } } },
    });

    // Propagate CONTENT (never price) to published rows.
    const contentPatch: Prisma.RewardCatalogUpdateManyMutationInput = {};
    if (dto.name !== undefined) contentPatch.name = dto.name;
    if (dto.description !== undefined) contentPatch.description = dto.description;
    if (dto.imageUrls !== undefined) {
      contentPatch.imageUrls = (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined;
    }
    if (dto.mrpPaise !== undefined) contentPatch.mrpPaise = dto.mrpPaise;
    if (dto.redemptionMode !== undefined) contentPatch.redemptionMode = dto.redemptionMode;
    if (dto.termsAndConditions !== undefined) {
      contentPatch.termsAndConditions = dto.termsAndConditions;
    }
    if (Object.keys(contentPatch).length > 0) {
      await this.prisma.rewardCatalog.updateMany({
        where: { giftMasterId: id, deletedAt: null },
        data: contentPatch,
      });
    }

    // Category change → re-map each tenant row's giftCategoryId + mirrored RewardCategory.
    if (dto.categoryId !== undefined && dto.categoryId !== existing.categoryId) {
      const giftCat = await this.prisma.giftCategory.findFirst({ where: { id: dto.categoryId } });
      const rows = await this.prisma.rewardCatalog.findMany({
        where: { giftMasterId: id, deletedAt: null },
        select: { id: true, clientId: true },
      });
      for (const row of rows) {
        const rewardCategoryId = giftCat
          ? await this.ensureTenantRewardCategory(row.clientId, giftCat)
          : undefined;
        await this.prisma.rewardCatalog.update({
          where: { id: row.id },
          data: {
            giftCategoryId: dto.categoryId,
            ...(rewardCategoryId ? { categoryId: rewardCategoryId } : {}),
          },
        });
      }
    }

    return this.toMasterDetail(master);
  }

  /**
   * Archive a GiftMaster (status ARCHIVED) and HIDE its published rows (status
   * DISCONTINUED → dropped from the member catalogue, which filters status=ACTIVE).
   * In-flight orders continue: they FK the RewardCatalog row, which is not deleted.
   */
  async archiveMaster(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const existing = await this.prisma.giftMaster.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundException('Gift master not found');

    const [master, hidden] = await this.prisma.$transaction([
      this.prisma.giftMaster.update({ where: { id }, data: { status: 'ARCHIVED' } }),
      this.prisma.rewardCatalog.updateMany({
        where: { giftMasterId: id, deletedAt: null },
        data: { status: 'DISCONTINUED' },
      }),
    ]);
    return { master, hiddenRows: hidden.count };
  }

  // ── Publish-to-tenant(s) ─────────────────────────────────────────────────────

  /**
   * GET the per-tenant publish + pricing MATRIX for a master. One row PER CANDIDATE
   * tenant with its conversionRate (points-per-₹, so the FE can show the ₹→points
   * derivation), whether it is currently published (a live/ACTIVE RewardCatalog row
   * for this master), and the current stored ₹ price + points cost.
   */
  async getPublishMatrix(user: JwtPayload, masterId: string) {
    this.assertOperator(user);
    const master = await this.prisma.giftMaster.findFirst({
      where: { id: masterId, deletedAt: null },
      select: { id: true },
    });
    if (!master) throw new NotFoundException('Gift master not found');

    const [clients, rows] = await Promise.all([
      this.prisma.client.findMany({
        // Exclude the Gifsy operator tenant — it is never a publish TARGET (it owns no
        // member catalogue / partners), so it must not appear as a candidate row.
        where: { status: 'ACTIVE', id: { not: 'gifsy' } },
        select: { id: true, internalName: true },
        orderBy: { internalName: 'asc' },
      }),
      this.prisma.rewardCatalog.findMany({
        where: { giftMasterId: masterId, deletedAt: null },
        select: { clientId: true, status: true, sellingValuePaise: true, pointsCost: true },
      }),
    ]);
    const byClient = new Map(rows.map((r) => [r.clientId, r]));

    const items = await Promise.all(
      clients.map(async (c) => {
        const row = byClient.get(c.id);
        const conversionRate = await this.tenantSettings.getConversionRate(c.id);
        return {
          clientId: c.id,
          clientName: c.internalName,
          conversionRate,
          published: !!row && row.status !== 'DISCONTINUED',
          sellingValuePaise: row?.sellingValuePaise ?? null,
          pointsCost: row?.pointsCost ?? null,
        };
      }),
    );
    return { items };
  }

  /**
   * Publish/re-price a GiftMaster to tenants and/or unpublish it from others.
   *
   * The publish DIALOG is the per-tenant PRICE EDITOR, so a publication's explicit
   * sellingValuePaise / pointsCost IS applied on BOTH first publish and re-publish
   * (favouring the FE contract). pointsCost is derived from the tenant conversion rate
   * (points = ₹ × rate) when not supplied. Master CONTENT (name/desc/images/…) is
   * refreshed onto the row too; content-only propagation from a master EDIT still lives
   * in `updateMaster` (which never touches price). Unpublished tenants keep their row
   * (DISCONTINUED) so in-flight orders survive.
   */
  async publish(user: JwtPayload, masterId: string, dto: PublishGiftMasterDto) {
    this.assertOperator(user);
    const master = await this.prisma.giftMaster.findFirst({
      where: { id: masterId, deletedAt: null },
      include: { category: true },
    });
    if (!master) throw new NotFoundException('Gift master not found');
    if (master.status === 'ARCHIVED') {
      throw new BadRequestException('Cannot publish an archived gift master');
    }

    const publications = dto.publications ?? [];
    const unpublishClientIds = dto.unpublishClientIds ?? [];

    const results: Array<{
      clientId: string;
      catalogItemId?: string;
      action: 'created' | 'updated' | 'unpublished' | 'skipped';
      sellingValuePaise?: number | null;
      pointsCost?: number;
      error?: string;
    }> = [];

    for (const target of publications) {
      try {
        const rewardCategoryId = await this.ensureTenantRewardCategory(
          target.clientId,
          master.category,
        );

        const existing = await this.prisma.rewardCatalog.findFirst({
          where: { clientId: target.clientId, giftMasterId: masterId, deletedAt: null },
        });

        // Resolve the price to apply. On CREATE sellingValuePaise is required; on
        // re-publish an omitted price keeps the stored one.
        const rate = await this.tenantSettings.getConversionRate(target.clientId);
        const sellingValuePaise = target.sellingValuePaise ?? existing?.sellingValuePaise ?? null;
        if (sellingValuePaise == null) {
          throw new BadRequestException(
            'sellingValuePaise is required to publish this gift to a tenant for the first time',
          );
        }

        if (existing) {
          // Re-publish → refresh CONTENT + apply an EXPLICITLY-sent price.
          //
          // pointsCost: an explicit target.pointsCost IS applied (the publish dialog is
          // the price editor); when OMITTED, PRESERVE the stored pointsCost — do NOT
          // silently re-derive from the CURRENT rate, which would shift the member price
          // on any rate drift since first publish. Derivation happens only on first
          // create (below).
          const pointsCost = target.pointsCost ?? existing.pointsCost;
          // status: do NOT force ACTIVE unconditionally — that would un-hide a deliberately
          // paused / OUT_OF_STOCK row. Re-activate ONLY a previously-unpublished
          // (DISCONTINUED) row, which is exactly the intent of re-publishing an unpublished
          // item; every other status is left untouched.
          const reactivate =
            existing.status === 'DISCONTINUED' ? { status: 'ACTIVE' as const } : {};
          const updated = await this.prisma.rewardCatalog.update({
            where: { id: existing.id },
            data: {
              categoryId: rewardCategoryId,
              giftCategoryId: master.categoryId,
              name: master.name,
              description: master.description,
              imageUrls: (master.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
              mrpPaise: master.mrpPaise,
              redemptionMode: master.redemptionMode,
              termsAndConditions: master.termsAndConditions,
              sellingValuePaise,
              pointsCost,
              ...reactivate,
            },
          });
          results.push({
            clientId: target.clientId,
            catalogItemId: updated.id,
            action: 'updated',
            sellingValuePaise: updated.sellingValuePaise,
            pointsCost: updated.pointsCost,
          });
          continue;
        }

        // First create → derive pointsCost from the tenant rate when not explicitly supplied.
        const pointsCost = target.pointsCost ?? this.derivePointsCost(sellingValuePaise, rate);

        // Code uniqueness per tenant (non-deleted) — the reused member CRUD enforces
        // this app-side; keep parity so publish can't create a duplicate code.
        const codeClash = await this.prisma.rewardCatalog.findFirst({
          where: { clientId: target.clientId, code: master.code, deletedAt: null },
        });
        if (codeClash) {
          throw new ConflictException(
            `A catalog item with code "${master.code}" already exists in ${target.clientId}`,
          );
        }

        const created = await this.prisma.rewardCatalog.create({
          data: {
            clientId: target.clientId,
            categoryId: rewardCategoryId,
            giftCategoryId: master.categoryId,
            giftMasterId: masterId,
            sourceType: 'PLATFORM',
            moderationStatus: 'APPROVED', // platform items are auto-live (decision 2)
            code: master.code,
            name: master.name,
            description: master.description,
            imageUrls: (master.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
            pointsCost,
            sellingValuePaise,
            mrpPaise: master.mrpPaise,
            redemptionMode: master.redemptionMode,
            termsAndConditions: master.termsAndConditions,
            stockQuantity: master.stockQuantity,
            status: 'ACTIVE',
          },
        });
        results.push({
          clientId: target.clientId,
          catalogItemId: created.id,
          action: 'created',
          sellingValuePaise: created.sellingValuePaise,
          pointsCost: created.pointsCost,
        });
      } catch (e) {
        results.push({
          clientId: target.clientId,
          action: 'skipped',
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }

    // Unpublish: DISCONTINUE the tenant's row (in-flight orders keep their FK).
    for (const clientId of unpublishClientIds) {
      try {
        const res = await this.prisma.rewardCatalog.updateMany({
          where: { clientId, giftMasterId: masterId, deletedAt: null },
          data: { status: 'DISCONTINUED' },
        });
        if (res.count > 0) {
          results.push({ clientId, action: 'unpublished' });
        }
      } catch (e) {
        results.push({
          clientId,
          action: 'skipped',
          error: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }

    return {
      masterId,
      published: results.filter((r) => r.action === 'created' || r.action === 'updated').length,
      unpublished: results.filter((r) => r.action === 'unpublished').length,
      failed: results.filter((r) => r.action === 'skipped').length,
      results,
    };
  }

  // ── Vendor-item moderation queue (Wave 1: wired, typically EMPTY until Wave 2) ──

  /**
   * List per-tenant catalogue rows awaiting moderation (moderationStatus=PENDING).
   * Vendor-sourced items land here in Wave 2; in Wave 1 this is usually empty (platform
   * rows are auto-APPROVED). Returns member-agnostic ops rows for the review table.
   */
  async listModeration(user: JwtPayload) {
    this.assertOperator(user);
    const rows = await this.prisma.rewardCatalog.findMany({
      where: { moderationStatus: 'PENDING', deletedAt: null },
      include: {
        vendor: { select: { name: true } },
        giftCategory: { select: { name: true } },
        category: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const clientIds = [...new Set(rows.map((r) => r.clientId))];
    const clients = clientIds.length
      ? await this.prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, internalName: true },
        })
      : [];
    const clientName = new Map(clients.map((c) => [c.id, c.internalName]));

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      vendorName: r.vendor?.name ?? null,
      clientName: clientName.get(r.clientId) ?? r.clientId,
      sellingValuePaise: r.sellingValuePaise ?? 0,
      mrpPaise: r.mrpPaise ?? null,
      imageUrl: Array.isArray(r.imageUrls) && r.imageUrls.length > 0 ? String(r.imageUrls[0]) : null,
      categoryName: r.giftCategory?.name ?? r.category?.name ?? null,
      moderationStatus: r.moderationStatus,
      submittedAt: r.createdAt,
    }));
    return { items };
  }

  /** Approve a pending moderation row → APPROVED (redeemable). */
  async approveModeration(user: JwtPayload, id: string) {
    this.assertOperator(user);
    const row = await this.prisma.rewardCatalog.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException('Catalogue item not found');
    const updated = await this.prisma.rewardCatalog.update({
      where: { id },
      data: {
        moderationStatus: 'APPROVED',
        moderationByUserId: user.sub,
        moderatedAt: new Date(),
        moderationReason: null,
        status: 'ACTIVE',
      },
    });
    return { id: updated.id, moderationStatus: updated.moderationStatus };
  }

  /** Reject a pending moderation row → REJECTED (dropped from the member catalogue). */
  async rejectModeration(user: JwtPayload, id: string, reason: string) {
    this.assertOperator(user);
    if (!reason || !reason.trim()) {
      throw new BadRequestException('A rejection reason is required');
    }
    const row = await this.prisma.rewardCatalog.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException('Catalogue item not found');
    const updated = await this.prisma.rewardCatalog.update({
      where: { id },
      data: {
        moderationStatus: 'REJECTED',
        moderationByUserId: user.sub,
        moderatedAt: new Date(),
        moderationReason: reason.trim(),
        status: 'INACTIVE',
      },
    });
    return { id: updated.id, moderationStatus: updated.moderationStatus };
  }

  /**
   * pointsCost from a ₹ selling price. value(₹) = points ÷ rate (rate = points-per-₹),
   * so points = ₹ × rate. sellingValuePaise/100 = ₹. rate 0/misconfig → 0.
   */
  derivePointsCost(sellingValuePaise: number, rate: number): number {
    if (!rate || rate <= 0) return 0;
    return Math.round((sellingValuePaise / 100) * rate);
  }

  /**
   * Ensure a per-tenant RewardCategory mirroring the platform GiftCategory exists
   * (matched by code). The RewardCatalog.categoryId FK is non-null and per-tenant, so
   * a published platform gift needs a tenant RewardCategory; giftCategoryId links the
   * shared taxonomy in parallel (additive, §7). Returns the RewardCategory id.
   */
  private async ensureTenantRewardCategory(
    clientId: string,
    giftCat: { code: string; name: string; imageUrl: string | null; sortOrder: number },
  ): Promise<string> {
    const existing = await this.prisma.rewardCategory.findFirst({
      where: { clientId, code: giftCat.code },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.rewardCategory.create({
      data: {
        clientId,
        code: giftCat.code,
        name: giftCat.name,
        imageUrl: giftCat.imageUrl,
        sortOrder: giftCat.sortOrder,
        isActive: true,
      },
      select: { id: true },
    });
    return created.id;
  }
}
