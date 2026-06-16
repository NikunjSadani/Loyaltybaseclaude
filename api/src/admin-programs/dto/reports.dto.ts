import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { TicketCategory, TicketPriority } from '@prisma/client';

export enum ReportFormat {
  JSON = 'json',
  XLSX = 'xlsx',
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
