/**
 * DTOs for the visibility-payout TDS reports — Wave 1 Stream C, §6.
 *
 *   GET /v1/admin/tds-reports/payouts       — payout report w/ GST reg type + frozen TDS treatment
 *   GET /v1/admin/tds-reports/unregistered  — unregistered-retailer / RCM report (invoice numbers)
 *   GET /v1/admin/tds-reports/recovery      — TDS liability + tenant-wise recovery/attribution
 *
 * All three accept `.../export` twins that stream an .xlsx of the same rows.
 *
 * Scoping is enforced in the CONTROLLER from the JWT, never trusted from the query:
 *   - CLIENT_ADMIN is always pinned to their own clientId (any `clientId` query is ignored).
 *   - GIFSY_ADMIN may pass `clientId` to scope to one tenant, or omit it for platform-wide.
 */

import { IsOptional, IsString, Matches } from 'class-validator';

const PERIOD_RE = /^\d{4}-\d{2}$/;
const FY_RE = /^\d{4}-\d{2}$/;

/** ?clientId=&period=YYYY-MM for the payout report. */
export class PayoutReportQueryDto {
  /** GIFSY-only tenant scope (ignored for CLIENT_ADMIN, who is pinned to their own tenant). */
  @IsOptional()
  @IsString()
  clientId?: string;

  /** Restrict to a single payout period ("YYYY-MM"). */
  @IsOptional()
  @IsString()
  @Matches(PERIOD_RE, { message: 'period must be YYYY-MM' })
  period?: string;
}

/** ?clientId=&period=YYYY-MM for the unregistered / RCM report (GIFSY-only). */
export class UnregisteredReportQueryDto {
  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsString()
  @Matches(PERIOD_RE, { message: 'period must be YYYY-MM' })
  period?: string;
}

/** ?clientId=&fy=YYYY-YY for the recovery / attribution report. */
export class RecoveryReportQueryDto {
  /** GIFSY-only tenant scope (ignored for CLIENT_ADMIN). */
  @IsOptional()
  @IsString()
  clientId?: string;

  /** Restrict to a single financial year (e.g. "2026-27"). */
  @IsOptional()
  @IsString()
  @Matches(FY_RE, { message: 'fy must be YYYY-YY' })
  fy?: string;
}
