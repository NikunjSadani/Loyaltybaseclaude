import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { RewardType, SchemeStatus, SchemeType } from '@prisma/client';
import { CAMPAIGN_TYPES, CampaignType, validateFormSchema } from '../enrollment-form.helper';

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

// ─────────────────────────────────────────────────────────────────────────────
// P4.2 — Enrollment-form DTOs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Custom decorator: validates formSchema structure using the pure helper.
 * Reports each structural error individually (they are concatenated into a
 * single validation message via class-validator's message function).
 */
function IsValidFormSchema(validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isValidFormSchema',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          const errors = validateFormSchema(value);
          return errors.length === 0;
        },
        defaultMessage(args: ValidationArguments): string {
          const errors = validateFormSchema(args.value);
          return errors.join(' | ');
        },
      },
    });
  };
}

/**
 * DTO for PUT /v1/schemes/:id/enrollment-form
 *
 * campaignType — enrollment audience model (LOYALTY_ONLY | OPEN_CAMPAIGN | MIXED).
 * formSchema   — EnrollmentFormSchema object validated by the pure helper.
 */
export class UpsertEnrollmentFormDto {
  @IsIn(CAMPAIGN_TYPES as unknown as string[], {
    message: `campaignType must be one of: ${CAMPAIGN_TYPES.join(', ')}`,
  })
  campaignType!: CampaignType;

  @IsObject()
  @IsValidFormSchema()
  formSchema!: Record<string, unknown>;
}

