import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Employee Rewards Phase C — CONTESTS DTOs (ADMIN-DESIGN §5.3). MANUAL only (NO
 * auto-validation from performance data). class-validator mirrors the model shape:
 * name/duration/eligibility/optional bonus. Dates are ISO-8601 strings (the service
 * converts to Date + validates start < end). Eligibility arrays are hierarchy-level
 * CODES + regions; an EMPTY array means NO restriction (eligible to all).
 */

/** The admin-settable statuses for POST :id/status (schedule). CREDITED is reached ONLY via
 *  credit-bonus; CANCELLED only via POST :id/cancel — neither is settable here. */
export const CONTEST_SETTABLE_STATUSES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED'] as const;
export type ContestSettableStatus = (typeof CONTEST_SETTABLE_STATUSES)[number];

/** POST /admin/contests — create a DRAFT contest. */
export class CreateContestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  /** ISO-8601 datetime (e.g. '2026-11-01T00:00:00.000Z'). */
  @IsDateString()
  startDate!: string;

  /** ISO-8601 datetime; the service rejects endDate <= startDate. */
  @IsDateString()
  endDate!: string;

  /** Eligible hierarchy-level CODES. EMPTY (default) = eligible to ALL roles. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  eligibleRoleCodes?: string[];

  /** Eligible regions. EMPTY (default) = eligible to ALL regions. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  eligibleRegions?: string[];

  /** Optional bonus points credited to winners (whole points, a count — NOT money). */
  @IsOptional()
  @IsInt()
  @Min(0)
  bonusPoints?: number;
}

/**
 * PATCH /admin/contests/:id — edit a contest. The service allows this ONLY while the contest
 * is DRAFT or SCHEDULED (once ACTIVE/ENDED/CREDITED/CANCELLED it is locked). Every field is
 * optional; only the supplied ones are changed.
 */
export class UpdateContestDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  eligibleRoleCodes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  eligibleRegions?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  bonusPoints?: number;
}

/** POST /admin/contests/:id/status — schedule / advance the status (guarded transition map). */
export class SetContestStatusDto {
  @IsIn(CONTEST_SETTABLE_STATUSES as unknown as string[])
  status!: ContestSettableStatus;
}

/**
 * POST /admin/contests/:id/credit-bonus — MANUALLY credit the bonus ONCE.
 * `winnerEmployeeCodes` absent/empty = the WHOLE eligible set (resolved by eligibleRoleCodes /
 * eligibleRegions over the tenant's active employees). Present = that explicit winner list,
 * still INTERSECTED with eligibility (an ineligible/inactive/unknown code is skipped-with-reason).
 */
export class CreditContestBonusDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100000)
  @IsString({ each: true })
  winnerEmployeeCodes?: string[];
}

/** GET /admin/contests — list, tenant-scoped, optional status filter + pagination. */
export class ListContestsQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CREDITED', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
