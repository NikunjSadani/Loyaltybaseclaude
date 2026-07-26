import { Type } from 'class-transformer';
import {
  IsArray,
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
  ValidateNested,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { SchemeStatus } from '@prisma/client';
import { CAMPAIGN_TYPES, CampaignType, validateFormSchema } from '../enrollment-form.helper';

/**
 * scheme-admin.dto.ts — Wave-0 scheme DATA-COLLECTION admin-authoring DTOs.
 *
 * These supersede the reward-era `schemes.dto.ts` create/update shapes (D5/D6):
 *   • No reward-type / budget / holding-period / KPI / stackable / priority in the
 *     create/edit UI — a scheme is an enrollment-only data-collection instrument.
 *     `schemeType` / `rewardType` remain non-null DB columns and are written as
 *     INERT defaults by the service; the admin never configures them.
 *   • Create is DRAFT-or-ACTIVE (not hard-coded ACTIVE); edit is in-place; status
 *     is a dedicated transition endpoint validated against the real SchemeStatus
 *     enum (the "Archive → ARCHIVED" 400 is gone — ARCHIVED is not a valid value).
 *
 * See docs/plans/SCHEME-DATA-COLLECTION-DESIGN.md §13.2 / §13.4.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/** Status a scheme may be created in (D6) — DRAFT (default) or immediately ACTIVE. */
const CREATE_STATUSES = ['DRAFT', 'ACTIVE'] as const;
export type CreateStatus = (typeof CREATE_STATUSES)[number];

export class CreateSchemeAdminDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  /**
   * Initial lifecycle state (D6). DRAFT by default so a half-configured scheme is
   * never visible to the field force; the admin flips it ACTIVE (here or via the
   * status endpoint) when the form + audience are ready.
   */
  @IsOptional()
  @IsIn(CREATE_STATUSES as unknown as string[], {
    message: `status must be one of: ${CREATE_STATUSES.join(', ')}`,
  })
  status?: CreateStatus = 'DRAFT';
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit-in-place (D6/D7 — no more "publish = duplicate")
// ─────────────────────────────────────────────────────────────────────────────

export class UpdateSchemeAdminDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status transition (activate / pause — D6)
// ─────────────────────────────────────────────────────────────────────────────

export class SetSchemeStatusDto {
  /**
   * Target status — validated against the real Prisma SchemeStatus enum
   * (DRAFT | ACTIVE | PAUSED | EXPIRED | CANCELLED). The old FE "Archive"
   * action sent ARCHIVED (not a member) and 400'd; that value can no longer be
   * expressed here.
   */
  @IsEnum(SchemeStatus)
  status!: SchemeStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment form (versioned — D11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Custom class-validator decorator: validates the formSchema structure using the
 * pure `validateFormSchema` helper (same contract the reward-era DTO used). Each
 * structural error is concatenated into a single validation message.
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
          return validateFormSchema(value).length === 0;
        },
        defaultMessage(args: ValidationArguments): string {
          return validateFormSchema(args.value).join(' | ');
        },
      },
    });
  };
}

export class UpsertEnrollmentFormAdminDto {
  @IsIn(CAMPAIGN_TYPES as unknown as string[], {
    message: `campaignType must be one of: ${CAMPAIGN_TYPES.join(', ')}`,
  })
  campaignType!: CampaignType;

  @IsObject()
  @IsValidFormSchema()
  formSchema!: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audience (§13.2)
// ─────────────────────────────────────────────────────────────────────────────

const AUDIENCE_MODES = ['FILTER', 'EXCEL'] as const;
export type AudienceMode = (typeof AUDIENCE_MODES)[number];

/**
 * Mode-A filter (inclusions only — D17a). All present on the Outlet master:
 * outletTypeId / programName / programCategory / zone / state. `kycApprovedOnly`
 * → the service maps to `isActive:true` (trap #1).
 */
export class AudienceFilterDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  outletTypeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  programNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  programCategories?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  zones?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  states?: string[];

  @IsBoolean()
  kycApprovedOnly!: boolean;
}

export class SetAudienceDto {
  @IsIn(AUDIENCE_MODES as unknown as string[], {
    message: `mode must be one of: ${AUDIENCE_MODES.join(', ')}`,
  })
  mode!: AudienceMode;

  /** Applies to matched real outlets only (D21). */
  @IsBoolean()
  selfEnrollAllowed!: boolean;

  /**
   * FILTER only: `true` → materialize a SchemeOutlet snapshot at save (frozen
   * roster); `false` → live-rule (roster rows created lazily on first enroll).
   * For EXCEL mode the roster comes from the upload and this is inert.
   */
  @IsBoolean()
  frozen!: boolean;

  /** Required in FILTER mode; ignored in EXCEL mode. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AudienceFilterDto)
  filter?: AudienceFilterDto;
}

// ─────────────────────────────────────────────────────────────────────────────
// Roster upload (Mode B, §13.4) + roster listing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional header-name overrides for the roster .xlsx (Mode B). The upload is the
 * primary input (multipart `file`); these let an admin whose sheet uses different
 * header text point the parser at the id / name / tagged-employee columns. When
 * omitted the parser recognises the default headers (see scheme-roster.helper).
 * Every column that is NOT one of these three is captured as a prefill variable.
 */
export class RosterUploadDto {
  @IsOptional()
  @IsString()
  idColumn?: string;

  @IsOptional()
  @IsString()
  nameColumn?: string;

  @IsOptional()
  @IsString()
  taggedEmployeeColumn?: string;
}

export class RosterQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
