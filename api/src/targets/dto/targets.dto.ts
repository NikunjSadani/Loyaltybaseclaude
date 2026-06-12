import {
  IsString, IsOptional, IsInt, IsArray, IsDateString, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TargetRowDto {
  @IsString()
  partnerId!: string;

  @IsDateString()
  periodStartDate!: string;

  @IsDateString()
  periodEndDate!: string;

  @IsOptional() @IsInt() @Min(0)
  targetValuePaise?: number;

  @IsOptional() @IsInt() @Min(0)
  targetQty?: number;

  @IsOptional() @IsInt() @Min(0)
  targetPoints?: number;

  @IsOptional() @IsString()
  schemeId?: string;

  @IsOptional() @IsString()
  salesUserId?: string;
}

export class UpsertTargetsDto {
  @IsOptional() @IsString()
  schemeId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TargetRowDto)
  rows!: TargetRowDto[];
}
