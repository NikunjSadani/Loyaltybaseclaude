import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * The DERIVED KYC display statuses the outlet list surfaces (see
 * AdminOutletsService.deriveKycStatus). These are NOT the raw KycStatus enum —
 * they are the six buckets the FE renders + filters on. The server maps each
 * bucket back to a Prisma `where` so pagination stays correct (filtering the
 * current page only would be wrong).
 */
export const OUTLET_KYC_FILTER_VALUES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'RE_KYC_REQUIRED',
  // Admin-PARKED outlets — their own distinct bucket (never folded into NOT_STARTED), so an
  // admin can list + un-park them. Fully hidden from sales reps.
  'PARKED',
] as const;
export type OutletKycFilter = (typeof OUTLET_KYC_FILTER_VALUES)[number];

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

  // Per-outlet payout MANDATE cell (raw "BANK"/"UPI"/"ANY", case-insensitive; blank →
  // default BANK). The service parses + validates it (parseOutletPaymentType) and rejects
  // a UPI row when the tenant has UPI disabled — kept a plain @IsString here like the
  // other passthrough columns.
  @IsOptional()
  @IsString()
  payoutMethod?: string = '';

  // Parent-child owner group link (docs/plans/PARTNER-MULTI-OUTLET.md §4.4). The admin-facing
  // PARENT identifier = the parent ChannelPartner's partnerCode (e.g. "CPP01"), resolved to the
  // parent's id and written to Outlet.parentId. Deliberately has NO `= ''` default so the three
  // intents stay distinguishable:
  //   - column ABSENT for the row  → `undefined` → leave grouping UNCHANGED (the common
  //     case for a routine re-upload that omits the column — avoids mass-un-grouping).
  //   - present but BLANK ("")      → NO-OP. A blank cell NEVER un-groups; un-grouping is a
  //     separate explicit action (POST /admin/outlets/:outletCode/ungroup, §4.5) so a routine
  //     re-upload can't silently dissolve a group.
  //   - a partnerCode ("CPP01")     → LINK / add-to-parent (guarded — §4.4).
  @IsOptional()
  @IsString()
  parentId?: string;
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

/**
 * GET / — server-side pagination + filtering for the admin outlet list.
 * Mirrors ListChannelPartnersQueryDto (page/limit/search) and adds the KYC
 * display-status filter. `search` spans the same fields the FE searched
 * client-side (outlet code, name, ISR name, beat, city); `kycStatus` is one of
 * the six DERIVED buckets (OUTLET_KYC_FILTER_VALUES). limit is capped at 100.
 */
export class ListOutletsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(OUTLET_KYC_FILTER_VALUES)
  kycStatus?: OutletKycFilter;

  /**
   * Owner-group drill-in: filter the list to the outlets whose Outlet.parentId equals this value.
   * This is the parent ChannelPartner's CUID (exact match) — NOT the partnerCode — so the admin
   * grouping UI can list exactly one group's members. Absent = the full tenant list (unchanged).
   */
  @IsOptional()
  @IsString()
  parentId?: string;
}
