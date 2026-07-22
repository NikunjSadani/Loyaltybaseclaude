import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  Min,
  ValidateNested,
  Length,
  ValidateIf,
} from 'class-validator';
import { KycStatus, KycDocumentType, KycFieldKey, EntityType, GstRegistrationType } from '@prisma/client';

// ─── Geo capture sub-schema ───────────────────────────────────────────────────
export class GeoDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;

  @IsNumber()
  accuracy!: number;

  @IsString()
  ts!: string;
}

// ─── Document sub-schema ─────────────────────────────────────────────────────
// A document is referenced one of two ways, in preference order:
//   1. fileKey + fileUrl — the object was uploaded to GCS via POST /v1/kyc/documents
//      (the production path; the bytes live in object storage, not the DB).
//   2. dataUrl — a base64 data URL inlined in the JSON (legacy/demo fallback).
export class KycDocumentDto {
  @IsEnum(KycDocumentType, { message: 'Invalid document type' })
  type!: KycDocumentType; // validated against the Prisma enum

  @IsOptional()
  @IsString()
  fileKey?: string; // GCS object key returned by the upload endpoint (preferred)

  @IsOptional()
  @IsString()
  fileUrl?: string; // GCS object URL returned by the upload endpoint

  @IsOptional()
  @IsString()
  dataUrl?: string; // legacy inline base64 fallback

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  fileSizeBytes?: number;
}

// ─── POST /v1/kyc/documents — multipart single-file upload to GCS ──────────────
// The file rides as multipart field `file`; this DTO is the accompanying text field.
export class UploadKycDocumentDto {
  @IsEnum(KycDocumentType, { message: 'Invalid documentType' })
  documentType!: KycDocumentType;
}

// ─── Full KYC submission schema ───────────────────────────────────────────────
export class CreateKycDto {
  // Target outlet (Prisma CUID — the outlet `id`, NOT the human outletCode). The
  // submission is FILED BY the rep but is ABOUT this outlet/owner. Required so a
  // sales rep can enrol an outlet they don't personally own.
  @IsString()
  @MinLength(1, { message: 'outletId is required' })
  outletId!: string;

  // Partner / outlet owner identity
  @IsString()
  @MinLength(2)
  partnerName!: string;

  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid mobile number' })
  mobile!: string;

  @IsOptional()
  @IsString()
  partnerClass?: string = 'SSS';

  // GSTIN format: 2-digit state code + 10-char PAN + entity digit + 'Z' + check char.
  // Aligns with invoice.helpers.ts (state code = first 2 digits, 15-char GSTIN).
  // The field stays optional (many outlets have no GST). @IsOptional() skips the
  // remaining validators for undefined/null; @ValidateIf additionally treats an
  // empty/whitespace-only string as "no GST" so a blank value does not 400.
  // @Matches therefore runs ONLY for a non-empty provided value.
  @IsOptional()
  @ValidateIf((o: CreateKycDto) => o.gstNumber != null && o.gstNumber.trim() !== '')
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, {
    message: 'gstNumber must be a valid 15-character GSTIN',
  })
  gstNumber?: string;

  @IsOptional()
  @IsString()
  panNumber?: string;

  // Address
  @IsString()
  @MinLength(5)
  address!: string;

  @IsString()
  @MinLength(2)
  city!: string;

  @IsString()
  @MinLength(2)
  state!: string;

  @Matches(/^\d{6}$/, { message: 'Invalid pincode' })
  pincode!: string;

  // Bank / UPI
  @IsOptional()
  @IsEnum(['bank', 'upi'])
  paymentMode?: 'bank' | 'upi';

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  accountNumber?: string;

  @IsOptional()
  @IsString()
  accountHolderName?: string;

  @IsOptional()
  @IsString()
  ifscCode?: string;

  @IsOptional()
  @IsString()
  upiId?: string;

  // Geo captures
  @IsOptional()
  @ValidateNested()
  @Type(() => GeoDto)
  boardPhotoGeo?: GeoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoDto)
  paymentGeo?: GeoDto;

  // Documents (including signature)
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KycDocumentDto)
  documents?: KycDocumentDto[];

  @IsOptional()
  @IsString()
  signatureDataUrl?: string;

  // Shop-board name vs address-proof name mismatch, declared by the submitting rep.
  // For a tenant with the `kycAddressProofWaiver` feature, declaring this drops the extra
  // signed self-declaration document — the Address Proof upload itself stays required
  // either way. The boolean is persisted as the audit trail. Document requirements are
  // gated on the FE (the new-KYC form); the backend accepts the flag on any tenant.
  @IsOptional()
  @IsBoolean()
  addressNameMismatch?: boolean;

  // Consent
  @IsOptional()
  @IsBoolean()
  agreedToTerms?: boolean;

  @IsOptional()
  @IsBoolean()
  agreedToComms?: boolean;

  // Legacy / admin fields
  @IsOptional()
  @IsString()
  reviewerNotes?: string;
}

