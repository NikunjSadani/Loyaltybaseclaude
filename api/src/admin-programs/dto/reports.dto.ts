import { IsEnum, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { TicketCategory, TicketPriority } from '@prisma/client';

export enum ReportFormat {
  JSON = 'json',
  XLSX = 'xlsx',
}

/**
 * Query for GET /v1/admin/reports/target-vs-sales.
 * `fromMonth`/`toMonth` are YYYY-MM (format enforced here; the inclusive span is
 * capped at 15 months in the service, mirroring the max-15 rule). Defaults to
 * JSON (on-screen preview); `format=xlsx` streams the download.
 */
export class TargetVsSalesQueryDto {
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'fromMonth must be in YYYY-MM format' })
  fromMonth!: string;

  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'toMonth must be in YYYY-MM format' })
  toMonth!: string;

  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat = ReportFormat.JSON;
}

/**
 * Query for GET /v1/admin/reports/points-ledger — ported from
 * platform/src/app/api/admin/reports/points-ledger/route.ts.
 * `from`/`to` are YYYY-MM (validated in the service to mirror the source's
 * 400 messages exactly).
 */
export class PointsLedgerQueryDto {
  @IsString()
  from!: string;

  @IsString()
  to!: string;

  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat = ReportFormat.JSON;
}

/**
 * Query for GET /v1/admin/reports/ticket-aging — ported from
 * platform/src/app/api/admin/reports/ticket-aging/route.ts.
 * `status` is a CSV of TicketStatus values (parsed/validated in the service).
 */
export class TicketAgingQueryDto {
  /** CSV of TicketStatus values; omit for the default open set. */
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsIn(['json', 'xlsx'])
  format?: string = 'json';
}
