import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, ValidateIf } from 'class-validator';

/**
 * Query DTO for GET /v1/partner/targets.
 * `period` is an optional "YYYY-MM" filter (e.g. "2026-05"); when omitted the
 * service returns all active scheme targets for the caller. Mirrors the source
 * route's `req.nextUrl.searchParams.get('period')` (string | null).
 */
export class ListPartnerTargetsQueryDto {
  @IsOptional()
  @IsString()
  period?: string;
}

/**
 * Body for POST /v1/partner/payout-details — a wholesaler self-captures bank/UPI at
 * redemption (capture-bank-at-redemption; see PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md).
 * Field names mirror the KYC CreateKycDto payout block so the FE bank-or-upi-section
 * component is reused verbatim. Server-side validation (mode↔mandate, required fields,
 * uniqueness) mirrors kyc.service.create and lives in PartnerService.capturePayoutDetails.
 */
export class CapturePayoutDetailsDto {
  @IsIn(['bank', 'upi'])
  paymentMode!: 'bank' | 'upi';

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  accountHolderName?: string;

  @IsOptional()
  @IsString()
  accountNumber?: string;

  @IsOptional()
  @IsString()
  ifscCode?: string;

  @IsOptional()
  @ValidateIf((o: CapturePayoutDetailsDto) => !!o.upiId && o.upiId.trim() !== '')
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^[a-zA-Z0-9._-]{2,}@[a-zA-Z][a-zA-Z0-9]{1,}$/, {
    message: 'upiId must be a valid UPI ID (e.g. name@bank)',
  })
  upiId?: string;

  /** GCS key of the cancelled-cheque uploaded via POST /v1/partner/documents (bank mode). */
  @IsOptional()
  @IsString()
  chequeFileKey?: string;
}

/** Body for POST /v1/partner/documents — partner-scoped cheque upload (cheque only). */
export class UploadPartnerDocumentDto {
  @IsIn(['CANCELLED_CHEQUE'])
  documentType!: 'CANCELLED_CHEQUE';
}
