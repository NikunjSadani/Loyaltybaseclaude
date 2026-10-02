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

import { IsArray, IsIn, IsObject, IsOptional, IsString, Matches } from 'class-validator';
import type {
  AwardType,
  PipelineNode,
  RoundingSpec,
  RuleAttachment,
  RuleInput,
  RuleStatus,
} from '../points-engine.types';

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

  /** RuleAttachment { scope, program?, programCategory?, kpiCode } — deep-validated by validateRule. */
  @IsObject()
  attachsTo!: RuleAttachment;

  /** { awardType, fieldId } — the credit-field bucket + award type. */
  @IsObject()
  output!: { awardType: AwardType; fieldId: string };

  /** RoundingSpec { mode, scale } — single, final rounding. */
  @IsObject()
  rounding!: RoundingSpec;

  /** The ONLY variables the pipeline may read. */
  @IsArray()
  inputs!: RuleInput[];

  /** The ordered pipeline of typed nodes. */
  @IsArray()
  pipeline!: PipelineNode[];
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

  @IsObject()
  attachsTo!: RuleAttachment;

  @IsObject()
  output!: { awardType: AwardType; fieldId: string };

  @IsObject()
  rounding!: RoundingSpec;

  @IsArray()
  inputs!: RuleInput[];

  @IsArray()
  pipeline!: PipelineNode[];
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
