import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { VisibilityCaptureMode } from '../../tenant/tenant.service';

/**
 * DTOs for admin/settings — ported from platform/src/app/api/admin/settings/route.ts.
 * The Zod schema there allows `value: z.any()`, so `value` is left untyped here.
 */
export class UpsertSettingDto {
  @IsString()
  @MinLength(1)
  key!: string;

  // @Allow() whitelists the property without constraining its type — the
  // faithful equivalent of the source's `value: z.any()` (accepts scalars,
  // objects, or arrays). Needed because the global pipe sets forbidNonWhitelisted.
  @Allow()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value!: any;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * DTO for PUT /v1/admin/settings/otp-templates (B11, GIFSY_ADMIN-only).
 *   clientId — the tenant the card LOADED (GET returns it). The server rejects a mismatch with the
 *              caller's current (assumed) tenant with 409, so a save can never land on a brand that was
 *              switched in another tab after the card loaded.
 *   changes  — ONLY the purposes the operator edited ({ login?, redemptionSelf?, kycConsent?,
 *              redemptionSales? }); merged server-side onto the freshly-read STORED row, so untouched
 *              purposes can never be blanked. Values are strictly validated in the service.
 */
export class SaveOtpTemplatesDto {
  @IsString()
  @MinLength(1)
  clientId!: string;

  @IsObject()
  changes!: Record<string, unknown>;
}

/**
 * DTO for PUT /v1/admin/settings/visibility-capture-mode.
 * Only the two valid enum values are accepted; anything else produces a 400.
 */
export class SetVisibilityCaptureModeDto {
  @IsEnum(['PHOTO_APPROVAL', 'AMOUNT_UPLOAD'] as const, {
    message: 'mode must be PHOTO_APPROVAL or AMOUNT_UPLOAD',
  })
  mode!: VisibilityCaptureMode;
}

/**
 * DTO for PUT /v1/admin/settings/points-expiry.
 *
 * `pointsExpiryDays`:
 *   - `null`            → never expire (the tenant's default config is deactivated).
 *   - positive integer  → earned points expire that many days after they're granted.
 *
 * `@ValidateIf` skips the @IsInt/@Min constraints when the value is exactly `null`,
 * so an explicit null passes; any non-null value must be an integer >= 1.
 */
export class SetPointsExpiryDto {
  @ValidateIf((o) => o.pointsExpiryDays !== null)
  @IsInt()
  @Min(1)
  @Max(36500) // ~100 years; guards against Int4 overflow / absurd values
  pointsExpiryDays!: number | null;
}

/**
 * One national-holiday entry: a strict `YYYY-MM-DD` date + a human label. The service also
 * re-validates that the date is a REAL calendar day (rejects 2026-02-30) and de-dups by date.
 */
export class HolidayItemDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;
}

/**
 * DTO for PUT /v1/admin/settings/holidays — the platform national holiday calendar (GIFSY_ADMIN
 * only). Replaces the whole list. Capped at 366 entries (one year's worth) as a sanity bound.
 */
export class SetHolidaysDto {
  @IsArray()
  @ArrayMaxSize(366)
  @ValidateNested({ each: true })
  @Type(() => HolidayItemDto)
  holidays!: HolidayItemDto[];
}

/**
 * DTO for PUT /v1/admin/settings/report-recipients — the platform-global recipient list of the
 * internal Daily Operations Digest (GIFSY_ADMIN only). Replaces the whole store (the legacy
 * per-report lists are dropped on save). Capped at 50 addresses; each must be a valid email. The
 * service further lowercases + de-dups, and REFUSES (400) any address whose domain is not on the
 * internal allow-list (REPORTS_RECIPIENT_DOMAINS, default gifsy.in — env-driven, so it is enforced
 * in the service rather than a static decorator here).
 */
export class SetReportRecipientsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  dailyDigest!: string[];
}
