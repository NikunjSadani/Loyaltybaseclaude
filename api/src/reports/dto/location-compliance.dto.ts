import { UserRole } from '@prisma/client';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ReportFormat } from './reports.dto';

/** Sort keys for the Location-compliance report (all descending except `name`). */
export const LOCATION_SORTS = ['issues', 'captures', 'name'] as const;
export type LocationSort = (typeof LOCATION_SORTS)[number];

export const LOCATION_PAGE_SIZE_DEFAULT = 50;
export const LOCATION_PAGE_SIZE_MAX = 200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /v1/reports/location-compliance — query (all optional). Same date rules as the Usage report: IST calendar days,
 * inclusive, at most 366 days, default the last 30 days. `format=xlsx` downloads every filtered row
 * ('location-compliance' export kind).
 */
export class LocationComplianceQueryDto {
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be a date like 2026-11-01' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be a date like 2026-11-30' })
  to?: string;

  @IsOptional()
  @IsEnum(UserRole, { message: 'role must be a valid user role' })
  role?: UserRole;

  /** A (trimmed) region — the rep's employee-record region, else the states of their directly-assigned outlets. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  region?: string;

  @IsOptional()
  @IsIn(LOCATION_SORTS, { message: `sort must be one of: ${LOCATION_SORTS.join(', ')}` })
  sort?: LocationSort;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(LOCATION_PAGE_SIZE_MAX)
  pageSize?: number;

  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat;
}
