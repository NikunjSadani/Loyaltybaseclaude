import { UserRole } from '@prisma/client';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ReportFormat } from './reports.dto';

/** Sort keys for the Usage Report (all descending except `name`). */
export const USAGE_SORTS = ['minutes', 'days', 'lastSeen', 'name'] as const;
export type UsageSort = (typeof USAGE_SORTS)[number];

export const USAGE_PAGE_SIZE_DEFAULT = 50;
export const USAGE_PAGE_SIZE_MAX = 200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /v1/reports/usage — query (all optional). Dates are IST calendar days (YYYY-MM-DD); the range is inclusive
 * and at most 366 days (checked in the service, with the real-calendar-date check). `format=xlsx` downloads the
 * filtered, sorted list (every row, not just the page) through the exports framework ('usage-report' kind).
 */
export class UsageReportQueryDto {
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be a date like 2026-11-01' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be a date like 2026-11-30' })
  to?: string;

  @IsOptional()
  @IsEnum(UserRole, { message: 'role must be a valid user role' })
  role?: UserRole;

  /** A (trimmed) Outlet.programName. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  program?: string;

  /** A (trimmed) state — see the report's region note. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  region?: string;

  @IsOptional()
  @IsIn(USAGE_SORTS, { message: `sort must be one of: ${USAGE_SORTS.join(', ')}` })
  sort?: UsageSort;

  /** 'true' → also list users with no activity in the range (who did NOT use it). Default: active users only. */
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'includeInactive must be true or false' })
  includeInactive?: 'true' | 'false';

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(USAGE_PAGE_SIZE_MAX)
  pageSize?: number;

  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat;
}
