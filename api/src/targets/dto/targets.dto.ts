import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

// ─── KpiDef DTOs ──────────────────────────────────────────────────────────────

export class UpsertKpiDefDto {
  @IsString()
  code!: string;

  @IsString()
  label!: string;

  @IsString()
  @IsOptional()
  unit?: string;

  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean;

  @IsBoolean()
  @IsOptional()
  hasNameOverride?: boolean;

  @IsString()
  @IsOptional()
  nameOverrideLabel?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  order?: number;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class ListKpisQueryDto {
  /** When 'true', return only enabled KPIs. */
  @IsString()
  @IsOptional()
  enabledOnly?: string;
}

// ─── Template download ────────────────────────────────────────────────────────

export class TemplateQueryDto {
  /**
   * Comma-separated YYYY-MM month strings, e.g. "2026-07,2026-08".
   * At least one month is required.
   */
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])(,\d{4}-(0[1-9]|1[0-2]))*$/, {
    message: 'months must be comma-separated YYYY-MM values (month 01–12)',
  })
  months!: string;
}

// ─── Target upload ────────────────────────────────────────────────────────────

export class UploadTargetsQueryDto {
  /** When 'true', the response includes per-row details (for the preview). */
  @IsString()
  @IsOptional()
  verbose?: string;
}

// ─── List target batches ──────────────────────────────────────────────────────

export class ListBatchesQueryDto {
  @IsString()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' })
  month?: string;
}

// ─── List target rows ─────────────────────────────────────────────────────────

export class ListTargetsQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @IsString()
  @IsOptional()
  outletCode?: string;
}

// ─── Achievement upload ────────────────────────────────────────────────────────

export class UploadAchievementsQueryDto {
  /** When 'true', the response includes per-row details (for the preview). */
  @IsString()
  @IsOptional()
  verbose?: string;
}

// ─── List achievement batches ──────────────────────────────────────────────────

export class ListAchievementBatchesQueryDto {
  @IsString()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' })
  month?: string;
}

// ─── List achievement rows ─────────────────────────────────────────────────────

export class ListAchievementsQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @IsString()
  @IsOptional()
  outletCode?: string;
}

// ─── Pace query ───────────────────────────────────────────────────────────────

export class PaceQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @IsString()
  @IsOptional()
  outletCode?: string;
}
