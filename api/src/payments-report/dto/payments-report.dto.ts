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
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

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

  /** Restrict to a single payment status (PENDING | PROCESSING | PAID | FAILED | REVERSED). */
  @IsOptional()
  @IsEnum(CreditEntryStatus, {
    message: 'status must be one of PENDING, PROCESSING, PAID, FAILED, REVERSED',
  })
  status?: CreditEntryStatus;
}
