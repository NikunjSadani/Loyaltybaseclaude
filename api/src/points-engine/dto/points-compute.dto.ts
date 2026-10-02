/**
 * Points Compute Engine — Wave 1 preview DTO.
 *
 * The read-only compute/preview route body. `period` is the YYYY-MM the achievements/targets
 * are read for; `program`/`kpiCode` optionally narrow the run (program → scopes the outlet
 * universe; kpiCode → computes just that one input-KPI attachment). Shape-level validation
 * only — the rules themselves are deep-validated by validateRule() on load (see the service).
 */

import { IsArray, IsIn, IsObject, IsOptional, IsString, Matches } from 'class-validator';
import type {
  AwardType,
  PipelineNode,
  RoundingSpec,
  RuleAttachment,
  RuleInput,
} from '../points-engine.types';

/** Strict YYYY-MM (01-12) — rejects 2026-13 etc. (mirrors achievements export). */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class PreviewComputeDto {
  @Matches(PERIOD_RE, { message: 'period must be a valid YYYY-MM month' })
  period!: string;

  /** Optional: restrict the run to outlets whose programName matches this value. */
  @IsOptional()
  @IsString()
  program?: string;

  /** Optional: compute only this input-KPI attachment (else every KPI with an active rule). */
  @IsOptional()
  @IsString()
  kpiCode?: string;
}

/**
 * Commit (direct-credit) body — the preview filters plus an optional `expectedKey`: the sourceKey the
 * operator saw when they previewed. If supplied and the fresh compute's key differs (achievements/targets
 * edited or a rule republished since review), the commit is REJECTED so we never credit a run that no
 * longer matches what was reviewed/approved (TOCTOU guard). Omitted → direct API use, no staleness check.
 */
export class CommitComputeDto extends PreviewComputeDto {
  @IsOptional()
  @IsString()
  expectedKey?: string;
}

/**
 * Simulate body — a DRAFT rule's authoring fields + ONE sample context, for the builder's live simulator.
 * Shape-level only (presence/primitive); the node grammar is deep-validated by validateRule() in the service
 * (the single source of truth — the CRUD DTOs deliberately don't re-encode it either). No persistence.
 */
export class SimulateComputeDto {
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

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsIn(['PERIOD_AGGREGATE'])
  evaluationBasis?: 'PERIOD_AGGREGATE';

  /** One sample evaluation context: achievements/targets by kpiCode + the outlet's segment facet. */
  @IsObject()
  context!: {
    achievements?: Record<string, number | null>;
    targets?: Record<string, number | null>;
    segment?: { program?: string | null; programCategory?: string | null; outletType?: string | null };
  };
}
