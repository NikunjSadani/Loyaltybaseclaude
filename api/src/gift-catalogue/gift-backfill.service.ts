import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { isGifsyOperator } from '../common/tenant-scope';

/**
 * Deoleo (and any live tenant) gift-catalogue BACKFILL — idempotent, Gifsy-run.
 * NOT a Prisma migration (Wave 0 already added the schema): a re-runnable service
 * an operator triggers via POST /v1/admin/gift-catalogue/backfill.
 *
 * For each existing RewardCatalog row (already sourceType=PLATFORM by default):
 *   1. Build the platform GiftCategory taxonomy from the tenant RewardCategory set
 *      (matched/created by code); link the row via giftCategoryId.
 *   2. Create a GiftMaster per DISTINCT item (dedup by the platform-unique code) and
 *      set giftMasterId.
 *   3. Backfill sellingValuePaise from the row's pointsCost + the tenant conversion
 *      rate: value(₹) = points ÷ rate → paise = round(points × 100 ÷ rate). (÷ rate,
 *      NOT × — × would inflate by rate². The field is PAISE, hence the × 100 to match
 *      the confirm-time freeze (points ÷ rate) × 100.)
 *
 * IDEMPOTENT: a row that already has giftMasterId is skipped; a GiftCategory/GiftMaster
 * with the code is reused; sellingValuePaise is only filled when null. The member-facing
 * catalogue is UNCHANGED (pointsCost/status/moderationStatus untouched; all links additive).
 */
