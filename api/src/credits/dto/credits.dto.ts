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

/** PATCH /admin/credits/fields/:id — activate/deactivate. */
export class PatchFieldDto {
  @IsEnum(FieldAction)
  action!: FieldAction;
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
