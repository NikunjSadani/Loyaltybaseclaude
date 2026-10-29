import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GiftAmountType, PayoutMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { derivePointsCost as derivePointsCostHelper } from '../rewards/derive-points-cost.helper';
import { isGifsyOperator, platformWide, tenantScope } from '../common/tenant-scope';
import { sniffFileType } from '../common/file-signature';
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
    private readonly storage: StorageService,
  ) {}

  /** Data-boundary guard — Gifsy operator (owner or permission-gated staff) only. */
  private assertOperator(user: JwtPayload) {
    if (!isGifsyOperator(user)) {
      throw new ForbiddenException('Gift catalogue administration is Gifsy-operator only');
    }
  }

  /** The bucket prefix all gift images live under; serveGiftImage refuses any key
   *  outside it, so this endpoint can never be used to read arbitrary objects. */
  private static readonly GIFT_IMAGE_PREFIX = 'gift-catalogue/';
  /** The browser-renderable image types this feature accepts + serves inline. */
  private static readonly RENDERABLE_MIME = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ]);

  /**
   * Upload a gift image and return an AUTH-GATED PROXY PATH the browser renders via
   * serveGiftImage below. The uploads bucket (`gifsy-platform-files`) is PRIVATE
   * (uniform bucket-level access, no allUsers grant — it also holds KYC docs + POSM
   * photos), so a raw `storage.googleapis.com` URL 403s in a browser. We therefore
   * follow the KYC/visibility posture — store privately, stream through the API — NOT
   * a public URL. (The `publicUrl()` name on StorageService is a misnomer; the object
   * is private.) No schema change: imageUrls already holds strings; it now holds the
   * proxy path instead of a bucket URL.
   *
   * The key is TENANT-FOLDED: un-assumed GIFSY (master catalogue) → `_platform/`
   * (world-readable within the portal, which master gift content is); every other
   * caller (a CLIENT_ADMIN, or an assumed operator) → its own `<clientId>/` folder,
   * so serveGiftImage can enforce tenant from the path.
   *
   * DELIBERATELY NOT assertOperator: this one endpoint serves BOTH the GIFSY-only
   * master editor (/admin/gift-catalogue) AND the per-tenant reward editor (/admin/gifts),
   * whose reward-catalog CRUD admits CLIENT_ADMIN. The controller
   * @Roles('GIFSY_ADMIN','CLIENT_ADMIN') gate is the boundary.
   */
  async uploadGiftImage(user: JwtPayload, file: Express.Multer.File): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.buffer?.length) throw new BadRequestException('Empty file');

    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — matches branding + visibility uploads
    if (file.size > MAX_BYTES) throw new BadRequestException('File too large (max 5 MB)');

    // Untrusted client mimetype: derive the REAL type from the bytes and require a
    // BROWSER-RENDERABLE image. sniffFileType also recognises TIFF/BMP/HEIC (which no
    // mainstream <img> renders → a stored-but-broken thumbnail), so restrict to the
    // exact four the FE offers rather than any image/*. Also rejects PDF/SVG/HTML.
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed || !GiftCatalogueService.RENDERABLE_MIME.has(sniffed.mime)) {
      throw new BadRequestException(
        'Unsupported or corrupt file. Upload a PNG, JPG, WEBP, or GIF image.',
      );
    }

    const scope = platformWide(user) ? '_platform' : user.clientId;
    const key = this.storage.generateKey(
      `${GiftCatalogueService.GIFT_IMAGE_PREFIX}${scope}`,
      file.originalname || `gift.${sniffed.ext}`,
    );
    await this.storage.uploadFile(file.buffer, key, sniffed.mime);
    // Same-origin proxy path the /api proxy forwards to GET /v1/gift-images.
    return { url: `/api/gift-images?key=${encodeURIComponent(key)}` };
  }

  /**
   * Stream a private gift image to the browser (the GET /v1/gift-images render path).
   * Readable by ANY authenticated portal user (members browse the catalogue) — the
   * route carries no @Roles — but tenant-fenced HERE by the key's folder: `_platform/`
   * images are portal-wide; a `<clientId>/` image is served only to that tenant (or an
   * un-assumed GIFSY operator). Refuses any key outside the gift-catalogue prefix, so it
   * can never be turned into an arbitrary-object reader against the shared private bucket.
   */
  async serveGiftImage(
    user: JwtPayload,
    key: string,
  ): Promise<{ bytes: Buffer; contentType: string; cachePublic: boolean }> {
    const deny = () => new NotFoundException();
    // Defense-in-depth: the tenant fence below trusts the key's folder segments, so
    // reject anything that isn't a clean gift-catalogue path BEFORE any storage read —
    // no traversal (`..`), no backslashes, no absolute/double-slash segments, safe
    // charset only. (Traversal is already inert because GCS object names are literal,
    // not a filesystem path — this makes the KYC/POSM-isolation invariant explicit
    // rather than dependent on that storage internal.)
    if (
      !key ||
      typeof key !== 'string' ||
      !key.startsWith(GiftCatalogueService.GIFT_IMAGE_PREFIX) ||
      key.includes('..') ||
      key.includes('\\') ||
      key.includes('//') ||
      !/^[A-Za-z0-9/_.-]+$/.test(key)
    ) {
      throw deny();
    }
    const segments = key.split('/');
    const scope = segments[1]; // '_platform' | '<clientId>'
    if (!scope || segments.length < 4) throw deny();
    if (scope !== '_platform' && !platformWide(user) && scope !== user.clientId) throw deny();

    // Cap the read at the upload cap (5 MB) rather than downloadBytes' 24 MB default —
    // this is the member hot path, so never buffer a larger object into API memory.
    const file = await this.storage.downloadBytes(key, 5 * 1024 * 1024);
    if (!file) throw deny();

    // Only ever stream a known image type inline (never trust the stored content-type
    // into an inline response beyond the renderable set).
    const mime = (file.contentType || '').toLowerCase();
    if (!GiftCatalogueService.RENDERABLE_MIME.has(mime)) throw deny();
    // _platform (master) images are portal-wide → safe to cache in the viewer's browser.
    // A per-tenant `<clientId>/` image must NOT be cached, so a shared browser can't
    // serve tenant A's cached image to tenant B without the server-side fence re-running.
    return { bytes: file.bytes, contentType: mime, cachePublic: scope === '_platform' };
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
    amountType?: unknown;
    minAmountPaise?: number | null;
    maxAmountPaise?: number | null;
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
      amountType: m.amountType ?? 'FIXED',
      minAmountPaise: m.minAmountPaise ?? null,
      maxAmountPaise: m.maxAmountPaise ?? null,
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
    amountType?: unknown;
    minAmountPaise?: number | null;
    maxAmountPaise?: number | null;
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
    // Vendor items link a category via RewardCatalog.giftCategoryId with NO GiftMaster
    // (FK is ON DELETE SET NULL, so deleting would silently strip the taxonomy link).
    const catalogueInUse = await this.prisma.rewardCatalog.count({
      where: { giftCategoryId: id, deletedAt: null },
    });
    if (catalogueInUse > 0) {
      throw new ConflictException('This category is in use by catalogue items and cannot be deleted.');
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

    // Amount-type: default FIXED; FREE_AMOUNT is validated for an eligible mode + a
    // complete 0 < min <= max ₹ band. FIXED clears the band (null).
    const amountType = dto.amountType ?? GiftAmountType.FIXED;
    this.assertAmountBand(amountType, dto.redemptionMode, dto.minAmountPaise, dto.maxAmountPaise);
    const isFree = amountType === GiftAmountType.FREE_AMOUNT;

    const master = await this.prisma.giftMaster.create({
      data: {
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        imageUrls: (dto.imageUrls ?? undefined) as Prisma.InputJsonValue | undefined,
        mrpPaise: dto.mrpPaise,
        redemptionMode: dto.redemptionMode,
        amountType,
        minAmountPaise: isFree ? dto.minAmountPaise : null,
        maxAmountPaise: isFree ? dto.maxAmountPaise : null,
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

    // Validate the EFFECTIVE amount-type/mode/band (undefined in the DTO = keep existing).
    // A partial PATCH must never leave the master in a half-configured FREE_AMOUNT state.
    const effAmountType = dto.amountType !== undefined ? dto.amountType : existing.amountType;
    const effMode = dto.redemptionMode !== undefined ? dto.redemptionMode : existing.redemptionMode;
    const effMin = dto.minAmountPaise !== undefined ? dto.minAmountPaise : existing.minAmountPaise;
    const effMax = dto.maxAmountPaise !== undefined ? dto.maxAmountPaise : existing.maxAmountPaise;
    this.assertAmountBand(effAmountType, effMode, effMin, effMax);
    const effIsFree = effAmountType === GiftAmountType.FREE_AMOUNT;

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
        amountType: dto.amountType,
        // Band is meaningful ONLY for a FREE_AMOUNT master. For a FIXED (or FREE→FIXED)
        // master force the band null so a direct-API PATCH can't leave a stale [min,max];
        // for a FREE master, undefined = keep existing (already validated as complete).
        minAmountPaise: effIsFree ? dto.minAmountPaise : null,
        maxAmountPaise: effIsFree ? dto.maxAmountPaise : null,
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
    // If the master is no longer a valid free-amount item (FREE→FIXED, or mode → an
    // ineligible one), CLEAR the band on published rows in the same content push — otherwise
    // a content edit could leave a tenant row stuck free-amount (pointsCost 0 + [min,max])
    // possibly on an ineligible mode, redeemable as a variable-amount voucher without a
    // re-publish (money audit A2). Price is NOT touched (re-publish is the price editor); such
    // a row is safely un-redeemable (0-cost) until re-published with a fixed price. Setting
    // these also makes contentPatch non-empty so an amountType-only edit still reconciles rows.
    if (!effIsFree || !this.supportsFreeAmount(effMode)) {
      contentPatch.minRedemptionPoints = null;
      contentPatch.maxRedemptionPoints = null;
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

        // Resolve the price to apply. On CREATE sellingValuePaise is required (FIXED only);
        // on re-publish an omitted price keeps the stored one.
        const rate = await this.tenantSettings.getConversionRate(target.clientId);
        const isFree = master.amountType === 'FREE_AMOUNT';
        const sellingValuePaise = target.sellingValuePaise ?? existing?.sellingValuePaise ?? null;
        // A FIXED gift needs a ₹ selling value to derive pointsCost; a FREE_AMOUNT gift has
        // no single ₹ value (the member picks the amount at redeem), so it is not required.
        if (!isFree && sellingValuePaise == null) {
          throw new BadRequestException(
            'sellingValuePaise is required to publish this gift to a tenant for the first time',
          );
        }
        // A FREE_AMOUNT row must NEVER carry a sellingValuePaise: the confirm-time value +
        // the 194R/disbursal basis fall back to points÷rate (= the amount the member chose).
        // Forcing null here prevents a FIXED→FREE re-publish from leaving the OLD fixed price
        // stamped on the row, which would freeze the tax basis at the wrong value (money audit #1).
        const rowSellingValuePaise = isFree ? null : sellingValuePaise;

        // FREE_AMOUNT: convert the master ₹ band → per-tenant points band using the SAME
        // conversion rate + rounding as derivePointsCost (points = round(₹ × rate)). Guard
        // both the master band (must be complete) and the result (never write a free-amount
        // row with a null/0 max — an un-redeemable voucher).
        let freeBand: { minRedemptionPoints: number; maxRedemptionPoints: number } | null = null;
        if (isFree) {
          // Defense-in-depth: re-assert the master band invariant at publish (eligible mode +
          // both bounds + 0<min<=max), not just trusting the master write (money audit A3).
          this.assertAmountBand(
            master.amountType,
            master.redemptionMode,
            master.minAmountPaise ?? null,
            master.maxAmountPaise ?? null,
          );
          const minRedemptionPoints = this.derivePointsCost(master.minAmountPaise as number, rate);
          const maxRedemptionPoints = this.derivePointsCost(master.maxAmountPaise as number, rate);
          if (minRedemptionPoints < 1 || maxRedemptionPoints < 1) {
            throw new BadRequestException(
              `Cannot publish "${master.code}" to ${target.clientId}: the ₹ band is too small for this tenant's conversion rate (it rounds to 0 points). Widen the band or set the tenant's conversion rate.`,
            );
          }
          freeBand = { minRedemptionPoints, maxRedemptionPoints };
        }

        if (existing) {
          // Re-publish → refresh CONTENT + apply an EXPLICITLY-sent price.
          //
          // pointsCost: an explicit target.pointsCost IS applied (the publish dialog is
          // the price editor); when OMITTED, PRESERVE the stored pointsCost — do NOT
          // silently re-derive from the CURRENT rate, which would shift the member price
          // on any rate drift since first publish. Derivation happens only on first
          // create (below).
          // FREE_AMOUNT rows are pointsCost 0 + a points band (synced from the master ₹
          // band on every re-publish). FIXED rows preserve the stored pointsCost when
          // omitted (audit fix #3 — no silent re-price on rate drift).
          // FIXED re-publish: apply an explicit price, else keep the stored pointsCost —
          // BUT if the stored one is the poison 0 (the row was previously FREE_AMOUNT),
          // derive from the selling value so a FREE→FIXED switch can't leave an
          // un-redeemable 0-cost fixed row (money audit #2).
          const pointsCost = isFree
            ? 0
            : target.pointsCost ??
              (existing.pointsCost > 0
                ? existing.pointsCost
                : this.derivePointsCost(sellingValuePaise as number, rate));
          if (!isFree && pointsCost < 1) {
            throw new BadRequestException(
              `Cannot publish "${master.code}" to ${target.clientId} as a fixed-price gift: its points cost resolves to 0 (set a selling value, or the tenant conversion rate is not configured).`,
            );
          }
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
              sellingValuePaise: rowSellingValuePaise,
              pointsCost,
              // Sync the free-amount band; force null for FIXED so a FREE→FIXED master
              // re-publish can't leave a stale [min,max] that keeps the row free-amount.
              minRedemptionPoints: isFree ? freeBand!.minRedemptionPoints : null,
              maxRedemptionPoints: isFree ? freeBand!.maxRedemptionPoints : null,
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

        // First create → FREE_AMOUNT rows are pointsCost 0 + a points band; FIXED rows
        // derive pointsCost from the tenant rate when not explicitly supplied.
        const pointsCost = isFree
          ? 0
          : target.pointsCost ?? this.derivePointsCost(sellingValuePaise as number, rate);
        if (!isFree && pointsCost < 1) {
          throw new BadRequestException(
            `Cannot publish "${master.code}" to ${target.clientId} as a fixed-price gift: its points cost resolves to 0 (set a selling value, or the tenant conversion rate is not configured).`,
          );
        }

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
            sellingValuePaise: rowSellingValuePaise,
            // FREE_AMOUNT: the points band the member redeems within; null for FIXED.
            minRedemptionPoints: isFree ? freeBand!.minRedemptionPoints : null,
            maxRedemptionPoints: isFree ? freeBand!.maxRedemptionPoints : null,
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
    // Cross-tenant for an un-assumed OWNER (scope undefined); pinned to the assumed
    // tenant otherwise, so a scoped operator only sees their own tenant's queue.
    const scope = tenantScope(user);
    const rows = await this.prisma.rewardCatalog.findMany({
      where: { moderationStatus: 'PENDING', deletedAt: null, ...(scope ? { clientId: scope } : {}) },
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
    // Scope the lookup so a scoped operator gets a 404 on a foreign tenant's item
    // instead of successfully moderating it; an un-assumed OWNER (scope undefined) sees all.
    const scope = tenantScope(user);
    const row = await this.prisma.rewardCatalog.findFirst({
      where: { id, deletedAt: null, ...(scope ? { clientId: scope } : {}) },
    });
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
    // Scope the lookup so a scoped operator gets a 404 on a foreign tenant's item
    // instead of successfully moderating it; an un-assumed OWNER (scope undefined) sees all.
    const scope = tenantScope(user);
    const row = await this.prisma.rewardCatalog.findFirst({
      where: { id, deletedAt: null, ...(scope ? { clientId: scope } : {}) },
    });
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
    // DRY: delegate to the shared helper (api/src/rewards/derive-points-cost.helper.ts),
    // the single source of truth also used by the admin /admin/gifts create/update path.
    return derivePointsCostHelper(sellingValuePaise, rate);
  }

  /**
   * Redemption modes that support a FREE_AMOUNT (variable ₹) band. Mirrors the per-tenant
   * /admin/gifts `supportsFreeAmount`: gift cards + cash payouts (UPI / BANK_TRANSFER).
   * Physical gifts are FIXED-only.
   */
  private static readonly FREE_AMOUNT_MODES: ReadonlySet<PayoutMode> = new Set<PayoutMode>([
    PayoutMode.GIFT_CARD,
    PayoutMode.UPI,
    PayoutMode.BANK_TRANSFER,
  ]);

  private supportsFreeAmount(mode: PayoutMode): boolean {
    return GiftCatalogueService.FREE_AMOUNT_MODES.has(mode);
  }

  /**
   * Money-path guard for the master ₹ band. FREE_AMOUNT is allowed ONLY for a free-amount
   * -eligible mode, and it MUST carry a COMPLETE band with 0 < min <= max — this closes the
   * half-configured bug (a min set but max null) that would publish an un-redeemable row.
   * For FIXED, the band is ignored (cleared to null by the caller).
   */
  private assertAmountBand(
    amountType: GiftAmountType,
    redemptionMode: PayoutMode,
    minAmountPaise: number | null | undefined,
    maxAmountPaise: number | null | undefined,
  ) {
    if (amountType !== GiftAmountType.FREE_AMOUNT) return;
    if (!this.supportsFreeAmount(redemptionMode)) {
      throw new BadRequestException(
        'A flexible (free-amount) gift is only available for Gift Card, UPI, or Bank Transfer redemption modes.',
      );
    }
    if (minAmountPaise == null || maxAmountPaise == null) {
      throw new BadRequestException(
        'A flexible (free-amount) gift requires both a minimum and a maximum ₹ amount.',
      );
    }
    if (!(minAmountPaise > 0)) {
      throw new BadRequestException('The minimum ₹ amount must be greater than 0.');
    }
    if (minAmountPaise > maxAmountPaise) {
      throw new BadRequestException('The minimum ₹ amount must be ≤ the maximum ₹ amount.');
    }
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