// PATCH /v1/kyc/:id — admin (GIFSY) status/notes update
const PATCH_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'RE_UPLOAD_REQUIRED',
  'PENDING_PENNY_DROP',
  'PENDING_AGREEMENT',
  'SUSPENDED',
] as const;

export class UpdateKycDto {
  @IsOptional()
  @IsEnum(PATCH_STATUSES)
  status?: (typeof PATCH_STATUSES)[number];

  @IsOptional()
  @IsString()
  rejectionReason?: string;

  @IsOptional()
  @IsString()
  reviewerNotes?: string;
}

// POST /v1/kyc/:id/first-approve
export class FirstApproveKycDto {
  @IsOptional()
  @IsString()
  remarks?: string;
}

// POST /v1/kyc/:id/reject
const REJECT_STATUSES = ['REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED'] as const;

export class RejectKycDto {
  @IsString()
  @MinLength(1, { message: 'Reason is required' })
  reason!: string;

  @IsOptional()
  @IsString()
  requiredAction?: string;

  @IsOptional()
  @IsEnum(REJECT_STATUSES)
  status?: (typeof REJECT_STATUSES)[number] = 'REJECTED';
}

// POST /v1/kyc/consent
export class ConsentKycDto {
  @IsString()
  @MinLength(1)
  submissionId!: string;

  @Matches(/^\d{10}$/, { message: 'Mobile must be 10 digits' })
  mobile!: string;

  @IsString()
  @Length(6, 6, { message: 'OTP must be 6 digits' })
  otp!: string;
}

// POST /v1/kyc/consent-otp — send the outlet-owner consent OTP
export class SendConsentOtpDto {
  @IsString()
  @MinLength(1)
  submissionId!: string;

  @Matches(/^\d{10}$/, { message: 'Mobile must be 10 digits' })
  mobile!: string;
}

// POST /v1/kyc/not-interested
export class NotInterestedKycDto {
  @IsString()
  @MinLength(1, { message: 'outletId is required' })
  outletId!: string;
}

// POST /v1/kyc/bulk-verify — ?apply=true|false (default false = dry-run)
export class BulkVerifyQueryDto {
  @IsOptional()
  @IsString()
  apply?: string; // string, not boolean — HTTP query params are always strings
}

// GET /v1/kyc — list query
export class ListKycQueryDto {
  @IsOptional()
  @IsEnum(KycStatus)
  status?: KycStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

// POST /v1/kyc/:id/verify — per-field portal verification (Lane B, Gifsy-only)
export class VerifyKycFieldDto {
  @IsEnum(KycFieldKey, { message: 'Invalid fieldKey' })
  fieldKey!: KycFieldKey;

  @IsEnum(['APPROVED', 'REJECTED'], { message: 'decision must be APPROVED or REJECTED' })
  decision!: 'APPROVED' | 'REJECTED';

  // remark is required when decision === REJECTED
  @ValidateIf((o: VerifyKycFieldDto) => o.decision === 'REJECTED')
  @IsString()
  @MinLength(1, { message: 'remark is required when rejecting a field' })
  remark?: string;
}

// POST /v1/kyc/:id/re-kyc — manual re-KYC trigger (Task 3.6, Gifsy-only)
export class ReKycDto {
  @IsString()
  @MinLength(1, { message: 'reason is required' })
  reason!: string;

  @IsOptional()
  @IsArray()
  @IsEnum(KycFieldKey, { each: true, message: 'Invalid fieldKey in fieldKeys' })
  fieldKeys?: KycFieldKey[];
}

// POST /v1/kyc/:id/gst-details — capture entityType + gstRegistrationType (Task 3.4e, Gifsy-only)
export class GstDetailsDto {
  @IsEnum(EntityType, { message: 'Invalid entityType' })
  entityType!: EntityType;

  @IsEnum(GstRegistrationType, { message: 'Invalid gstRegistrationType' })
  gstRegistrationType!: GstRegistrationType;

  // Optional: stored in KycVerificationItem.evidence for GST_VALIDATION (read by P6 invoicing)
  @IsOptional()
  @IsString()
  gstLegalName?: string;

  @IsOptional()
  @IsString()
  gstStatus?: string;
}
