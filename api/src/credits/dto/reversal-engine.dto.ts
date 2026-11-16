import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** GET /v1/admin/credits/reversal-engine/attention — list cap (totals are always exact). */
export class ReversalAttentionQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/** POST /v1/admin/credits/reversal-engine/pause — GIFSY turns the POINTS reversal pause on / off (audited). */
export class ReversalPauseDto {
  @IsBoolean()
  paused!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
