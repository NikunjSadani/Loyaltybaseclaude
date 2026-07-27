import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/**
 * visibility-capture.dto.ts — Stream-B DTOs for the Visibility (POSM) feature:
 * sales capture submit/resubmit, the GIFSY admin review queue filters + reject
 * reason, and the report/export query.
 *
 * Design: docs/plans/VISIBILITY-POSM-DESIGN.md §6/§7 (D7/D8/D10/D11/D12/D15).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Controlled reject-reason codes (D12)
//
// The single source of truth for the review reject-reason vocabulary. Held here
// (not in the service) so BOTH the DTO validator and the service reference the
// same list without a service↔DTO import cycle; VisibilityReviewService re-exports
// it as VISIBILITY_REJECT_REASONS.
// ─────────────────────────────────────────────────────────────────────────────
export const VISIBILITY_REJECT_REASON_CODES = [
  'BLURRY',
  'WRONG_OUTLET',
  'POSM_NOT_VISIBLE',
  'GEO_MISMATCH',
  'DUPLICATE_PHOTO',
  'OTHER',
] as const;
export type VisibilityRejectReasonCode = (typeof VISIBILITY_REJECT_REASON_CODES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Sales capture (D8/D10/D11)
// ─────────────────────────────────────────────────────────────────────────────

/** POST /v1/visibility/capture — a sales rep submits a capture for one in-scope outlet. */
export class SubmitCaptureDto {
  /** The `Outlet.id` being captured. Re-authorized (level + reach) in the service. */
  @IsString()
  @MinLength(1)
  outletId!: string;

  /**
   * Submitted form values keyed by formField.id. CAMERA fields carry a stored object
   * key (from POST media); the GPS_POINT field carries a `{lat,lng,accuracy,capturedAt}`
   * blob used for the geo-fence check.
   */
  @IsOptional()
  @IsObject()
  formValues?: Record<string, unknown>;
}

/** POST /v1/visibility/captures/:id/resubmit — re-capture after a rejection (D11). */
export class ResubmitCaptureDto {
  @IsOptional()
  @IsObject()
  formValues?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin review queue (D12)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /v1/visibility/captures — GIFSY admin review-queue filters. */
export class AdminListCapturesQueryDto {
  /** Filter to a single window (`YYYY-MM-Pn`). */
  @IsOptional()
  @IsString()
  windowKey?: string;

  /** SUBMITTED | APPROVED | REJECTED. */
  @IsOptional()
  @IsIn(['SUBMITTED', 'APPROVED', 'REJECTED'])
  status?: 'SUBMITTED' | 'APPROVED' | 'REJECTED';

  /** Filter by outlet code (exact). */
  @IsOptional()
  @IsString()
  outletCode?: string;

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

/** POST /v1/visibility/captures/:id/reject (GIFSY_ADMIN). */
export class RejectCaptureDto {
  /** Controlled reject reason code — must be one of VISIBILITY_REJECT_REASON_CODES. */
  @IsString()
  @IsIn(VISIBILITY_REJECT_REASON_CODES as unknown as string[], {
    message: `reasonCode must be one of: ${VISIBILITY_REJECT_REASON_CODES.join(', ')}`,
  })
  reasonCode!: VisibilityRejectReasonCode;

  /** Optional free-text detail stored alongside the code. */
  @IsOptional()
  @IsString()
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports (D15)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /v1/visibility/report[/tenant|/export] — optional window scoping. */
export class VisibilityReportQueryDto {
  /** Window key (`YYYY-MM-Pn`); defaults to the current window when omitted. */
  @IsOptional()
  @IsString()
  windowKey?: string;
}
