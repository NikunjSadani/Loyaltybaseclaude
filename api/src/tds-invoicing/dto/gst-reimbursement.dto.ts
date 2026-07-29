/**
 * DTOs for the GST-reimbursement (GST holdback / release) flow — Wave 1 Stream C, D5.
 *
 * GST-reimbursement is GIFSY_ADMIN-only. A SERVICE invoice's base is paid to the retailer
 * immediately while the GST is HELD; it is RELEASED only on the retailer's proof of GST
 * deposit plus the reimbursement payout reference (design D5).
 *
 *   GET  /v1/admin/gst-reimbursements?status=HELD&clientId=&period=YYYY-MM
 *   POST /v1/admin/gst-reimbursements/:id/release   { proofUrl, releasePayoutRef, notes? }
 */

import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** ?status=HELD|RELEASED (default HELD) &clientId= &period=YYYY-MM for the reimbursement list. */
export class ListGstReimbursementQueryDto {
  /** Reimbursement status filter. Defaults to HELD (the Gifsy release queue) when omitted. */
  @IsOptional()
  @IsString()
  @IsIn(['HELD', 'RELEASED'])
  status?: 'HELD' | 'RELEASED';

  /**
   * GIFSY may scope the list to a single tenant. CLIENT_ADMIN never reaches this endpoint
   * (GIFSY_ADMIN-only), so this is always an operator-supplied filter, never a tenant claim.
   */
  @IsOptional()
  @IsString()
  clientId?: string;

  /** Filter to a single payout period (the linked SERVICE invoice's period, "YYYY-MM"). */
  @IsOptional()
  @IsString()
  @Matches(PERIOD_RE, { message: 'period must be YYYY-MM' })
  period?: string;
}

/**
 * POST /v1/admin/gst-reimbursements/:id/release body.
 * Both the deposit proof and the reimbursement payout reference are REQUIRED — a HELD row is
 * only released against the retailer's proof of GST deposit AND the payout it was reimbursed by.
 */
export class ReleaseGstReimbursementDto {
  /** URL/reference to the retailer's proof of GST deposit (ticket attachment). */
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  proofUrl!: string;

  /** The reimbursement payout reference (UTR / voucher no.) the GST was released against. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  releasePayoutRef!: string;

  /** Optional operator note recorded on the release. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
