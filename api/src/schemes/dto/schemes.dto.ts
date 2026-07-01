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
  Max,
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
  /**
   * Free-text search (Wave 2 pagination) — matches scheme name OR code,
   * case-insensitively. Moved from the FE client-side `.filter()`.
   */
  @IsOptional()
  @IsString()
  search?: string;

  /**
   * Status filter. When omitted the list returns ALL non-deleted statuses
   * (so the FE "All" pill works); when provided, restricts to that status.
   * Validated against the Prisma SchemeStatus enum.
   */
  @IsOptional()
  @IsEnum(SchemeStatus)
  status?: SchemeStatus;

  /** Scheme-type filter, validated against the Prisma SchemeType enum. */
  @IsOptional()
  @IsEnum(SchemeType)
  type?: SchemeType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
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

// ─────────────────────────────────────────────────────────────────────────────
// P4.3 — Enrollment submission DTOs
// ─────────────────────────────────────────────────────────────────────────────

const ENROLLMENT_MODES = ['SELF', 'SALES'] as const;
export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];

/**
 * DTO for POST /v1/schemes/:id/enroll
 *
 * enrollmentMode — SELF (default) or SALES.
 *   SELF:  the JWT caller enrolls themselves. No targetPartnerId required.
 *   SALES: a sales user enrolls on behalf of a partner. targetPartnerId must
 *          be the ChannelPartner.id of the outlet/partner being enrolled.
 *
 * formValues — the submitted form field values (keyed by formField.id).
 *   May be omitted / empty if the scheme has no enrollment form configured.
 *   CALCULATED fields may be present but are ignored — the server recomputes.
 *   autoFillFromExcel fields may arrive pre-filled and are accepted.
 */
export class SubmitEnrollmentDto {
  @IsOptional()
  @IsIn(ENROLLMENT_MODES as unknown as string[], {
    message: `enrollmentMode must be SELF or SALES`,
  })
  enrollmentMode?: EnrollmentMode = 'SELF';

  /**
   * Required when enrollmentMode === 'SALES'.
   * The ChannelPartner.id of the partner being enrolled on behalf of a sales user.
   * NEVER trusted without an assignment access check server-side.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  targetPartnerId?: string;

  /**
   * The submitted form field values (Record<fieldId, value>).
   * Optional — omit or pass {} if the scheme has no enrollment form.
   */
  @IsOptional()
  @IsObject()
  formValues?: Record<string, unknown>;
}

