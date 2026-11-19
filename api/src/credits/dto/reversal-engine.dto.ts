import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { REVERSAL_ENGINE_MODES, type ReversalEngineMode } from '../../tenant/tenant-settings.service';

/** GET /v1/admin/credits/reversal-engine/attention — list cap (totals are always exact). */
export class ReversalAttentionQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/**
 * GET /v1/admin/credits/reversal-engine/wallets-in-debt — `limit` up to 5,000 (the Excel download asks for the most;
 * the response says when it is still cut), optional `programName` (same program scope as the admin dashboards).
 */
export class WalletsInDebtQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;

  @IsOptional()
  @IsString()
  programName?: string;
}

/** POST /v1/admin/credits/reversal-engine/pause — GIFSY turns the POINTS reversal pause on / off (audited). */
export class ReversalPauseDto {
  @IsBoolean()
  paused!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  /**
   * The program to act on (fix round A, L6). REQUIRED for a Gifsy user who is not working inside a program (an
   * un-assumed session would otherwise target Gifsy's own home tenant); when working inside one it must match it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientId?: string;
}

/**
 * POST /v1/admin/credits/reversal-engine/mode — GIFSY_ADMIN sets the tenant's points reversal engine (fix round A, M2).
 * The only write path for `reversalEngine` (the generic settings upsert refuses the key). Audited.
 */
export class ReversalEngineModeDto {
  @IsIn(REVERSAL_ENGINE_MODES as unknown as string[])
  mode!: ReversalEngineMode;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  /** Same tenant rule as ReversalPauseDto.clientId (L6). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientId?: string;
}
