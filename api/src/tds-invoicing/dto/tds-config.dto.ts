/**
 * DTOs for the Gifsy per-tenant TDS-policy config endpoint — Wave 1 Stream C.
 *
 *   PUT /v1/admin/tds/config   { clientId, section, methodology }   (GIFSY_ADMIN-only SET)
 *   GET /v1/admin/tds/config?clientId=                              (GIFSY any tenant / tenant own)
 *
 * The SET writes the `tdsPolicy` program-setting through the existing settings write path
 * (AdminCoreService.upsertSetting), which appends the W0-C config-change AuditLog and busts the
 * TenantSettingsService cache. `section` / `methodology` are validated here against the exact
 * Prisma enums so a malformed value can never reach the money-path store.
 */

import { IsEnum, IsOptional, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
import { TdsMethodology, TdsSection } from '@prisma/client';

/** PUT body — the per-tenant TDS treatment for VISIBILITY-stream payouts. */
export class SetTdsConfigDto {
  /** The tenant this policy applies to (per-tenant config; Gifsy sets it for a tenant). */
  @IsString()
  @MinLength(1)
  clientId!: string;

  /** SEC_194R (incentive/benefit) | SEC_194C (visibility service). */
  @IsEnum(TdsSection, {
    message: `section must be one of ${Object.values(TdsSection).join(', ')}`,
  })
  section!: TdsSection;

  /** DEDUCT (withhold-then-pay + carry-forward) | GROSS_UP (pay full + TDS invoice + recovery). */
  @IsEnum(TdsMethodology, {
    message: `methodology must be one of ${Object.values(TdsMethodology).join(', ')}`,
  })
  methodology!: TdsMethodology;
}

/**
 * PUT /v1/admin/tds/config/imported-payouts body — per-tenant "count imported (vendor) payouts in
 * the 194R report from this date". `countFrom` is REQUIRED in the body: a 'YYYY-MM-DD' IST calendar
 * date turns it ON from that day; an explicit `null` turns it OFF. (The real-date check — e.g.
 * rejecting 2026-02-30 — happens in the controller via parseIsoCalendarDate.)
 */
export class SetImportedPayoutsConfigDto {
  @IsString()
  @MinLength(1)
  clientId!: string;

  @ValidateIf((o: SetImportedPayoutsConfigDto) => o.countFrom !== null)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'countFrom must be a date in YYYY-MM-DD format, or null to turn it off' })
  countFrom!: string | null;
}

/** GET query — optional tenant scope (GIFSY only; CLIENT_ADMIN is pinned to their own tenant). */
export class GetTdsConfigQueryDto {
  @IsOptional()
  @IsString()
  clientId?: string;
}
