import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Query for GET /v1/admin/channel-partners — ported from
 * platform/src/app/api/admin/channel-partners/route.ts.
 *
 * World-A class/tier/kyc/region filters are DROPPED: the canonical
 * ChannelPartner has no partnerClass / tier / kycStatus / regionId columns
 * (partner CLASS management is gone). Only `search` is kept.
 */
export class ListChannelPartnersQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

/**
 * Body for PATCH /v1/admin/channel-partners/:id.
 * Source also accepted `currentTierConfigId` — DROPPED (TierConfig is a
 * World-A model that no longer exists). Only `isActive` survives.
 */
export class UpdateChannelPartnerDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
