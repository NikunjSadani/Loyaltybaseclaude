import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  MinLength,
} from 'class-validator';
import { BannerPosition, BannerStatus } from '@prisma/client';

/**
 * Body for POST /v1/admin/banners — ported from
 * platform/src/app/api/admin/banners/route.ts.
 *
 * Source also accepted `targetClasses` (z.array of CP_01/CP_02/CP_03) —
 * DROPPED: partner-class targeting is a World-A concept and the canonical
 * BannerManagement model has no targetClasses column.
 */
export class CreateBannerDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsUrl()
  imageUrl!: string;

  @IsOptional()
  @IsUrl()
  linkUrl?: string;

  @IsEnum(BannerPosition)
  position!: BannerPosition;

  @IsOptional()
  @IsEnum(BannerStatus)
  status?: BannerStatus = BannerStatus.INACTIVE;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startDate?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endDate?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number = 0;
}

/** Query for DELETE /v1/admin/banners — soft-deletes by `?id=`. */
export class DeleteBannerQueryDto {
  @IsString()
  @MinLength(1, { message: 'Banner ID is required' })
  id!: string;
}
