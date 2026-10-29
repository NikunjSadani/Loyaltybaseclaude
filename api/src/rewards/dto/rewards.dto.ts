import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  GiftFulfilmentChannel,
  PayoutMode,
  RedemptionStatus,
  RewardCatalogStatus,
} from '@prisma/client';
import { IsImageRef } from '../../common/validators/is-image-ref.validator';

/**
 * Catalog listing filters — mirror the source query params on
 * platform GET /api/rewards/catalog (category/minPoints/maxPoints/page/limit).
 * NOTE: `category` and `inStock` are accepted but unused by the service, exactly
 * as in the source route (it parses them but never applies them to the where).
 */
export class ListCatalogQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minPoints?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxPoints?: number;

  @IsOptional()
  @IsString()
  inStock?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 20;
}

/**
 * Admin catalogue listing filters. Extends the partner catalogue query so that
 * `page`/`limit` keep their `@Type(() => Number)` coercion, and adds the
 * admin-only `status`/`categoryId` filters.
 *
 * IMPORTANT: this MUST be a concrete class (not an inline intersection type on
 * the controller). NestJS's ValidationPipe only transforms when the parameter's
 * runtime metatype is a user class; an intersection type erases to `Object`, so
 * the pipe skips coercion and `page`/`limit` reach Prisma as raw query STRINGS
 * → `PrismaClientValidationError` on `take`/`skip`. (gap #35)
 */
export class AdminListCatalogQueryDto extends ListCatalogQueryDto {
  @IsOptional()
  @IsEnum(RewardCatalogStatus)
  status?: RewardCatalogStatus;

  @IsOptional()
  @IsString()
  categoryId?: string;
}

/** Orders listing filters — mirror the source GET /api/rewards/orders params. */
export class ListOrdersQueryDto {
  @IsOptional()
  @IsEnum(RedemptionStatus)
  status?: RedemptionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

/**
 * Settable order statuses for the admin transition — mirrors the source zod enum
 * (PENDING is intentionally excluded: admins move orders forward only).
 * Kept as its own enum because the canonical RedemptionStatus also has PENDING.
 */
export enum UpdatableOrderStatus {
  CONFIRMED = 'CONFIRMED',
  PROCESSING = 'PROCESSING',
  DISPATCHED = 'DISPATCHED',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  RETURNED = 'RETURNED',
}

/**
 * Order update payload — NON-STATUS edits only (tracking / notes / voucher).
 * 5.4a: every status change MUST go through the guarded `transitionOrder`
 * (see TransitionOrderDto), so `status` is no longer accepted here.
 */
export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsUrl()
  trackingUrl?: string;

  @IsOptional()
  @IsString()
  voucherCode?: string;

  @IsOptional()
  @IsString()
  voucherProvider?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  // ── Dispatch fields (Gift Catalogue & Dispatch §5) — fulfilment console/bulk edits.
  @IsOptional()
  @IsEnum(GiftFulfilmentChannel)
  fulfilmentChannel?: GiftFulfilmentChannel;

  @IsOptional()
  @IsString()
  logisticsPartner?: string;

  @IsOptional()
  @IsString()
  supplierOrderRef?: string;

  @IsOptional()
  @IsUrl()
  podUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// P5.4a — CORE redemption pipeline (redeem → OTP confirm → guarded fulfilment).
// Ported from platform/src/app/api/rewards/redeem(/confirm). Tenant scope
// (clientId) and the caller identity come from the JWT — never the body.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delivery address — REQUIRED only for PHYSICAL_GIFT redemptions; for
 * GIFT_CARD / UPI / BANK_TRANSFER the whole block is optional (the service
 * enforces presence-by-mode). Mirrors the source zod deliveryAddressSchema.
 */
export class RedeemDeliveryAddressDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @Matches(/^\d{10}$/, { message: 'mobile must be 10 digits' })
  mobile!: string;

  @IsString()
  @MinLength(1)
  address!: string;

  @IsString()
  @MinLength(1)
  city!: string;

  @IsString()
  @MinLength(1)
  state!: string;

  @Matches(/^\d{6}$/, { message: 'pincode must be 6 digits' })
  pincode!: string;
}

/** POST /v1/rewards/redeem — initiate a redemption (creates PENDING order + OTP). */
export class RedeemDto {
  @IsString()
  @MinLength(1)
  rewardId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  quantity?: number = 1;

