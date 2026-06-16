import { IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * Body for PUT /v1/gifsy/clients/:slug/outlet-type-configs/:code.
 *
 * Every field is optional: the service only writes fields that are explicitly
 * present in the body (omitted flags retain their existing value, or the
 * all-true default if no row exists yet) — preserved from the source route.
 */
export class UpdateOutletTypeConfigDto {
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  displayName?: string | null;

  @IsOptional()
  @IsBoolean()
  loyaltyEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  schemesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  visibilityEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  payoutsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  leaderboardEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  targetsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  kycRequired?: boolean;
}
