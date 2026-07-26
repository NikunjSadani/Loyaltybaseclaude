import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Scheme Data-Collection — enrollment-engine DTOs (Wave-0, §13.4).
 *
 * These back the NEW roster-anchored enrollment surface and are kept separate from
 * the legacy `dto/schemes.dto.ts` (which serves the superseded partner-keyed path).
 * The subject of every enroll/OTP call is a `SchemeOutlet` roster row resolved by:
 *   - `targetSchemeOutletId` — an existing roster row (Excel Mode B, frozen snapshot,
 *     or a previously lazy-created live-rule row); OR
 *   - SELF  → the active partner's own matched outlet (find-or-create), OR
 *   - SALES → `targetOutletRef` naming a tenant outlet in the caller's reach (find-or-create).
 */

export const ENROLLMENT_MODES = ['SELF', 'SALES'] as const;
export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];

/** Common subject-resolution fields shared by enroll + OTP endpoints. */
class SchemeSubjectDto {
  @IsOptional()
  @IsIn(ENROLLMENT_MODES as unknown as string[], {
    message: 'enrollmentMode must be SELF or SALES',
  })
  enrollmentMode?: EnrollmentMode = 'SELF';

  /**
   * The roster row (`SchemeOutlet.id`) being enrolled. Preferred identifier — resolves
   * a materialized roster row (matched or standalone). NEVER trusted without a
   * tenant + scheme + reach re-authorization in the service.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  targetSchemeOutletId?: string;

  /**
   * For a Mode-A live-rule scheme with no roster row yet: the outlet id (`Outlet.id`)
   * naming the outlet to lazily add to the roster + enroll. SALES only for a matched
   * outlet in reach; standalone rows come only from an Excel upload.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  targetOutletRef?: string;
}

/** POST /v1/schemes/:id/enroll */
export class EnrollDto extends SchemeSubjectDto {
  /**
   * Submitted form values keyed by formField.id. CALCULATED + LOOKUP fields may be
   * present but are ignored (server recomputes/resolves). Media fields carry a stored
   * object key (from POST media). GPS fields carry a `{lat,lng,accuracy,capturedAt}` blob.
   */
  @IsOptional()
  @IsObject()
  formValues?: Record<string, unknown>;

  /**
   * The mobile the filler typed for an editable PHONE_OTP field. Ignored for a
   * KYC-approved matched outlet (the field is pinned to the owner's on-file number, D16).
   */
  @IsOptional()
  @IsString()
  mobile?: string;
}

/** POST /v1/schemes/:id/enrollments/:enrollmentId/resubmit */
export class ResubmitEnrollmentDto {
  @IsOptional()
  @IsObject()
  formValues?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  mobile?: string;
}

/** POST /v1/schemes/:id/enroll/otp-send */
export class SendEnrollOtpDto extends SchemeSubjectDto {
  /** The typed mobile (editable field). Ignored for a KYC-approved matched outlet (pinned). */
  @IsOptional()
  @IsString()
  mobile?: string;
}

/** POST /v1/schemes/:id/enroll/otp-verify */
export class VerifyEnrollOtpDto extends SchemeSubjectDto {
  @IsOptional()
  @IsString()
  mobile?: string;

  @IsString()
  @MinLength(4)
  otp!: string;
}

/** POST /v1/schemes/:id/enrollments/:enrollmentId/reject (GIFSY_ADMIN) */
export class RejectEnrollmentDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}

/**
 * GET /v1/schemes/:id/sales-targets — a rep's reachable targets for a scheme.
 *
 * Reach-scoped (tagged-downline + assignment) roster rows PLUS live-rule subtree
 * outlets, each carrying its current enrollment status. Optional status filter +
 * pagination; the reach is bounded, so the union is materialized then paginated.
 */
export const SALES_TARGET_STATUSES = ['NOT_ENROLLED', 'SUBMITTED', 'REJECTED'] as const;
export type SalesTargetStatus = (typeof SALES_TARGET_STATUSES)[number];

export class SalesTargetsQueryDto {
  /** NOT_ENROLLED | SUBMITTED | REJECTED — filter targets by current status. */
  @IsOptional()
  @IsIn(SALES_TARGET_STATUSES as unknown as string[])
  status?: SalesTargetStatus;

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

/** GET /v1/schemes/:id/enrollments (GIFSY_ADMIN) — admin roster + captured-data view. */
export class AdminListEnrollmentsQueryDto {
  /** SUBMITTED | REJECTED — filter by submission status. */
  @IsOptional()
  @IsIn(['SUBMITTED', 'REJECTED'])
  status?: 'SUBMITTED' | 'REJECTED';

  /** Filter roster rows whose matched outlet is of this type / program / zone / state. */
  @IsOptional()
  @IsString()
  outletTypeId?: string;

  @IsOptional()
  @IsString()
  programName?: string;

  @IsOptional()
  @IsString()
  zone?: string;

  @IsOptional()
  @IsString()
  state?: string;

  /** Enrolled-at date window (inclusive ISO dates). */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

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
