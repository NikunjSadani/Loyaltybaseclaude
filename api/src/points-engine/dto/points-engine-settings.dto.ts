/**
 * DTOs for the dedicated, owner-only Points Engine settings endpoint (Wave 2).
 *
 *   PUT /v1/admin/points-engine/settings  { clientId, enabled, directCreditEnabled }  (GIFSY_ADMIN-only SET)
 *   GET /v1/admin/points-engine/settings?clientId=                                     (GIFSY any / tenant own)
 *
 * directCreditEnabled turns ON the in-portal compute→confirm→wallet-credit shortcut, so the SET is
 * GIFSY_ADMIN-only and routes through AdminCoreService.upsertSetting with allowPlatformOnlyKey (the
 * ONLY path allowed to write the `pointsEngine` key — the generic settings PUT is fenced off at the
 * data boundary, exactly like tdsStatutory/notificationTemplates). Mirrors the TDS-config pattern.
 */

import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/** PUT body — the per-tenant Points Engine flags (Gifsy sets them for a tenant). */
export class SetPointsEngineSettingsDto {
  @IsString()
  @MinLength(1)
  clientId!: string;

  /** Enables the (read-only) compute/preview/export for the tenant. */
  @IsBoolean()
  enabled!: boolean;

  /** Enables the in-portal direct-credit (compute → PENDING batch → operator confirm → wallet). */
  @IsBoolean()
  directCreditEnabled!: boolean;
}

/** GET query — optional tenant scope (GIFSY only; CLIENT_ADMIN is pinned to their own tenant). */
export class GetPointsEngineSettingsQueryDto {
  @IsOptional()
  @IsString()
  clientId?: string;
}