  /**
   * FREE_AMOUNT vouchers only (item.pointsCost === 0 + min/max set): the ₹ value
   * the partner wants. requiredPoints = round(amount × conversionRate), validated
   * vs [minRedemptionPoints, maxRedemptionPoints]. Ignored for FIXED items.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount?: number;

  /** REQUIRED for PHYSICAL_GIFT; optional otherwise (enforced in the service). */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RedeemDeliveryAddressDto)
  deliveryAddress?: RedeemDeliveryAddressDto;

  /**
   * DPDP consent (decision #15) — REQUIRED to be `true` when redeeming a
   * VENDOR-sourced gift: the member agrees their delivery name/address/phone are
   * shared with the fulfilment vendor. The service BLOCKS a vendor-item redeem
   * without it and stores vendorPiiConsentAt + consentVersion on the order. Ignored
   * for PLATFORM items (no third party → no checkbox).
   *
   * C1 (consent fail-open): the global ValidationPipe runs with
   * `enableImplicitConversion:true`, so class-transformer would coerce ANY
   * non-empty string (`"false"`/`"0"`/`"no"`) to boolean `true`, defeating the
   * service's `consent === true` DPDP gate. Strict-parse here so ONLY a genuine
   * boolean `true` or the exact string `'true'` counts as consent; everything
   * else resolves to `false` and the service blocks the vendor-item redeem.
   *
   * NOTE: read the RAW source value via `obj`, not `value` — under
   * `enableImplicitConversion:true` the implicit Boolean coercion runs BEFORE
   * this @Transform, so `value` for `"false"`/`"0"`/`"no"` has already become
   * boolean `true` (verified at runtime). `obj.consent` is the untouched input.
   */
  @IsOptional()
  @Transform(({ obj }) => obj?.consent === true || obj?.consent === 'true')
  @IsBoolean()
  consent?: boolean;
}

/** POST /v1/rewards/redeem/confirm — confirm a PENDING order with the OTP. */
export class RedeemConfirmDto {
  @IsString()
  @MinLength(1)
  orderId!: string;

  @IsString()
  @Length(6, 6)
  otp!: string;
}

/**
 * POST /v1/rewards/wishlist — add a catalogue reward to the caller's persistent
 * wishlist. `rewardId` must belong to the caller's own tenant (validated in the
 * service); a cross-tenant id is rejected. Idempotent (upsert on partner×reward).
 */
export class WishlistAddDto {
  @IsString()
  @MinLength(1)
  rewardId!: string;
}

/**
 * POST /v1/rewards/redeem-for-outlet — SALES-ASSISTED redeem (B1, #50-E).
 * A sales user redeems on behalf of an OUTLET they are assigned to. Points,
 * wallet and the order all belong to the OUTLET; `targetPartnerId` names it.
 * The OTP is sent to the OUTLET's phone (consent), the sales rep submits the code.
 */
export class SalesRedeemDto extends RedeemDto {
  @IsString()
  @MinLength(1)
  targetPartnerId!: string;
}

/** POST /v1/rewards/redeem-for-outlet/confirm — confirm a sales-assisted redeem. */
export class SalesRedeemConfirmDto extends RedeemConfirmDto {
  @IsString()
  @MinLength(1)
  targetPartnerId!: string;
}

/**
 * POST /v1/rewards/orders/:id/transition — GIFSY-only guarded status change.
 * Allowed edges + refund-on-cancel/return/fail live in the service. Inline
 * voucher/tracking entry rides along on the same call (owner asked for per-order
 * fulfilment entry on the order-detail screen).
 */
export class TransitionOrderDto {
  @IsEnum(UpdatableOrderStatus)
  toStatus!: UpdatableOrderStatus;

  @IsOptional()
  @IsString()
  voucherCode?: string;

  @IsOptional()
  @IsString()
  voucherProvider?: string;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsUrl()
  trackingUrl?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  // ── Dispatch fields (Gift Catalogue & Dispatch §5) — stamped alongside a status move.
  @IsOptional()
  @IsEnum(GiftFulfilmentChannel)
  fulfilmentChannel?: GiftFulfilmentChannel;

  @IsOptional()
  @IsString()
  logisticsPartner?: string;

  @IsOptional()
  @IsString()
  supplierOrderRef?: string;

  @IsOptional()
  @IsUrl()
  podUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// P5.4b — Bulk fulfilment (Gifsy-ops download → fill → upload).
// GET .../fulfilment/template filters; the upload itself is multipart (no body DTO).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /v1/admin/rewards/fulfilment/template query filters.
 *   - status: restrict the template to a single RedemptionStatus (default = the
 *     fulfilment-actionable set per mode: see RewardsService.getFulfilmentTemplate).
 *   - mode:   restrict to a single PayoutMode (e.g. GIFT_CARD vouchers only).
 */
export class FulfilmentTemplateQueryDto {
  @IsOptional()
  @IsEnum(RedemptionStatus)
  status?: RedemptionStatus;

  @IsOptional()
  @IsEnum(PayoutMode)
  mode?: PayoutMode;
}

/**
 * GET /v1/admin/gift-catalogue/dispatch/orders — Gifsy fulfilment console filters.
 * Cross-tenant for a platformWide OWNER; `clientId` narrows to one tenant. Each
 * returned order is annotated with a channel-aware dispatch-SLA.
 */
export class FulfilmentOrdersQueryDto {
  @IsOptional()
  @IsEnum(RedemptionStatus)
  status?: RedemptionStatus;

