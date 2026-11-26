import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CANCEL_REASON_MAX, MAX_CANCEL_ROWS } from '../payout-cancel';

export const ENTRY_PAGE_MAX = 200;

/** GET /admin/credits/payout-entries — the row drill-down (and the cancel selection list). */
export class PayoutEntriesQueryDto {
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsString() fieldId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}$/) period?: string;
  @IsOptional() @IsIn(['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED', 'CANCELLED']) status?: string;
  /** Outlet code / name search. */
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(ENTRY_PAGE_MAX) pageSize?: number;
}

export class CancelItemDto {
  @IsString() @IsNotEmpty() id!: string;
  @IsIn(['PENDING', 'FAILED']) expectedStatus!: 'PENDING' | 'FAILED';
  /** Integer paise the admin saw. */
  @Type(() => Number) @IsInt() @Min(1) expectedAmountPaise!: number;
}

/** POST /admin/credits/payout-cancellations/preview — what WOULD be cancelled (no write). */
export class CancelPreviewDto {
  @IsIn(['UNPAID', 'FAILED']) kind!: 'UNPAID' | 'FAILED';
  /** Either the rows the admin ticked … */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_CANCEL_ROWS) @IsString({ each: true }) entryIds?: string[];
  /** … or every row of this kind in an upload (optionally one field). */
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsString() fieldId?: string;
}

/** POST /admin/credits/payout-cancellations — cancel exactly these rows (whole request or nothing). */
export class CancelPayoutsDto {
  @IsIn(['UNPAID', 'FAILED']) kind!: 'UNPAID' | 'FAILED';
  @IsString() @IsNotEmpty() @MaxLength(CANCEL_REASON_MAX) reason!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_CANCEL_ROWS) @ValidateNested({ each: true }) @Type(() => CancelItemDto)
  items!: CancelItemDto[];
}

/** GET /admin/credits/payout-cancellations/template — pre-filled from the screen's filter. */
export class CancelTemplateQueryDto {
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsString() fieldId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}$/) period?: string;
  /** PENDING = unpaid only, FAILED = failed only, ALL (default) = both. */
  @IsOptional() @IsIn(['PENDING', 'FAILED', 'ALL']) status?: 'PENDING' | 'FAILED' | 'ALL';
}
