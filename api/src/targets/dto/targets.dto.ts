import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

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

  /** Aggregation roll-up: 'SUM' (cumulative, default) or 'OUTLET_COUNT' (# outlets that met target). */
  @IsIn(['SUM', 'OUTLET_COUNT'])
  @IsOptional()
  rollup?: 'SUM' | 'OUTLET_COUNT';

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  /**
   * Per-outlet-TYPE tag (E1). Omitted → unchanged on update / null (all types) on create.
   * null or '' → SHARED (applies to every outlet type). A code → that type only; it must be one of
   * the tenant's ENABLED outlet type codes (validated in TargetsService.upsertKpi; 400 otherwise).
   */
  @IsString()
  @IsOptional()
  outletType?: string | null;

  /**
   * APPLIES-TO scope (plan §4). Each facet: omitted → unchanged (create → []); [] → every value of
   * that facet. AND across facets, OR within. `outletTypes` WINS over the legacy `outletType`.
   * Validated in TargetsService.upsertKpi (only when the scope actually changes): outletTypes ⊆ the
   * tenant's enabled outlet types; programs / subPrograms ⊆ settings list ∪ live outlet values (ci,
   * canonicalised) → 400 listing allowed values otherwise.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  outletTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  programs?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subPrograms?: string[];
}

/**
 * A repeated query param (`programs=A&programs=B`) arrives as string[]; a single one as a string.
 * Always an array afterwards. Values are NEVER split on ',' (a program name may contain a comma).
 */
export const toQueryArray = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null ? undefined : Array.isArray(value) ? value : [value];

/**
 * GET /v1/admin/kpis/scope-count query — each facet is a REPEATED param
 * (`?outletTypes=SSS&outletTypes=WS&programs=Gold`); absent / blank = all.
 */
export class KpiScopeCountQueryDto {
  @IsOptional()
  @Transform(toQueryArray)
  @IsArray()
  @IsString({ each: true })
  outletTypes?: string[];

  @IsOptional()
  @Transform(toQueryArray)
  @IsArray()
  @IsString({ each: true })
  programs?: string[];

  @IsOptional()
  @Transform(toQueryArray)
  @IsArray()
  @IsString({ each: true })
  subPrograms?: string[];
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

  /** '1' / 'true' → validate + preview only; NOTHING is written (the admin screen's first step). */
  @IsOptional()
  @IsIn(['1', 'true', '0', 'false'])
  preview?: string;

  /** The previewToken of the preview being confirmed — the same file must be posted again. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}\.[a-f0-9]{32}$/, { message: 'confirmToken is not a valid preview token' })
  confirmToken?: string;

  /**
   * With confirmToken: the not-applied categories the admin acknowledged, comma-separated
   * (REJECTED_ROWS,OVERWRITE,LOCKED_MONTHS,BLANK_ROWS,IGNORED_VALUES). '' = none.
   */
  @IsOptional()
  @IsString()
  @Matches(/^$|^(REJECTED_ROWS|OVERWRITE|LOCKED_MONTHS|BLANK_ROWS|IGNORED_VALUES)(,(REJECTED_ROWS|OVERWRITE|LOCKED_MONTHS|BLANK_ROWS|IGNORED_VALUES))*$/, {
    message: 'ack must be a comma-separated list of REJECTED_ROWS, OVERWRITE, LOCKED_MONTHS, BLANK_ROWS, IGNORED_VALUES',
  })
  ack?: string;
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

// ─── Achievement template download ──────────────────────────────────────────────

export class AchievementTemplateQueryDto {
  /**
   * Single YYYY-MM month for the achievement template, e.g. "2026-06".
   * The achievement (sales) upload is always for one historical month.
   */
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be a YYYY-MM value (month 01–12)',
  })
  month!: string;
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
