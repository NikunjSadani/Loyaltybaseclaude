/**
 * ClientConfig — the single source of truth for everything that varies
 * between platform clients (tenants).
 *
 * Rules:
 *  - All fields are set by GIFSY_ADMIN only.
 *  - CLIENT_ADMIN reads this config but cannot write any part of it.
 *  - Pure helper functions here have no side-effects and are fully testable.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Feature flags
// ─────────────────────────────────────────────────────────────────────────────

export interface FeatureFlags {
  // Modules — entire sections of the product
  visibilityInvoiceModule: boolean;
  kycApprovalFlow: boolean;
  campaignEnrollmentForm: boolean;  // Open/mixed campaigns with enrollment forms
  salesTeamApp: boolean;
  walletModule: boolean;
  referralModule: boolean;

  // Behaviours
  selfEnrollmentAllowed: boolean;   // Partners can self-accept schemes
  nonKycOutletCampaigns: boolean;   // Campaigns can target non-KYC outlets
  multiLevelApproval: boolean;      // ≥2 approval levels in hierarchy

  // Partner app tab visibility (CLIENT_ADMIN cannot change these)
  partnerApp: {
    showSchemes: boolean;
    showInvoices: boolean;   // follows visibilityInvoiceModule
    showWallet: boolean;     // follows walletModule
    showTeam: boolean;
  };
}

export type FeatureKey = keyof Omit<FeatureFlags, 'partnerApp'>;

// ─────────────────────────────────────────────────────────────────────────────
// Branding
// ─────────────────────────────────────────────────────────────────────────────

export interface BrandingConfig {
  displayName: string;         // "Deoleo India" — shown in partner app header
  primaryColor: string;        // hex e.g. "#16a34a"
  logoUrl: string;             // absolute or relative path
  faviconUrl: string;
  supportEmail: string;
  supportPhone: string;
  productBrands: string[];     // ["Bertolli", "Figaro"] — used in copy/descriptions
}

// ─────────────────────────────────────────────────────────────────────────────
// Partner classes
// ─────────────────────────────────────────────────────────────────────────────

export interface PartnerClassConfig {
  key: string;            // system key — "GOLD", "SILVER" etc.
  displayName: string;    // what partners see — can be overridden per client
  color: string;          // hex or Tailwind class token
  order: number;          // 1 = highest tier
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval hierarchy
// ─────────────────────────────────────────────────────────────────────────────

export interface ApprovalLevelConfig {
  roleKey: string;               // "L1", "L2", "L3"
  displayName: string;           // "Sales Officer", "Regional Sales Manager"
  shortName: string;             // "SO", "RSM"
  canInitiateKyc: boolean;
  canApproveKyc: boolean;
  canViewAllOutlets: boolean;    // vs. only their assigned outlets
}

export interface ApprovalHierarchyConfig {
  levels: ApprovalLevelConfig[];
  kycAutoApproveBelowCreditLimit?: number;  // ₹ — null = always manual
  requireGifsyFinalApproval: boolean;       // Gifsy must sign off after all levels
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications (MSG91)
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationsConfig {
  /** Stored server-side only — never sent to the browser */
  msg91AuthKey: string;
  whatsappSenderId: string;   // client's registered WA Business number
  smsSenderId: string;        // DLT-registered 6-char sender ID
  templateIds: {
    schemePublished: string;
    enrollmentConfirm: string;
    otpVerification: string;
    kycApproved: string;
    kycRejected: string;
    payoutGenerated: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoicing
// ─────────────────────────────────────────────────────────────────────────────

export interface InvoicingConfig {
  /** Always "Tech Gifsy Solutions Limited" — immutable at platform level */
  sellerLegalName: string;
  sellerGstin: string;
  sellerState: string;         // drives IGST vs CGST+SGST split
  sellerAddress: string;
  sellerPan: string;
  bankName: string;
  bankAccountNumber: string;
  bankIfsc: string;
  bankBranch: string;
  invoicePrefix: string;       // e.g. "TGSL-VIS" for Deoleo, "TGSL-CLB" for Client B
  sacCode: string;             // Service Accounting Code for GST
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet defaults
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletConfig {
  defaultHoldingPeriodDays: number;
  pointsExpiryDays: number | null;      // null = points never expire
  minRedemptionAmount: number;          // ₹
  redemptionModes: ('UPI' | 'NEFT' | 'RTGS' | 'IMPS')[];
  pointsToRupeeRatio: number;           // e.g. 1.0 → 1 point = ₹1
}

// ─────────────────────────────────────────────────────────────────────────────
// Root ClientConfig
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientConfig {
  /** URL-safe lowercase identifier — drives subdomain routing */
  slug: string;
  /** Internal display name used in GIFSY super-admin */
  internalName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ONBOARDING';
  onboardedAt: string;   // ISO date string

  branding: BrandingConfig;
  features: FeatureFlags;
  partnerClasses: PartnerClassConfig[];
  approvalHierarchy: ApprovalHierarchyConfig;
  notifications: NotificationsConfig;
  invoicing: InvoicingConfig;
  wallet: WalletConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the given feature flag is enabled for this client.
 * CLIENT_ADMIN can read this but cannot write it.
 */
export function isFeatureEnabled(config: ClientConfig, key: FeatureKey): boolean {
  return !!(config.features as unknown as Record<string, boolean>)[key];
}

/**
 * Returns the approval level config for a given roleKey, or null if not found.
 */
export function getApprovalLevel(
  config: ClientConfig,
  roleKey: string,
): ApprovalLevelConfig | null {
  return config.approvalHierarchy.levels.find((l) => l.roleKey === roleKey) ?? null;
}

/**
 * Returns the partner class config for a given key (e.g. "GOLD"), or null.
 */
export function getPartnerClass(
  config: ClientConfig,
  key: string,
): PartnerClassConfig | null {
  return config.partnerClasses.find((c) => c.key === key) ?? null;
}

/**
 * Validates a ClientConfig and returns an array of human-readable error strings.
 * Empty array = valid.
 */
export function validateClientConfig(config: ClientConfig): string[] {
  const errors: string[] = [];

  if (!config.slug.trim()) {
    errors.push('slug is required and must not be empty.');
  } else if (!/^[a-z0-9-]+$/.test(config.slug)) {
    errors.push('slug must be lowercase alphanumeric with hyphens only.');
  }

  if (!config.branding.displayName.trim()) {
    errors.push('branding.displayName is required.');
  }

  if (!/^#[0-9a-fA-F]{6}$/.test(config.branding.primaryColor)) {
    errors.push('branding.primaryColor must be a valid 6-digit hex color (e.g. #16a34a).');
  }

  if (config.approvalHierarchy.levels.length === 0) {
    errors.push('approvalHierarchy must have at least one level.');
  }

  if (config.partnerClasses.length === 0) {
    errors.push('At least one partner class must be defined.');
  }

  if (!config.invoicing.sellerLegalName.trim()) {
    errors.push('invoicing.sellerLegalName is required.');
  }

  if (!config.invoicing.sellerGstin.trim()) {
    errors.push('invoicing.sellerGstin is required.');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS variable builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives --brand-primary-dark (15% darker) and --brand-primary-light
 * (90% lighter / tint) from the primary hex.
 *
 * Simple implementation: darken = reduce each channel by ~15%,
 * lighten = mix 10% primary into white.
 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b]
    .map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');
}

function darken(hex: string, amount = 0.12): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

function lighten(hex: string, amount = 0.92): string {
  const [r, g, b] = hexToRgb(hex);
  // Mix with white at `amount` ratio
  return rgbToHex(
    r + (255 - r) * amount,
    g + (255 - g) * amount,
    b + (255 - b) * amount,
  );
}

/**
 * Generates a CSS `:root { ... }` block with brand variables derived from
 * the client's primaryColor.  Injected into the HTML <head> by the root layout.
 */
export function buildCssVariables(config: ClientConfig): string {
  const primary = config.branding.primaryColor;
  return `:root {
  --brand-primary: ${primary};
  --brand-primary-dark: ${darken(primary)};
  --brand-primary-light: ${lighten(primary)};
}`;
}
