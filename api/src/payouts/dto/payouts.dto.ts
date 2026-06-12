import {
  IsString, IsInt, IsOptional, IsArray, IsEnum, IsNumber, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RequestPayoutDto {
  @IsInt() @Min(1)
  amountPaise!: number;

  @IsString()
  bankAccountNumber!: string;

  @IsString()
  ifscCode!: string;

  @IsString()
  beneficiaryName!: string;

  @IsOptional() @IsString()
  beneficiaryPhone?: string;

  @IsOptional() @IsString()
  bankName?: string;

  @IsOptional() @IsString()
  notes?: string;
}

export class CreateBatchDto {
  @IsOptional() @IsString()
  notes?: string;
}

export class PayoutResultRowDto {
  @IsString()
  payoutTransactionId!: string;

  @IsEnum(['SUCCESS', 'FAILED', 'PENDING'])
  status!: string;

  @IsOptional() @IsString()
  utrNumber?: string;

  @IsOptional() @IsString()
  failureReason?: string;
}

export class UploadResultsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PayoutResultRowDto)
  rows!: PayoutResultRowDto[];
}
