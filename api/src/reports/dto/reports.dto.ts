import { IsEnum, IsOptional, IsString } from 'class-validator';

/**
 * Reporting & Analytics DTOs — ported from platform/src/app/api/reports/*.
 * Every report is a GET with query-string filters: an optional date range
 * (ISO yyyy-mm-dd), an optional format selector ('json' | 'xlsx'), plus a
 * handful of report-specific pickers (financial year, group-by period).
 */

/** xlsx routes flip to a StreamableFile download; everything else returns JSON. */
export enum ReportFormat {
  JSON = 'json',
  XLSX = 'xlsx',
}

/** Common date-range + format filter shared by all report endpoints. */
export class ReportRangeQueryDto {
  @IsOptional()
  @IsString()
  dateFrom?: string; // ISO date; parsed to Date in the service

  @IsOptional()
  @IsString()
  dateTo?: string; // ISO date; parsed to Date in the service

  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat = ReportFormat.JSON;
}

/** TDS report adds a financial-year picker. */
export class TdsReportQueryDto extends ReportRangeQueryDto {
  @IsOptional()
  @IsString()
  fy?: string; // financial year, e.g. "2024-25"
}
