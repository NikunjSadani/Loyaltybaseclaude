import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
  Max,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
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

/** POST /v1/rewards/orders/:id/voucher-cancelled — "Voucher cancelled with vendor" (GIFSY_ADMIN). */
export class VoucherCancelledWithVendorDto {
  /** Why / vendor reference — required, trimmed, stored in the audit log. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 500)
  reason!: string;
}

/** POST /rewards/orders/:id/hubble-acknowledge — GIFSY_ADMIN clears a post-refund Hubble flag. */
export class HubbleAcknowledgeDto {
  /** What ops checked in Hubble's portal and concluded — required, trimmed, audited. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 500)
  note!: string;

  /**
   * Acknowledge although the pre-check could not reach Hubble ("Hubble unreachable") — only honoured
   * with a note of at least 20 characters; recorded as forced + audited.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Hard cap on GET /v1/rewards/orders `limit` (one request never reads more rows than this). */
export const ORDERS_LIST_MAX_LIMIT = 500;

/** Orders listing filters — mirror the source GET /api/rewards/orders params. */
/** Max characters of the orders free-text search (longer input is cut, not rejected). */
export const ORDER_SEARCH_MAX_LEN = 100;

export class ListOrdersQueryDto {
  @IsOptional()
  @IsEnum(RedemptionStatus)
  status?: RedemptionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /**
   * Page size. Capped at ORDERS_LIST_MAX_LIMIT (500): the partner My Orders uses the default 20,
   * the admin Fulfilment queue pages by 100 and re-fetches at most a 500-row window on refresh.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ORDERS_LIST_MAX_LIMIT)
  limit?: number = 20;

  /**
   * Keyset cursor (opaque, from a previous page's `nextCursor`) — the partner My Orders
   * "Load more". When present it REPLACES `page` (offset): rows strictly older than the
   * cursor on (createdAt DESC, id DESC), stable under inserts and under rows leaving the
   * member view mid-scroll. Absent → the legacy page/offset mode (admin console) unchanged.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  /**
   * Free-text SERVER-side search (admin Redemption orders): reward name, order number / id,
   * outlet code, partner / outlet name, partner phone (the phone/outlet parts only on the
   * operator / tenant-admin view). Trimmed; capped at ORDER_SEARCH_MAX_LEN characters; blank = no search.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().slice(0, ORDER_SEARCH_MAX_LEN) : value))
  @IsString()
  @MaxLength(ORDER_SEARCH_MAX_LEN)
  q?: string;
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

  // undefined = no change. null / blank is REJECTED: a stored voucher code is only ever cleared
  // by POST /rewards/orders/:id/voucher-cancelled (voucher-write-guard.ts enforces it too).
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/\S/, { message: 'voucherCode cannot be blank' })
  voucherCode?: string;

  // Optional card PIN (card number + PIN gift cards). Trimmed; blank = no PIN. A PIN needs its card
  // number (400 otherwise — voucher-write-guard). Same visibility as voucherCode; never reuse-checked.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  voucherPin?: string;

  // undefined = no change. null / blank is REJECTED: a stored voucher code is only ever cleared
  // by POST /rewards/orders/:id/voucher-cancelled (voucher-write-guard.ts enforces it too).
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/\S/, { message: 'voucherProvider cannot be blank' })
  voucherProvider?: string;

  /**
   * GIFSY_ADMIN-only MANUAL FULFILMENT OVERRIDE of an order that was sent to Hubble (the ops exit
   * for hubbleNeedsReconcile): must carry a new voucherCode + overrideReason. Every other voucher
   * rule still applies (no overwrite, status, points, cash, tenant-wide reuse). Audited.
   */
  @IsOptional()
  @IsBoolean()
  manualOverride?: boolean;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 500)
  overrideReason?: string;

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
   *
   * WHOLE RUPEES ONLY (owner decision 2026-11-11, ALL tenants, vouchers AND cash): a
   * decimal (750.5) is a 400 "Enter a whole-rupee amount" at the DTO gate, before any
   * points move. (A fractional amount previously reached Hubble as an un-issuable value
   * and produced fractional cash payouts.)
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Enter a whole-rupee amount' })
  @IsPositive({ message: 'Enter a whole-rupee amount' })
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

  // undefined = no change. null / blank is REJECTED: a stored voucher code is only ever cleared
  // by POST /rewards/orders/:id/voucher-cancelled (voucher-write-guard.ts enforces it too).
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/\S/, { message: 'voucherCode cannot be blank' })
  voucherCode?: string;

