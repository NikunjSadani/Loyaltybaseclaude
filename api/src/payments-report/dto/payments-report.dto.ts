/**
 * DTOs for the Payments Report — a READ-ONLY report of all payout PAYMENTS (actually-paid
 * CreditPayoutEntry rows) in a date range, across ALL payout streams (visibility 194C +
 * incentive/standard). Mirrors the visibility-payout TDS report DTO (tds-reports.dto.ts) but:
 *   - filters on paidAt (actually paid), NOT on tdsSection (which would exclude non-visibility
 *     streams), and
 *   - adds an optional CreditEntryStatus filter + an optional [from,to] paidAt range.
 *
 *   GET /v1/admin/payments-report          — JSON envelope
 *   GET /v1/admin/payments-report/export   — the same rows as an .xlsx download
 *
 * Scoping is enforced in the CONTROLLER from the JWT, never trusted from the query:
 *   - CLIENT_ADMIN is always pinned to their own clientId (any `clientId` query is ignored).
 *   - GIFSY_ADMIN may pass `clientId` to scope to one tenant, or omit it for platform-wide.
 */

import { CreditEntryStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Rows per page on the screen: default + hard maximum (the API never loads more than this per request). */
export const PAYMENTS_DEFAULT_PAGE_SIZE = 50;
export const PAYMENTS_MAX_PAGE_SIZE = 200;
/** Upper bound on ?page= (sanity — the service also clamps to the last real page). */
export const PAYMENTS_MAX_PAGE = 100_000;

/** ?clientId=&from=&to=&status= for the payments report + its export twin. */
export class PaymentsReportQueryDto {
  /** GIFSY-only tenant scope (ignored for CLIENT_ADMIN, who is pinned to their own tenant). */
  @IsOptional()
  @IsString()
  clientId?: string;

  /** Inclusive lower bound on paidAt (ISO date/date-time). Omit for no lower bound. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Inclusive upper bound on paidAt (ISO date/date-time). Omit for no upper bound. */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** Restrict to a single payment status (PENDING | PROCESSING | PAID | FAILED | REVERSED | CANCELLED). */
  @IsOptional()
  @IsEnum(CreditEntryStatus, {
    message: 'status must be one of PENDING, PROCESSING, PAID, FAILED, REVERSED, CANCELLED',
  })
  status?: CreditEntryStatus;
}

/**
 * The on-screen report adds paging on top of the shared filters. Deliberately NOT on the export DTO: the export is
 * every matching row, so `?page=` on /export is still rejected (forbidNonWhitelisted) rather than silently ignored.
 */
export class PaymentsReportPageQueryDto extends PaymentsReportQueryDto {
  /** 1-based page number (past the last page → the server returns the last page). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENTS_MAX_PAGE)
  page?: number;

  /** Rows per page (default 50, max 200). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENTS_MAX_PAGE_SIZE)
  pageSize?: number;
}