  /** Fulfilment channel filter. FE param name = `channel`. */
  @IsOptional()
  @IsEnum(GiftFulfilmentChannel)
  channel?: GiftFulfilmentChannel;

  /** Narrow a platform-wide list to one tenant (Client.id slug). */
  @IsOptional()
  @IsString()
  clientId?: string;

  /** Case-insensitive substring match on orderNumber. FE param name = `q`. */
  @IsOptional()
  @IsString()
  q?: string;

  /** ISO date (inclusive) lower bound on createdAt. FE param name = `from`. */
  @IsOptional()
  @IsString()
  from?: string;

  /** ISO date (inclusive) upper bound on createdAt. FE param name = `to`. */
  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

// ─────────────────────────────────────────────────────────────────────────────
// P5.3 — Admin Reward Catalog CRUD (real RewardCategory / RewardCatalog tables).
// These supersede the World-B `admin/gift-config` JSON blob + `lib/gifts.ts`
// demo (retired with the FE in 5.5). Tenant scope (clientId) is stamped by the
// service from the JWT — never accepted from the body.
// ─────────────────────────────────────────────────────────────────────────────

/** POST /v1/admin/rewards/categories */
export class CreateRewardCategoryDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** parentId for a sub-category; validated tenant-scoped in the service. */
  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsImageRef()
  imageUrl?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** PATCH /v1/admin/rewards/categories/:id — all fields optional. */
export class UpdateRewardCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsImageRef()
  imageUrl?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * POST /v1/admin/rewards/catalog
 *
 * VOUCHER CONVENTION (no `voucherType` column exists — see reconcile §3):
 *   - FIXED voucher       → `pointsCost` > 0, `redemptionMode = GIFT_CARD`.
 *   - FREE_AMOUNT voucher → `pointsCost = 0` + `minRedemptionPoints`/
 *                           `maxRedemptionPoints` bound the redeem-time range,
 *                           `redemptionMode = GIFT_CARD`. (The variable amount
 *                           itself is taken & validated at redeem time in 5.4 —
 *                           CRUD only STORES the range.)
 */
export class CreateRewardCatalogDto {
  @IsString()
  @MinLength(1)
  categoryId!: string;

  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Array of image URLs; stored as the `imageUrls` Json column. */
  @IsOptional()
  @IsArray()
  @IsImageRef({ each: true })
  imageUrls?: string[];

  @Type(() => Number)
  @IsInt()
  @Min(0)
  pointsCost!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mrpPaise?: number;

  /**
   * OPTIONAL per-item ₹ SELLING VALUE in paise (the real cost basis Gifsy pays for the
   * item). Drives (a) the rate-INDEPENDENT catalogue MRP-slash the member sees (computed
   * server-side as pointsCost × mrpPaise ÷ sellingValuePaise) and (b) the rate-immune
   * 194R/valuation freeze (sellingValuePaise × qty). COST BASIS — never projected to a
   * member (excluded from MEMBER_CATALOG_SELECT; computed then stripped on member reads).
   * Bound: when both are set, sellingValuePaise <= mrpPaise (a sell price can't exceed MRP).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sellingValuePaise?: number;

  @IsEnum(PayoutMode)
  redemptionMode!: PayoutMode;

  @IsOptional()
  @IsEnum(RewardCatalogStatus)
  status?: RewardCatalogStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minRedemptionPoints?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxRedemptionPoints?: number;

  /** null/absent = untracked stock. 0 = out of stock (see service stock rule). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @IsOptional()
  @IsString()
  termsAndConditions?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * Hubble Money productId for AUTO-ISSUANCE of a GIFT_CARD voucher (Bajaj-only,
   * flag-gated). Persisted to RewardCatalog.metadata.hubbleProductId; auto-issuance
   * fires only when the tenant flag is ON AND this is set on a GIFT_CARD item.
   */
  @IsOptional()
  @IsString()
  hubbleProductId?: string;
}

/** PATCH /v1/admin/rewards/catalog/:id — all fields optional. */
export class UpdateRewardCatalogDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsImageRef({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pointsCost?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mrpPaise?: number;

  /**
   * OPTIONAL ₹ selling value in paise (see CreateRewardCatalogDto.sellingValuePaise).
   * `undefined` leaves the stored value unchanged. Bound (on the effective values):
   * when both selling value and MRP are set, sellingValuePaise <= mrpPaise.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sellingValuePaise?: number;

  @IsOptional()
  @IsEnum(PayoutMode)
  redemptionMode?: PayoutMode;

  @IsOptional()
  @IsEnum(RewardCatalogStatus)
  status?: RewardCatalogStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minRedemptionPoints?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxRedemptionPoints?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @IsOptional()
  @IsString()
  termsAndConditions?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * Hubble Money productId (GIFT_CARD auto-issuance). Persisted to
   * metadata.hubbleProductId; an empty string CLEARS it (disables auto-issuance for
   * this item). `undefined` leaves the stored value unchanged.
   */
  @IsOptional()
  @IsString()
  hubbleProductId?: string;
}
