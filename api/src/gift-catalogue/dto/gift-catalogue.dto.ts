import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { GiftFulfilmentChannel, GiftMasterStatus, PayoutMode } from '@prisma/client';

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
  @IsUrl()
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
  @IsUrl()
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
  @IsUrl({}, { each: true })
  imageUrls?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mrpPaise?: number;

  @IsEnum(PayoutMode)
  redemptionMode!: PayoutMode;

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
  @IsUrl({}, { each: true })
  imageUrls?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mrpPaise?: number;

  @IsOptional()
  @IsEnum(PayoutMode)
  redemptionMode?: PayoutMode;

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
