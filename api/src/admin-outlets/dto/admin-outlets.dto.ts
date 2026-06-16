import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One parsed Outlet Master upload row — mirrors platform `OutletUploadRow`
 * (src/types/index.ts). The admin page validates client-side via the
 * outlet-upload lib and posts the OK, fully-parsed rows; this route enforces the
 * write-time DB invariants (OutletType-by-code, XSR-by-employeeCode) and upserts.
 * Only `outletId` is structurally required; the rest are carried straight through.
 */
export class OutletUploadRowDto {
  @IsOptional()
  @IsInt()
  rowNum!: number;

  @IsString()
  outletId!: string;

  @IsOptional()
  @IsString()
  outletName?: string = '';

  @IsOptional()
  @IsString()
  programName?: string = '';

  @IsOptional()
  @IsString()
  programCategory?: string = '';

  @IsOptional()
  @IsString()
  outletType?: string = '';

  @IsOptional()
  @IsString()
  beat?: string = '';

  @IsOptional()
  @IsString()
  distributorId?: string = '';

  @IsOptional()
  @IsString()
  distributorName?: string = '';

  @IsOptional()
  @IsString()
  metro?: string = '';

  @IsOptional()
  @IsString()
  city?: string = '';

  @IsOptional()
  @IsString()
  state?: string = '';

  @IsOptional()
  @IsString()
  zone?: string = '';

  @IsOptional()
  @IsString()
  xsrId?: string = '';
}

/** POST /upsert — persists the Outlet Master upload (max 500 rows/request). */
export class UpsertOutletsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'rows must be a non-empty array' })
  @ArrayMaxSize(500, { message: 'Maximum 500 outlets per upsert request' })
  @ValidateNested({ each: true })
  @Type(() => OutletUploadRowDto)
  rows!: OutletUploadRowDto[];
}

/**
 * One parsed Re-KYC flag upload row — mirrors platform `ReKYCFlagRow`.
 * Each field column carries the raw "Yes"/blank cell; the service turns the row
 * into the persisted `ReKYCFlags` JSON via `buildReKycFlags`.
 */
export class ReKycFlagRowDto {
  @IsOptional()
  @IsInt()
  rowNum!: number;

  @IsString()
  outletId!: string;

  @IsOptional() @IsString() outletName?: string = '';
  @IsOptional() @IsString() ownerName?: string = '';
  @IsOptional() @IsString() mobileNumber?: string = '';
  @IsOptional() @IsString() gstNumber?: string = '';
  @IsOptional() @IsString() panNumber?: string = '';
  @IsOptional() @IsString() streetAddress?: string = '';
  @IsOptional() @IsString() city?: string = '';
  @IsOptional() @IsString() pincode?: string = '';
  @IsOptional() @IsString() state?: string = '';
  @IsOptional() @IsString() bankName?: string = '';
  @IsOptional() @IsString() accountHolderName?: string = '';
  @IsOptional() @IsString() accountNumber?: string = '';
  @IsOptional() @IsString() ifscCode?: string = '';
  @IsOptional() @IsString() upiId?: string = '';
  @IsOptional() @IsString() gstCertificate?: string = '';
  @IsOptional() @IsString() ownerPhoto?: string = '';
  @IsOptional() @IsString() addressProof?: string = '';
  @IsOptional() @IsString() storeBoardPhoto?: string = '';
  @IsOptional() @IsString() cancelledCheque?: string = '';
  @IsOptional() @IsString() selfDeclaration?: string = '';
  @IsOptional() @IsString() remarks?: string = '';
}

/** POST /rekyc-flag — persists the Re-KYC flag upload (max 500 rows/request). */
export class ReKycFlagDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'rows must be a non-empty array' })
  @ArrayMaxSize(500, { message: 'Maximum 500 outlets per re-KYC flag request' })
  @ValidateNested({ each: true })
  @Type(() => ReKycFlagRowDto)
  rows!: ReKycFlagRowDto[];
}

/** POST /bulk-delete — soft-delete by Prisma CUID ids (max 200/request). */
export class BulkDeleteOutletsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'outletIds must be a non-empty array' })
  @ArrayMaxSize(200, { message: 'Maximum 200 outlets per bulk-delete request' })
  @IsString({ each: true })
  outletIds!: string[];
}

/** POST /deactivate and POST /reactivate — by outletCode strings (max 500/request). */
export class OutletCodesDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'outletCodes must be a non-empty array' })
  @ArrayMaxSize(500, { message: 'Maximum 500 outlets per request' })
  @IsString({ each: true })
  outletCodes!: string[];
}

/** GET / — no query params today; kept for parity with the template list shape. */
export class ListOutletsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
