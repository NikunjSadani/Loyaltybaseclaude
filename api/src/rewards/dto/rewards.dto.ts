import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUrl, Min, MinLength } from 'class-validator';
import { RedemptionStatus } from '@prisma/client';

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
  limit?: number = 20;
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
 * Settable order statuses for the admin PATCH — mirrors the source zod enum
 * exactly (PENDING is intentionally excluded: admins move orders forward only).
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
 * Order update payload — mirrors the source zod patchSchema on
 * PATCH /api/rewards/orders/[id].
 */
export class UpdateOrderDto {
  @IsOptional()
  @IsEnum(UpdatableOrderStatus)
  status?: UpdatableOrderStatus;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsUrl()
  trackingUrl?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
