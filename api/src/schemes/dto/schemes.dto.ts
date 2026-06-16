import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { RewardType, SchemeStatus, SchemeType } from '@prisma/client';

/**
 * Schemes DTOs — ported from platform/src/app/api/schemes/* zod schemas.
 * Dropped (World-A compute) fields are intentionally absent: pointsPerRupee,
 * fixedPoints, maxPointsPerCycle, and the scheme `rules`/`slabs` (SchemeRule)
 * relation. Prisma enums are reused so the value sets stay in lockstep.
 */
export class CreateSchemeDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(SchemeType)
  schemeType!: SchemeType;

  @IsEnum(RewardType)
  rewardType!: RewardType;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  holdingPeriodDays?: number = 30;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  budgetPaise?: number;

  @IsOptional()
  @IsString()
  termsAndConditions?: string;

  @IsOptional()
  @IsBoolean()
  isStackable?: boolean = false;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number = 0;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateSchemeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(SchemeStatus)
  status?: SchemeStatus;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsObject()
  eligibility?: Record<string, unknown>;
}

export class ListSchemesQueryDto {
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

export class ListTargetsQueryDto {
  @IsOptional()
  @IsString()
  userId?: string;

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
