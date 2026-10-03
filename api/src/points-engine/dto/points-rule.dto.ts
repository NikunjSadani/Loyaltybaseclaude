/**
 * Points Compute Engine — CRUD DTOs (Wave 0).
 *
 * Shape-level validation only (presence + primitive types + the YYYY-MM-DD date
 * format). The DEEP, authoritative validation of attachsTo/output/rounding/inputs/
 * pipeline is done by `validateRule(PointsRuleConfig)` in points-engine.helper.ts
 * at save time (createDraft/updateDraft/publish) — a single source of truth both the
 * store and the evaluator build against. We deliberately do NOT re-encode the pipeline
 * node grammar as nested class-validator classes here (it would fork the contract).
 */

import { Allow, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { AwardType, RoundingSpec, RuleAttachment, RuleStatus } from '../points-engine.types';

/**
 * ⚠️ The nested config props are typed `unknown` + `@Allow()` ON PURPOSE. The global ValidationPipe runs
 * `transform + enableImplicitConversion`; a prop whose reflected design-type is an ARRAY (e.g.
 * `inputs: RuleInput[]`) gets each element COERCED to `[]`, so validateRule then rejects
 * "inputs[0]: must be an object". Reflected-type `Object` (a plain object, or `unknown`) is left
 * untouched — so we type the free-form config as `unknown` and let validateRule (the single authority)
 * validate the real shape. @Allow() keeps the prop past the whitelist. Do NOT re-type these as arrays.
 */

/** Calendar day, no time component — matches the @db.Date columns. */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Create a DRAFT rule.
 *   - Omit `ruleId` to create a brand-new logical rule (version 1).
 *   - Pass an existing `ruleId` to spin up the NEXT draft version of that rule
 *     (the way a published rule is "edited" — a published version is never mutated).
 */
export class CreatePointsRuleDto {
  @IsString()
  @IsOptional()
  ruleId?: string;

  @IsString()
  @Matches(DATE_RE, { message: 'effectiveFrom must be a YYYY-MM-DD date' })
  effectiveFrom!: string;

  @IsString()
  @IsOptional()
  @Matches(DATE_RE, { message: 'effectiveTo must be a YYYY-MM-DD date' })
  effectiveTo?: string | null;

  @IsString()
  @IsOptional()
  @IsIn(['PERIOD_AGGREGATE'], { message: 'evaluationBasis must be PERIOD_AGGREGATE' })
  evaluationBasis?: 'PERIOD_AGGREGATE';

  // The nested config objects/arrays are passed THROUGH untouched (validateRule is the authority) —
  // @Allow() whitelists them without constraints. @IsObject()/@IsArray() here is unsafe: the global pipe
  // (whitelist + transform + enableImplicitConversion) MANGLES @IsArray-typed nested objects (strips each
  // element to a non-object), so validateRule would reject "inputs[0]: must be an object". (Same reason
  // UpsertSettingDto uses @Allow() for its free-form value.)
  /** RuleAttachment { scope, program?, programCategory?, kpiCode } — deep-validated by validateRule. */
  @Allow()
  attachsTo!: RuleAttachment;

  /** { awardType, fieldId } — the credit-field bucket + award type. */
  @Allow()
  output!: { awardType: AwardType; fieldId: string };

  /** RoundingSpec { mode, scale } — single, final rounding. */
  @Allow()
  rounding!: RoundingSpec;

  /** RuleInput[] — typed `unknown` (see header); validateRule enforces the real shape. */
  @Allow()
  inputs!: unknown;

  /** PipelineNode[] — typed `unknown` (see header); validateRule enforces the real shape. */
  @Allow()
  pipeline!: unknown;
}

/**
 * Replace a DRAFT's config (whole-object; only valid while status === 'draft').
 * ruleId/version/status are NOT editable — identity & lifecycle are server-owned.
 */
export class UpdatePointsRuleDto {
  @IsString()
  @Matches(DATE_RE, { message: 'effectiveFrom must be a YYYY-MM-DD date' })
  effectiveFrom!: string;

  @IsString()
  @IsOptional()
  @Matches(DATE_RE, { message: 'effectiveTo must be a YYYY-MM-DD date' })
  effectiveTo?: string | null;

  @IsString()
  @IsOptional()
  @IsIn(['PERIOD_AGGREGATE'], { message: 'evaluationBasis must be PERIOD_AGGREGATE' })
  evaluationBasis?: 'PERIOD_AGGREGATE';

  // Free-form config: @Allow() + `unknown` (see header) — validateRule is the authority.
  @Allow()
  attachsTo!: RuleAttachment;

  @Allow()
  output!: { awardType: AwardType; fieldId: string };

  @Allow()
  rounding!: RoundingSpec;

  @Allow()
  inputs!: unknown;

  @Allow()
  pipeline!: unknown;
}

/** List filter — all optional, tenant scope is applied server-side from the JWT. */
export class ListPointsRulesQueryDto {
  @IsString()
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: RuleStatus;

  @IsString()
  @IsOptional()
  ruleId?: string;

  @IsString()
  @IsOptional()
  program?: string;

  @IsString()
  @IsOptional()
  kpiCode?: string;
}