  // Optional card PIN (card number + PIN gift cards). Trimmed; blank = no PIN. A PIN needs its card
  // number (400 otherwise — voucher-write-guard). Same visibility as voucherCode; never reuse-checked.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  voucherPin?: string;

  // undefined = no change. null / blank is REJECTED: a stored voucher code is only ever cleared
  // by POST /rewards/orders/:id/voucher-cancelled (voucher-write-guard.ts enforces it too).
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Matches(/\S/, { message: 'voucherProvider cannot be blank' })
  voucherProvider?: string;

  /**
   * GIFSY_ADMIN-only MANUAL FULFILMENT OVERRIDE of an order that was sent to Hubble (the ops exit
   * for hubbleNeedsReconcile): must carry a new voucherCode + overrideReason. Every other voucher
   * rule still applies (no overwrite, status, points, cash, tenant-wide reuse). Audited.
   */
  @IsOptional()
  @IsBoolean()
  manualOverride?: boolean;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 500)
  overrideReason?: string;

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

  /**
   * Free-text SERVER-side search (admin Redemption orders): reward name, order number / id,
   * outlet code, partner / outlet name, partner phone (the phone/outlet parts only on the
   * operator / tenant-admin view). Trimmed; capped at ORDER_SEARCH_MAX_LEN characters; blank = no search.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().slice(0, ORDER_SEARCH_MAX_LEN) : value))
  @IsString()
  @MaxLength(ORDER_SEARCH_MAX_LEN)
  q?: string;
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
 *   - FIXED item          → NO band; `pointsCost` is DERIVED server-side from
 *                           `sellingValuePaise` × the tenant conversion rate (PURE
 *                           DERIVE — `pointsCost` is NOT a client input).
 *   - FREE_AMOUNT voucher → `minRedemptionPoints`/`maxRedemptionPoints` bound the
 *                           redeem-time range; `pointsCost` stays 0. (The variable
 *                           amount itself is taken & validated at redeem time in 5.4 —
 *                           CRUD only STORES the range.) Derivation does NOT apply.
 *
 * The service detects FREE_AMOUNT by the presence of a min/max band; everything else is
 * FIXED and requires `sellingValuePaise` (the price driver).
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mrpPaise?: number;

  /**
   * ₹ SELLING VALUE in paise (the real cost basis Gifsy pays for the
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

  /** Optional reason recorded on the stock-history row this write creates (shown in Stock history). */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  stockReason?: string;

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

  /**
   * Hubble GIFT_CARD only: the whole-rupee amounts to OFFER (subset of the brand's Hubble
   * denominations for a FIXED brand; values inside its min–max for a FLEXIBLE one). Validated
   * against the live Hubble product on save; persisted to metadata.hubbleDenominations. The
   * item is stored as a variable-amount item whose points band derives from the list, and a
   * redemption must pick one of these amounts.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true, message: 'Gift card amounts must be whole rupees' })
  @IsPositive({ each: true, message: 'Gift card amounts must be greater than 0' })
  hubbleDenominations?: number[];
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
  mrpPaise?: number;

  /**
   * ₹ selling value in paise (see CreateRewardCatalogDto.sellingValuePaise). `undefined`
   * leaves the stored value unchanged. For a FIXED item this is the price driver:
   * `pointsCost` is RE-DERIVED from the effective selling value × the tenant conversion
   * rate (PURE DERIVE — `pointsCost` is NOT a client input). Bound (on the effective
   * values): when both selling value and MRP are set, sellingValuePaise <= mrpPaise.
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

  /** Optional reason recorded on the stock-history row when this edit changes the stock (shown in Stock history). */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  stockReason?: string;

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

  /**
   * See CreateRewardCatalogDto.hubbleDenominations. `undefined` leaves the stored list
   * unchanged; `[]` CLEARS it (the item goes back to the band / fixed price in this payload).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true, message: 'Gift card amounts must be whole rupees' })
  @IsPositive({ each: true, message: 'Gift card amounts must be greater than 0' })
  hubbleDenominations?: number[];
}

/** POST /v1/admin/rewards/stock-reviews/:id/resolve — an admin's decision on a pre-release return. */
export class ResolveStockReviewDto {
  @IsIn(['RETURN', 'KEEP'])
  action!: 'RETURN' | 'KEEP';

  /** Required for KEEP (why the stock stays as it is); optional for RETURN. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
