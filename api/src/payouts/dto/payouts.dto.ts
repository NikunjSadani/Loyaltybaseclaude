import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';
import { PayoutMode, PayoutStatus } from '@prisma/client';

/** GET /v1/payouts/transactions — filters + pagination. */
export class ListTransactionsQueryDto {
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  // Source uses ?mode= for the payout mode filter.
  @IsOptional()
  @IsEnum(PayoutMode)
  mode?: PayoutMode;

  @IsOptional()
  @IsString()
  partnerId?: string;

  // When true, return only unbatched waiting transactions (batchId null + PENDING)
  // so an operator can see what's eligible for the batch-from-pending sweep.
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unbatched?: boolean;

  // Date-only (`YYYY-MM-DD`) or full-ISO string bounds. Kept as STRINGS (not
  // `@Type(() => Date)`) so `istDayRangeFilter` in the service can detect a
  // date-only value and expand it to a FULL INCLUSIVE IST day (a raw
  // `new Date("YYYY-MM-DD")` is 05:30 IST → would skew the start + truncate the
  // last IST day). Mirrors the schemes/gift/reports filter DTOs.
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

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

/** GET /v1/payouts/batches — pagination only. */
export class ListBatchesQueryDto {
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

/** GET /v1/payouts/batches/:id — pagination of the batch's transactions. */
export class BatchDetailQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}

/** GET /v1/payouts/reconciliation — optional batch filter for the export. */
export class ReconciliationQueryDto {
  @IsOptional()
  @IsString()
  batchId?: string;
}

/** POST /v1/payouts/batches/:id/utr — preview unless ?apply=true. */
export class PayoutUtrUploadQueryDto {
  @IsOptional()
  @IsString()
  apply?: string;
}

/** POST /v1/payouts/batches — create a DRAFT batch.
 *  Source restricts payoutMode to a 4-value set that matches the PayoutMode enum. */
export class CreateBatchDto {
  @IsEnum(PayoutMode)
  payoutMode!: PayoutMode;

  @IsOptional()
  @IsString()
  notes?: string;
}

/** POST /v1/payouts/fund/receive — record a fund receipt (GIFSY-only). */
export class ReceiveFundDto {
  @IsNumber()
  @IsPositive({ message: 'Amount must be positive' })
  amount!: number;

  @IsOptional()
  @IsString()
  referenceNumber?: string;

  // Source coerces the incoming string to a Date.
  // @IsDate is required so the global forbidNonWhitelisted ValidationPipe keeps
  // this property instead of rejecting it ("property paymentDate should not exist").
  @IsDate()
  @Type(() => Date)
  paymentDate!: Date;

  @IsOptional()
  @IsString()
  paymentMode?: string = 'BANK_TRANSFER';

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
