import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches } from 'class-validator';

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

  // ── Tenant domains (§A-DOMAIN) ────────────────────────────────────────────

  /**
   * Custom tenant hostnames to route to this tenant (each must end with
   * `.gifsy.in`). The canonical `<slug>.gifsy.in` is always seeded on create in
   * addition to whatever is listed here, so a new tenant is immediately routable.
   * Normalised (lower-cased/trimmed) and validated in the service.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  domains?: string[];
}

/**
 * Body for PATCH /v1/gifsy/clients/:slug — edit an existing tenant.
 *
 * Every field is OPTIONAL (this is a PATCH): the service only writes fields
 * explicitly present in the body. `slug` is intentionally absent — it is the
 * Client PK and immutable. Branding/feature fields are MERGED into the existing
 * JSON blobs, never wholesale-replaced.
 */
export class UpdateClientDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'ONBOARDING', 'INACTIVE'])
  status?: 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';

  @IsOptional()
  @IsString()
  internalName?: string;

  // ── Branding fields (merged into the existing branding blob) ──────────────

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

  // ── Branding asset URLs (merged into the existing branding blob) ──────────
  // Persistence only — the actual bytes are uploaded via POST
  // clients/:slug/branding-asset, which writes the resulting URL through here.

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  wordmarkWhiteUrl?: string;

  @IsOptional()
  @IsString()
  wordmarkColorUrl?: string;

  @IsOptional()
  @IsString()
  faviconUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productBrands?: string[];

  // ── Feature flags (merged into the existing features blob) ────────────────

  @IsOptional()
  @IsObject()
  features?: Record<string, boolean>;

  // ── Notifications (deep-merged into the existing notifications blob) ───────

  /**
   * Partial notifications config. Deep-merged over the existing blob: top-level
   * keys (whatsappSenderId/smsSenderId) overlay, and `templateIds` is itself
   * deep-merged so unspecified template ids — and any msg91-related keys already
   * on the row — are never dropped.
   */
  @IsOptional()
  @IsObject()
  notifications?: {
    whatsappSenderId?: string;
    smsSenderId?: string;
    templateIds?: {
      schemePublished?: string;
      enrollmentConfirm?: string;
      otpVerification?: string;
      kycApproved?: string;
      kycRejected?: string;
      payoutGenerated?: string;
    };
  };

  // ── Tenant domains (§A-DOMAIN) ────────────────────────────────────────────

  /**
   * The complete desired set of tenant hostnames (each must end with
   * `.gifsy.in`). The service RECONCILES the stored set to match: domains not in
   * the list are removed, new ones added, and exactly one is kept primary. Omit
   * the field to leave the domain set untouched.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  domains?: string[];
}

/**
 * Body for POST /v1/gifsy/clients/:slug/branding-asset — which branding slot the
 * uploaded image fills. Rides as a multipart form field alongside `file`.
 */
export class BrandingAssetDto {
  @IsIn(['logo', 'wordmarkWhite', 'wordmarkColor', 'favicon'])
  kind!: 'logo' | 'wordmarkWhite' | 'wordmarkColor' | 'favicon';
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
