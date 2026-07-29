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

import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
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

/** GET query — optional tenant scope (GIFSY only; CLIENT_ADMIN is pinned to their own tenant). */
export class GetTdsConfigQueryDto {
  @IsOptional()
  @IsString()
  clientId?: string;
}
