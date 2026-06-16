import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { OutletVisibilityStatus } from '@prisma/client';

/**
 * Query for GET /v1/admin/visibility/records — ported from
 * platform/src/app/api/admin/visibility/records/route.ts.
 */
export class ListVisibilityRecordsQueryDto {
  /** YYYY-MM filter (optional). */
  @IsOptional()
  @IsString()
  month?: string;

  @IsOptional()
  @IsEnum(OutletVisibilityStatus)
  status?: OutletVisibilityStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}
