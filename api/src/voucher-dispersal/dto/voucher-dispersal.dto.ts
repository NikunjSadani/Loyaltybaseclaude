import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/** POST /v1/admin/voucher-dispersal/campaigns */
export class CreateDispersalCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** {{3}} "program" variable of the voucher_code template (e.g. "Bajaj Loyalty" / "Gifsy Rewards"). */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  programLabel!: string;

  /** Reporting label only — the client this spend is billed to (Client.id). Optional. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  billedToClientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Whole rupees, > 0. ₹1 crore ceiling per campaign (sanity bound). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  budgetRupees!: number;
}

/**
 * POST /campaigns/:id/confirm — the numbers the admin saw on the preview. The server refuses when they
 * no longer match the stored preview (stale-preview protection: a re-upload in another tab).
 */
export class ConfirmDispersalCampaignDto {
  /** The `previewId` returned by the upload the admin reviewed. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  previewId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedValidCount!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedTotalRupees!: number;
}

/**
 * PATCH /campaigns/:id — rename and/or change the budget. At least one field; the budget may go UP, or DOWN
 * but never below what is already spent + committed (computed server-side under the campaign lock).
 */
export class EditDispersalCampaignDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /** Whole rupees (same bounds as create). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  budgetRupees?: number;
}

export const DISPERSAL_ROW_STATUSES = [
  'VALID',
  'INVALID',
  'DUPLICATE',
  'QUEUED',
  'BUYING',
  'PENDING_RECONCILE',
  'BOUGHT',
  'BUY_FAILED',
  'CANCELLED',
] as const;

/** GET /campaigns/:id/rows?status=&batch=&page= */
export class ListDispersalRowsQueryDto {
  @IsOptional()
  @IsIn(DISPERSAL_ROW_STATUSES)
  status?: (typeof DISPERSAL_ROW_STATUSES)[number];

  /** Only this upload batch (1 = the first file). An unconfirmed batch is listed ONLY when asked for by number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000) // = MAX_BATCH_NUMBER (controller) — over it is a 400, never a DB Int overflow
  batch?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

/** GET /campaigns?page= */
export class ListDispersalCampaignsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
