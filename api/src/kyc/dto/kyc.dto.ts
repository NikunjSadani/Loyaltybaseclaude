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
} from 'class-validator';
import { KycStatus } from '@prisma/client';

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
  @IsString()
  type!: string; // KycDocumentType enum value

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
  @IsString()
  @MinLength(1, { message: 'documentType is required' })
  documentType!: string; // KycDocumentType enum value
}

// ─── Full KYC submission schema ───────────────────────────────────────────────
export class CreateKycDto {
  // Partner / outlet owner identity
  @IsString()
  @MinLength(2)
  partnerName!: string;

  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid mobile number' })
  mobile!: string;

  @IsOptional()
  @IsString()
  partnerClass?: string = 'SSS';

  @IsOptional()
  @IsString()
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

// POST /v1/kyc/not-interested
export class NotInterestedKycDto {
  @IsString()
  @MinLength(1, { message: 'outletId is required' })
  outletId!: string;
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
