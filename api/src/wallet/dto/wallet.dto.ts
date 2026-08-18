import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, Max, MinLength } from 'class-validator';
import { WalletTransactionType } from '@prisma/client';

/** Sanity ceiling on a single manual adjust (points). Guards fat-finger / overflow.
 *  10,000,000 pts ≈ ₹1 crore at rate 1 — a larger single correction should be reviewed. */
const MAX_ADJUST_POINTS = 10_000_000;
/** Upper bound on a passbook page size (the FE requests 20). Guards resource exhaustion. */
const MAX_PAGE_LIMIT = 100;

/** Manual credit/debit adjustment direction — mirrors the source zod enum(['CREDIT','DEBIT']). */
export enum AdjustType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export class AdjustWalletDto {
  @IsString()
  @MinLength(1)
  partnerId!: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(MAX_ADJUST_POINTS, { message: `Amount exceeds the ${MAX_ADJUST_POINTS.toLocaleString('en-IN')}-point manual-adjust ceiling` })
  amount!: number;

  @IsEnum(AdjustType)
  type!: AdjustType;

  @IsString()
  @MinLength(1, { message: 'Reason is required' })
  reason!: string;

  @IsString()
  @MinLength(1, { message: 'Approver is required' })
  approvedBy!: string;
}

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(MAX_PAGE_LIMIT)
  limit?: number = 20;
}

/**
 * Query params for the GIFSY-only admin passbook route
 * (GET /v1/wallet/admin/outlet/:outletId/transactions). Same validators as
 * ListTransactionsQueryDto MINUS the (now-removed) admin `userId` targeting param —
 * the outlet id in the path is the target, so no user targeting param is needed.
 */
export class AdminOutletTxQueryDto {
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(MAX_PAGE_LIMIT)
  limit?: number = 20;
}
