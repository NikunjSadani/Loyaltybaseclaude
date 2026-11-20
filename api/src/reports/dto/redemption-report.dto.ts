/**
 * Redemption report — GET /v1/reports/redemptions (on-screen summary) and GET /v1/reports/redemptions/export (Excel).
 *
 * Filters (all optional): `from` / `to` = IST calendar days on "Redeemed on" (order createdAt; default = the current IST
 * month to date), `status`, `rewardType` (E_VOUCHER | PHYSICAL_GIFT | CASH), `zone`, `state` (case-insensitive, the
 * outlet master's Zone / State). `clientId` is honoured ONLY for an un-assumed GIFSY_ADMIN — everyone else is pinned to
 * their own (or assumed) tenant from the JWT, whatever the query says.
 */
import { RedemptionStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const REDEMPTION_REWARD_TYPES = ['E_VOUCHER', 'PHYSICAL_GIFT', 'CASH'] as const;
export type RedemptionRewardType = (typeof REDEMPTION_REWARD_TYPES)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class RedemptionReportQueryDto {
  /** GIFSY-only tenant choice (ignored for everyone else — they are pinned to their JWT tenant). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientId?: string;

  /** First IST day (YYYY-MM-DD) of "Redeemed on", inclusive. */
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'from must be a date like 2026-11-01' })
  from?: string;

  /** Last IST day (YYYY-MM-DD) of "Redeemed on", inclusive. */
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'to must be a date like 2026-11-30' })
  to?: string;

  @IsOptional()
  @IsEnum(RedemptionStatus, {
    message: 'status must be one of PENDING, CONFIRMED, PROCESSING, DISPATCHED, DELIVERED, CANCELLED, RETURNED, FAILED',
  })
  status?: RedemptionStatus;

  @IsOptional()
  @IsIn(REDEMPTION_REWARD_TYPES as unknown as string[], { message: 'rewardType must be one of E_VOUCHER, PHYSICAL_GIFT, CASH' })
  rewardType?: RedemptionRewardType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  zone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;
}
