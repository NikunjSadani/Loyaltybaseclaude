/**
 * DTOs for TDS upload endpoints — P6.5b.
 *
 * Off-platform 194R upload:
 *   POST /v1/admin/tds/off-platform/upload?apply=true|false
 *
 * TDS deposit upload:
 *   POST /v1/admin/tds/deposits/upload?section=194R|194C&apply=true|false
 *
 * Liability tracker:
 *   GET  /v1/admin/tds/liability?section=194R|194C&fy=2025-26
 */

import { IsIn, IsOptional, IsString } from 'class-validator';

// ─── Query params ─────────────────────────────────────────────────────────────

/** ?apply=true|false for upload endpoints. */
export class UploadQueryDto {
  @IsOptional()
  @IsString()
  apply?: string; // 'true' to commit, anything else = preview
}

/** ?section=194R|194C&apply=true|false for deposit upload. */
export class DepositUploadQueryDto {
  @IsIn(['194R', '194C'])
  section!: '194R' | '194C';

  @IsOptional()
  @IsString()
  apply?: string;
}

/** ?section=194R|194C&fy=YYYY-YY for liability tracker. */
export class LiabilityQueryDto {
  @IsIn(['194R', '194C'])
  section!: '194R' | '194C';

  @IsOptional()
  @IsString()
  fy?: string;
}

// ─── Upload result shape (mirrors credits/targets bulk-upload return) ─────────

export interface UploadRowError {
  row: number;
  message: string;
}

export interface UploadResult {
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: UploadRowError[];
}
