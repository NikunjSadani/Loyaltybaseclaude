/**
 * Points Compute Engine — Wave 1 preview DTO.
 *
 * The read-only compute/preview route body. `period` is the YYYY-MM the achievements/targets
 * are read for; `program`/`kpiCode` optionally narrow the run (program → scopes the outlet
 * universe; kpiCode → computes just that one input-KPI attachment). Shape-level validation
 * only — the rules themselves are deep-validated by validateRule() on load (see the service).
 */

import { Allow, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { AwardType, RoundingSpec, RuleAttachment } from '../points-engine.types';

/**
 * Strict YYYY-MM (01-12) — rejects 2026-13 etc. (mirrors achievements export) — OR a financial-year quarter
 * `YYYY-Qn` (YYYY = FY start year: 2026-Q3 = Oct–Dec 2026, 2026-Q4 = Jan–Mar 2027), which computes QUARTERLY rules only.
 */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/;

export class PreviewComputeDto {
  @Matches(PERIOD_RE, { message: 'period must be a valid YYYY-MM month or a YYYY-Qn financial-year quarter' })
  period!: string;

  /** Optional: restrict the run to outlets whose programName matches this value. */
  @IsOptional()
  @IsString()
  program?: string;

  /** Optional: compute only this input-KPI attachment (else every KPI with an active rule). */
  @IsOptional()
  @IsString()
  kpiCode?: string;

  /**
   * §3a: the `preview.visibility.pendingKey` of the visibility-pending outlet set (waiting for review / window open)
   * the admin ACCEPTED will read "not approved". Required — and must equal the fresh run's key (same outlets) — for
   * the credit-upload export, the payout report and direct credit whenever outlets are pending; ignored by preview /
   * the review report.
   */
  @IsOptional()
  @IsString()
  acceptVisibilityPendingKey?: string;

  /**
   * The run key the operator reviewed: `sourceKey` (direct credit + credit-upload file) or `payoutKey` (payout
   * report). A fresh compute with a different key is refused (409) — never a file / batch the operator did not see.
   * Omitted → no staleness check (direct API use). Ignored by preview / the review report.
   */
  @IsOptional()
  @IsString()
  expectedKey?: string;
}

/**
 * Commit (direct-credit) body — the preview filters plus an optional `expectedKey`: the sourceKey the
 * operator saw when they previewed. If supplied and the fresh compute's key differs (achievements/targets
 * edited or a rule republished since review), the commit is REJECTED so we never credit a run that no
 * longer matches what was reviewed/approved (TOCTOU guard). Omitted → direct API use, no staleness check.
 */
export class CommitComputeDto extends PreviewComputeDto {}

/**
 * Simulate body — a DRAFT rule's authoring fields + ONE sample context, for the builder's live simulator.
 * Shape-level only (presence/primitive); the node grammar is deep-validated by validateRule() in the service
 * (the single source of truth — the CRUD DTOs deliberately don't re-encode it either). No persistence.
 */
export class SimulateComputeDto {
  // @Allow() (not @IsObject/@IsArray) — the nested config passes through untouched for validateRule; the
  // global pipe (whitelist + transform + enableImplicitConversion) mangles @IsArray-typed nested objects
  // (strips each element to a non-object). Same reason the CRUD DTOs + UpsertSettingDto use @Allow().
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

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsIn(['PERIOD_AGGREGATE', 'QUARTER'])
  evaluationBasis?: 'PERIOD_AGGREGATE' | 'QUARTER';

  /** One sample evaluation context: achievements/targets by kpiCode + the outlet's segment facet. */
  @Allow()
  context!: {
    achievements?: Record<string, number | null>;
    targets?: Record<string, number | null>;
    segment?: { program?: string | null; programCategory?: string | null; outletType?: string | null; metro?: string | null };
    /** Test visibility values for `visibility:*` inputs (design §3a); a missing key = absent → nullAs. */
    visibility?: { approvedWindows?: number | null; approved?: number | null; windows?: number | null; inScope?: number | null };
    /**
     * QUARTERLY rules: 3 months of test values (month 1, 2, 3 of the quarter). `label` optional (defaults
     * "Month 1"…); `quarterLabel` optional (defaults "the quarter").
     */
    quarterLabel?: string;
    months?: Array<{ label?: string; achievements?: Record<string, number | null>; targets?: Record<string, number | null> }>;
  };
}
