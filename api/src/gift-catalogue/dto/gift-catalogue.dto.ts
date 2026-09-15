import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { GiftAmountType, GiftFulfilmentChannel, GiftMasterStatus, PayoutMode } from '@prisma/client';
import { IsImageRef } from '../../common/validators/is-image-ref.validator';

/**
 * Gift Catalogue & Dispatch — Wave 1 PLATFORM catalogue DTOs.
 * (Vendor DTOs are Wave 2; these cover the Gifsy master + taxonomy + publish only.)
 *
 * Every nested payload uses @ValidateNested + @Type so it survives the global
 * whitelisting ValidationPipe (an un-typed nested object is stripped/erased to Object).
 */

// ── GiftCategory (platform shared taxonomy) ──────────────────────────────────

export class CreateGiftCategoryDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  /** parentId for a sub-category; validated to exist in the service. */
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

export class UpdateGiftCategoryDto {
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

// ── GiftMaster (platform-source item, authored once) ─────────────────────────

export class CreateGiftMasterDto {
  /** FK → GiftCategory (validated tenant-agnostic; platform taxonomy). */
  @IsString()
  @MinLength(1)
  categoryId!: string;

  /** Platform-unique code (dedup key across the master). */
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

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

  @IsEnum(PayoutMode)
  redemptionMode!: PayoutMode;

  /**
   * FIXED (face-value / physical) vs FREE_AMOUNT (variable ₹). Defaults to FIXED in the
   * service when omitted. FREE_AMOUNT is validated to be a free-amount-eligible mode with
   * a complete ₹ band (see service `assertAmountBand`).
   */
  @IsOptional()
  @IsEnum(GiftAmountType)
  amountType?: GiftAmountType;

  /** ₹ band lower bound in paise; REQUIRED (with maxAmountPaise) when amountType=FREE_AMOUNT. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  minAmountPaise?: number;

  /** ₹ band upper bound in paise; REQUIRED (with minAmountPaise) when amountType=FREE_AMOUNT. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  maxAmountPaise?: number;

  /** The DEFAULT fulfilment channel a redemption order inherits (mapped to the
   *  `defaultFulfilmentChannel` column). FE field name = `fulfilmentChannel`. */
  @IsOptional()
  @IsEnum(GiftFulfilmentChannel)
  fulfilmentChannel?: GiftFulfilmentChannel;

  @IsOptional()
  @IsString()
  termsAndConditions?: string;

  /** null/absent = unlimited stock. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @IsOptional()
  @IsEnum(GiftMasterStatus)
  status?: GiftMasterStatus;
}

export class UpdateGiftMasterDto {
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

  @IsOptional()
  @IsEnum(PayoutMode)
  redemptionMode?: PayoutMode;

  /** FIXED vs FREE_AMOUNT. Validated against the EFFECTIVE mode/band in the service. */
  @IsOptional()
  @IsEnum(GiftAmountType)
  amountType?: GiftAmountType;

  /** ₹ band lower bound in paise (FREE_AMOUNT only; cleared to null for FIXED). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  minAmountPaise?: number;

  /** ₹ band upper bound in paise (FREE_AMOUNT only; cleared to null for FIXED). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  maxAmountPaise?: number;

  /** FE field name = `fulfilmentChannel`; maps to the `defaultFulfilmentChannel` column. */
  @IsOptional()
  @IsEnum(GiftFulfilmentChannel)
  fulfilmentChannel?: GiftFulfilmentChannel;

  @IsOptional()
  @IsString()
  termsAndConditions?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  @IsOptional()
  @IsEnum(GiftMasterStatus)
  status?: GiftMasterStatus;
}

export class ListGiftMastersQueryDto {
  @IsOptional()
  @IsEnum(GiftMasterStatus)
  status?: GiftMasterStatus;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}

// ── Publish-to-tenant(s) ─────────────────────────────────────────────────────

/**
 * One publish target: which tenant + the Gifsy-set ₹ selling price + points cost.
 * The publish DIALOG is the per-tenant PRICE EDITOR, so an explicit sellingValuePaise/
 * pointsCost sent here IS applied (create AND re-publish). pointsCost is DERIVED from
 * the tenant's conversion rate (points = ₹ × rate) when not supplied. (Master CONTENT
 * edits still never touch price — that propagation path is `updateMaster`, unchanged.)
 */
export class PublishPublicationDto {
  @IsString()
  @MinLength(1)
  clientId!: string;

  /** ₹ selling value in paise. REQUIRED on first publish for the tenant. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sellingValuePaise?: number;

  /** Explicit pointsCost; else derived from ₹ + the tenant rate. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pointsCost?: number;
}

export class PublishGiftMasterDto {
  /** Tenants to publish (or re-price) this master to. Empty when only unpublishing. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublishPublicationDto)
  publications?: PublishPublicationDto[];

  /** Tenants to unpublish (their catalog row is DISCONTINUED; in-flight orders keep). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unpublishClientIds?: string[];
}

// ── Moderation ───────────────────────────────────────────────────────────────

export class RejectModerationDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