@Injectable()
export class GiftBackfillService {
  private readonly logger = new Logger(GiftBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * @param clientId  optional — restrict to one tenant; default = all tenants with
   *                   PLATFORM catalog rows.
   */
  async run(user: JwtPayload, clientId?: string) {
    if (!isGifsyOperator(user)) {
      throw new ForbiddenException('Backfill is Gifsy-operator only');
    }

    const rowWhere = {
      deletedAt: null,
      sourceType: 'PLATFORM' as const,
      giftMasterId: null,
      ...(clientId ? { clientId } : {}),
    };

    const rows = await this.prisma.rewardCatalog.findMany({
      where: rowWhere,
      include: { category: { select: { id: true, code: true, name: true, imageUrl: true, sortOrder: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // Cache: RewardCategory.code → GiftCategory.id, and code → GiftMaster.id, and
    // clientId → conversion rate, so the loop stays O(rows) with minimal DB churn.
    const giftCategoryByCode = new Map<string, string>();
    const giftMasterByCode = new Map<string, string>();
    const rateByClient = new Map<string, number>();

    let masters = 0;
    let categories = 0;
    let linked = 0;
    let valuesBackfilled = 0;
    let skipped = 0;
    const errors: Array<{ catalogItemId: string; message: string }> = [];

    for (const row of rows) {
      try {
        const cat = row.category;
        // 1. Ensure a GiftCategory for this RewardCategory (by code).
        let giftCategoryId = cat ? giftCategoryByCode.get(cat.code) : undefined;
        if (cat && !giftCategoryId) {
          const existingGiftCat = await this.prisma.giftCategory.findFirst({
            where: { code: cat.code },
            select: { id: true },
          });
          if (existingGiftCat) {
            giftCategoryId = existingGiftCat.id;
          } else {
            const createdCat = await this.prisma.giftCategory.create({
              data: {
                code: cat.code,
                name: cat.name,
                imageUrl: cat.imageUrl,
                sortOrder: cat.sortOrder,
                isActive: true,
              },
              select: { id: true },
            });
            giftCategoryId = createdCat.id;
            categories++;
          }
          giftCategoryByCode.set(cat.code, giftCategoryId);
        }

        // 2. Ensure a GiftMaster for this item (dedup by code).
        //
        // TENANT-NAMESPACE the dedup key: RewardCatalog.code is only unique per
        // (clientId, code), so two DIFFERENT products in two tenants can share a
        // code. A GLOBAL `code` dedup would merge them onto one GiftMaster (and one
        // master edit would then bleed across tenants). GiftMaster carries no
        // clientId column, so we namespace its code as `${clientId}:${code}` — the
        // cache key, the lookup and the created row all use it, so distinct-product/
        // same-code rows across tenants never merge. Within a tenant the code is
        // unique, so same-tenant re-runs still dedup correctly (idempotent).
        const masterCode = `${row.clientId}:${row.code}`;
        let giftMasterId = giftMasterByCode.get(masterCode);
        if (!giftMasterId) {
          const existingMaster = await this.prisma.giftMaster.findFirst({
            where: { code: masterCode, deletedAt: null },
            select: { id: true },
          });
          if (existingMaster) {
            giftMasterId = existingMaster.id;
          } else {
            // GiftMaster.categoryId is required; use the mapped GiftCategory, or a
            // fallback "uncategorised" platform category when the row had none.
            const masterCategoryId = giftCategoryId ?? (await this.ensureUncategorised());
            const createdMaster = await this.prisma.giftMaster.create({
              data: {
                categoryId: masterCategoryId,
                code: masterCode,
                name: row.name,
                description: row.description,
                imageUrls: row.imageUrls ?? undefined,
                mrpPaise: row.mrpPaise,
                redemptionMode: row.redemptionMode,
                termsAndConditions: row.termsAndConditions,
                stockQuantity: row.stockQuantity,
                createdByUserId: user.sub,
              },
              select: { id: true },
            });
            giftMasterId = createdMaster.id;
            masters++;
          }
          giftMasterByCode.set(masterCode, giftMasterId);
        }

        // 3. sellingValuePaise from pointsCost ÷ rate (paise). Only when null.
        //
        // SKIP FREE_AMOUNT rows: a choose-your-value voucher (pointsCost=0 with a
        // min/max band — the canonical FREE_AMOUNT signal, mirroring
        // RewardsService.isFreeAmount) has no fixed selling price. Deriving from
        // pointsCost=0 would freeze valuePaise=0 and DROP the real gift value from
        // 194R Source-2 + the disbursal report. Leave sellingValuePaise null so the
        // confirm-time freeze falls back to points÷rate (the actual redeemed value).
        let sellingValuePaise = row.sellingValuePaise;
        if (sellingValuePaise == null && !isFreeAmountRow(row)) {
          let rate = rateByClient.get(row.clientId);
          if (rate === undefined) {
            rate = await this.tenantSettings.getConversionRate(row.clientId);
            rateByClient.set(row.clientId, rate);
          }
          sellingValuePaise = backfillSellingValuePaise(row.pointsCost, rate);
          valuesBackfilled++;
        }

        await this.prisma.rewardCatalog.update({
          where: { id: row.id },
          data: {
            giftMasterId,
            giftCategoryId: giftCategoryId ?? undefined,
            sellingValuePaise,
          },
        });
        linked++;
      } catch (e) {
        errors.push({
          catalogItemId: row.id,
          message: e instanceof Error ? e.message : 'Unknown error',
        });
      }
    }

    const summary = {
      scanned: rows.length,
      linked,
      mastersCreated: masters,
      categoriesCreated: categories,
      valuesBackfilled,
      skipped,
      failed: errors.length,
      errors,
    };
    this.logger.log(`[gift-backfill] ${JSON.stringify({ ...summary, errors: errors.length })}`);
    return summary;
  }

  /** A single fallback GiftCategory for rows that had no RewardCategory (defensive). */
  private async ensureUncategorised(): Promise<string> {
    const CODE = 'UNCATEGORISED';
    const existing = await this.prisma.giftCategory.findFirst({
      where: { code: CODE },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await this.prisma.giftCategory.create({
      data: { code: CODE, name: 'Uncategorised', sortOrder: 999, isActive: true },
      select: { id: true },
    });
    return created.id;
  }
}

/**
 * sellingValuePaise from pointsCost + rate. value(₹) = points ÷ rate (rate =
 * points-per-₹); the field is PAISE so × 100. Matches the confirm-time freeze
 * (points ÷ rate) × 100. rate 0/misconfig → 0 (visible for manual correction).
 * Exported for unit testing.
 */
export function backfillSellingValuePaise(pointsCost: number, rate: number): number {
  if (!rate || rate <= 0) return 0;
  return Math.round((pointsCost * 100) / rate);
}

/**
 * A FREE_AMOUNT (choose-your-value) voucher: pointsCost=0 with BOTH a min and a max
 * redemption band. Mirrors RewardsService.isFreeAmount — the single source of the
 * FREE_AMOUNT convention. Such a row has NO fixed selling price, so the backfill must
 * NOT freeze a (zero) sellingValuePaise for it. Exported for unit testing.
 */
export function isFreeAmountRow(row: {
  pointsCost: number;
  minRedemptionPoints: number | null;
  maxRedemptionPoints: number | null;
}): boolean {
  return (
    row.pointsCost === 0 &&
    row.minRedemptionPoints != null &&
    row.maxRedemptionPoints != null
  );
}
