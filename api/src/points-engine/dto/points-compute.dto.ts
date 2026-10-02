/**
 * Points Compute Engine — Wave 1 preview DTO.
 *
 * The read-only compute/preview route body. `period` is the YYYY-MM the achievements/targets
 * are read for; `program`/`kpiCode` optionally narrow the run (program → scopes the outlet
 * universe; kpiCode → computes just that one input-KPI attachment). Shape-level validation
 * only — the rules themselves are deep-validated by validateRule() on load (see the service).
 */

import { IsOptional, IsString, Matches } from 'class-validator';

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
