import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { WalletTransactionType } from '@prisma/client';

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

  /** GIFSY admins may inspect another user's passbook by userId; ignored for others. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  limit?: number = 20;
}
