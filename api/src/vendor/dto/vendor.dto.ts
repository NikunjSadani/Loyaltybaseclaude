import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import {
  GiftApprovalPolicy,
  GiftFulfilmentChannel,
  PayoutMode,
  RewardCatalogStatus,
  VendorGrantStatus,
  VendorStatus,
} from '@prisma/client';
import { IsImageRef } from '../../common/validators/is-image-ref.validator';

// ─────────────────────────────────────────────────────────────────────────────
// Gifsy vendor management — /v1/admin/vendors  (@Roles GIFSY_ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export class CreateVendorDto {
  @IsString()
  @MinLength(1)
  name!: string;
}

export class UpdateVendorDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  /** SUSPENDED triggers the suspend cascade (login block + dynamic member-hiding). */
  @IsOptional()
  @IsEnum(VendorStatus)
  status?: VendorStatus;
}

export class CreateVendorGrantDto {
  @IsString()
  @MinLength(1)
  clientId!: string;

  @IsEnum(GiftApprovalPolicy)
  approvalPolicy!: GiftApprovalPolicy;
}

export class UpdateVendorGrantDto {
  @IsOptional()
  @IsEnum(GiftApprovalPolicy)
  approvalPolicy?: GiftApprovalPolicy;

  /** REVOKED triggers the revoke cascade (login block + dynamic member-hiding). */
  @IsOptional()
  @IsEnum(VendorGrantStatus)
  status?: VendorGrantStatus;
}

export class CreateVendorUserDto {
  @Matches(/^\d{10}$/, { message: 'phone must be 10 digits' })
  phone!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  /** The granted tenant this login is pinned to (decision #12: one tenant per login). */
  @IsString()
  @MinLength(1)
  clientId!: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor portal — /v1/vendor/*  (@Roles VENDOR)
// ─────────────────────────────────────────────────────────────────────────────

export class VendorCreateCatalogueDto {
  @IsString()
  @MinLength(1)
  name!: string;

  /** A platform GiftCategory id (shared taxonomy, decision #3). */
  @IsString()
  @MinLength(1)
  categoryId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  sellingValuePaise!: number;

  /** REQUIRED for a vendor item (price-bounds basis, review #8). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  mrpPaise!: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsImageRef({ each: true })
  imageUrls?: string[];

  @IsEnum(PayoutMode)
  redemptionMode!: PayoutMode;

  @IsEnum(GiftFulfilmentChannel)
  fulfilmentChannel!: GiftFulfilmentChannel;

  /** null/absent = untracked stock; 0 = out of stock. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQuantity?: number;
}

export class VendorUpdateCatalogueDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sellingValuePaise?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  mrpPaise?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsImageRef({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsEnum(PayoutMode)
  redemptionMode?: PayoutMode;

  @IsOptional()
  @IsEnum(GiftFulfilmentChannel)
  fulfilmentChannel?: GiftFulfilmentChannel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  /** Vendor may pause/re-activate its own item (ACTIVE / INACTIVE / OUT_OF_STOCK). */
  @IsOptional()
  @IsEnum(RewardCatalogStatus)
  status?: RewardCatalogStatus;
}

/** Vendor-facing NON-STATUS fulfilment edit (tracking / channel / partner / POD / voucher). */
export class VendorFulfilmentDto {
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

/**
 * RESTRICTED vendor transition targets (review CRITICAL #4) — a vendor may ONLY move
 * an order forward through non-wallet-touching states. Every refund/reversal edge
 * (CANCELLED / RETURNED / FAILED) is DELIBERATELY EXCLUDED and stays Gifsy-only.
 */
export enum VendorTransitionStatus {
  PROCESSING = 'PROCESSING',
  DISPATCHED = 'DISPATCHED',
  DELIVERED = 'DELIVERED',
}

export class VendorTransitionDto {
  @IsEnum(VendorTransitionStatus)
  toStatus!: VendorTransitionStatus;

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
// Gift Disbursal report — /v1/admin/gift-disbursal  (@Roles GIFSY_ADMIN, CLIENT_ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export class GiftDisbursalQueryDto {
  /** Gifsy may narrow to one tenant; a CLIENT_ADMIN is force-scoped to their own. */
  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  vendorId?: string;

  /** ISO date (inclusive) lower bound on createdAt. */
  @IsOptional()
  @IsString()
  from?: string;

  /** ISO date (inclusive) upper bound on createdAt. */
  @IsOptional()
  @IsString()
  to?: string;
}
