import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { VisibilityStatus } from '@prisma/client';

/** GET /v1/visibility/submissions — list/filter submissions (tenant-scoped). */
export class ListSubmissionsQueryDto {
  @IsOptional()
  @IsString()
  outletId?: string;

  @IsOptional()
  @IsString()
  programId?: string;

  @IsOptional()
  @IsEnum(VisibilityStatus)
  status?: VisibilityStatus;

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

/** POST /v1/visibility/submissions/:id/reject — rejection reason is required. */
export class RejectSubmissionDto {
  @IsString()
  @MinLength(1, { message: 'Reason is required' })
  reason!: string;
}

/** GET /v1/visibility/outlet-statuses — outletCode→status map for a month. */
export class OutletStatusesQueryDto {
  @IsOptional()
  @IsString()
  outletCodes?: string;

  // YYYY-MM; service defaults to current month when omitted.
  @IsOptional()
  @IsString()
  month?: string;
}

/** GET /v1/visibility/fraud-log — paginated fraud log (GIFSY-only). */
export class ListFraudLogQueryDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  outletId?: string;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

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
