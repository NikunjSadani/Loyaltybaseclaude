import { IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Body for POST /v1/gifsy/clients — onboard a new tenant.
 *
 * slug is the stable tenant id (used as the Client PK and throughout as
 * clientId). Every other field mirrors the wizard's OnboardingForm.
 */
export class CreateClientDto {
  /** Stable tenant slug — becomes the `id` (PK) on the Client row. */
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must be lowercase alphanumeric and hyphens only',
  })
  slug!: string;

  @IsString()
  internalName!: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'ONBOARDING', 'INACTIVE'])
  status?: 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';

  // ── Branding fields (collected on wizard step 2) ──────────────────────────

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  primaryColor?: string;

  @IsOptional()
  @IsString()
  supportEmail?: string;

  @IsOptional()
  @IsString()
  supportPhone?: string;

  @IsOptional()
  @IsString()
  invoicePrefix?: string;

  // ── Feature flags (collected on wizard step 3) ────────────────────────────

  /**
   * Free-form feature-flags object — keys match the FeatureKey union in the FE
   * client-config types.  Stored as JSON on the Client row.
   */
  @IsOptional()
  @IsObject()
  features?: Record<string, boolean>;
}

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
