import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CreditAwardType } from '@prisma/client';

/**
 * Credits & Payouts DTOs — ported from the zod schemas in
 * platform/src/app/api/admin/credits/*. class-validator mirrors each zod rule
 * (regex, enum, min, defaults). Prisma's CreditAwardType is reused for the
 * POINTS/PAYOUT enum so the persisted value matches the schema exactly.
 */

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** Row-status enum from the upload-row zod schema (OK | ERROR | SKIP). */
export enum UploadRowStatus {
  OK = 'OK',
  ERROR = 'ERROR',
  SKIP = 'SKIP',
}

/** A single parsed upload row stored on CreditBatch.rows (Json). */
export class UploadRowDto {
  @IsNumber()
  rowNum!: number;

  @IsString()
  outletId!: string;

  @IsString()
  outletName!: string;

  @IsString()
  fieldId!: string;

  @IsString()
  fieldName!: string;

  /**
   * Payout or points amount for this outlet+field row.
   * PAYOUT rows: integer paise (e.g. 10000 = ₹100.00).
   * POINTS rows: whole points (a count, NOT money — no ×100).
   */
  @IsInt()
  amount!: number;

  @IsOptional()
  @IsString()
  narration: string = '';

  @IsEnum(CreditAwardType)
  awardType!: CreditAwardType;

  @IsEnum(UploadRowStatus)
  status!: UploadRowStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  errors: string[] = [];

  /**
   * Human-readable reason a row was SKIP'd (e.g. NA for its outlet type, or a
   * blank/zero value). Optional, display-only — carried through to the upload
   * report; not used by any money-path logic.
   */
  @IsOptional()
  @IsString()
  skipReason?: string;
}

/** POST /admin/credits/batches — create a new batch. */
export class CreateBatchDto {
  @Matches(PERIOD_RE, { message: 'Period must be YYYY-MM' })
  period!: string;

  @IsInt()
  @Min(0)
  totalOutlets!: number;

  /** Whole points (a count, NOT money — no ×100 conversion). */
  @IsInt()
  @Min(0)
  totalPoints!: number;

  /** Total payout in integer paise (e.g. 1000000 = ₹10,000.00). */
  @IsInt()
  @Min(0)
  totalPayoutPaise!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UploadRowDto)
  rows!: UploadRowDto[];
}

/** GET /admin/credits/fields — optional ?active=true filter. */
export class ListFieldsQueryDto {
  @IsOptional()
  @IsString()
  active?: string;
}

/** POST /admin/credits/fields — create a credit field definition. */
export class CreateFieldDto {
  @IsString()
  @MinLength(1, { message: 'Name is required' })
  name!: string;

  @IsOptional()
  @IsBoolean()
  isSeparatePayout: boolean = false;

  @IsOptional()
  @IsObject()
  outletTypeAwards: Record<string, string> = {};
}

/** Field activate/deactivate action. */
export enum FieldAction {
  activate = 'activate',
  deactivate = 'deactivate',
}

/**
 * Award value for a field's per-outlet-type map. POINTS → credited to the
 * partner wallet; PAYOUT → routed to the bank payout file; NA → row is skipped
 * for that outlet type. (NA is NOT a Prisma CreditAwardType — it is a "skip"
 * sentinel that lives only in the field's outletTypeAwards map.)
 */
export enum FieldAwardValue {
  POINTS = 'POINTS',
  PAYOUT = 'PAYOUT',
  NA = 'NA',
}

/**
 * PATCH /admin/credits/fields/:id — either flip active state (`action`) OR set
 * the per-outlet-type award map (`outletTypeAwards`). Both are optional; the
 * service rejects an empty body and validates each award value.
 */
export class PatchFieldDto {
  @IsOptional()
  @IsEnum(FieldAction)
  action?: FieldAction;

  /**
   * Maps outlet type code → award value (POINTS | PAYOUT | NA). A missing key is
   * treated as NA by the parser. Values are validated against FieldAwardValue in
   * the service so a malformed map can never misroute money.
   */
  @IsOptional()
  @IsObject()
  outletTypeAwards?: Record<string, string>;
}

/** GET /admin/credits/payout-downloads — optional ?period filter. */
export class ListPayoutDownloadsQueryDto {
  @IsOptional()
  @IsString()
  period?: string;
}

/** Payout-download group type. */
export enum PayoutGroupType {
  STANDARD = 'STANDARD',
  SEPARATE = 'SEPARATE',
}

/** POST /admin/credits/payout-downloads — generate a bank payout file. */
export class CreatePayoutDownloadDto {
  @Matches(PERIOD_RE)
  period!: string;

  @IsEnum(PayoutGroupType)
  groupType!: PayoutGroupType;

  @IsOptional()
  @IsString()
  fieldId?: string;

  @IsOptional()
  @IsString()
  fieldName?: string;
}

/** GET /admin/credits/reversals — optional ?status / ?period filters. */
export class ListReversalsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  period?: string;
}

/** POST /admin/credits/batches/:id/reversals — initiate a reversal request. */
export class CreateReversalDto {
  @IsString()
  outletId!: string;

  @IsString()
  outletName!: string;

  @IsString()
  fieldId!: string;

  @IsString()
  fieldName!: string;

  @IsEnum(CreditAwardType)
  awardType!: CreditAwardType;

  /** Original awarded amount in integer paise (PAYOUT rows) or whole points (POINTS rows). */
  @IsInt()
  @IsPositive()
  originalPaise!: number;

  /** Requested reversal amount in integer paise (PAYOUT) or whole points (POINTS). */
  @IsInt()
  @IsPositive()
  requestedPaise!: number;
}

/** Reversal approve/reject action. */
export enum ReversalAction {
  approve = 'approve',
  reject = 'reject',
}

/** PATCH /admin/credits/reversals/:id — approve or reject. */
export class PatchReversalDto {
  @IsEnum(ReversalAction)
  action!: ReversalAction;

  /** Approved reversal amount in integer paise (PAYOUT) or whole points (POINTS). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  approvedPaise?: number;

  @IsOptional()
  @IsString()
  remarks?: string;
}

/** Query flag for the UTR upload — ?apply=true applies, otherwise preview. */
export class UtrUploadQueryDto {
  @IsOptional()
  @IsString()
  apply?: string;
}
