import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { PLAIN_STATUSES, PlainStatus } from '../visibility-metrics';

/** Month-wise visibility queries (VISIBILITY-POSM-DESIGN.md §17). */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** GET /v1/visibility/report[/tenant] — a month (default current IST month) + optional single window of it. */
export class VisibilityMonthReportQueryDto {
  @IsOptional()
  @IsString()
  @Matches(MONTH, { message: 'month must be YYYY-MM' })
  month?: string;

  /** One window of the month (`YYYY-MM-Pn`); absent = every window of the month. Alone it implies its month. */
  @IsOptional()
  @IsString()
  windowKey?: string;
}

export const REPORT_GROUPS = ['programme', 'rep', 'manager'] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/** GET /v1/visibility/report[/tenant]/outlets — the outlets behind a tile or a breakdown row. */
export class VisibilityReportOutletsQueryDto extends VisibilityMonthReportQueryDto {
  /** A plain status, or absent = every outlet-window in scope. */
  @IsOptional()
  @IsIn(PLAIN_STATUSES as unknown as string[])
  status?: PlainStatus;

  @IsOptional()
  @IsIn(REPORT_GROUPS as unknown as string[])
  group?: ReportGroup;

  /** The breakdown row key (from the report's `breakdowns[group][].key`). Required with `group`. */
  @IsOptional()
  @IsString()
  groupKey?: string;

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
  pageSize?: number = 50;
}

/** GET /v1/admin/dashboard/operations/visibility[/flags] + kpis visibilityMonth. */
export class VisibilityMonthQueryDto {
  @IsOptional()
  @IsString()
  @Matches(MONTH, { message: 'month must be YYYY-MM' })
  month?: string;

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
  pageSize?: number = 50;
}
