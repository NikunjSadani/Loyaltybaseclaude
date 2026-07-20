/**
 * DEFAULT_CLIENT_CONFIG — the minimal, SAFE ClientConfig used as the last-resort
 * fallback wherever a real per-tenant config isn't available:
 *   - the ClientConfigContext default (before a provider mounts),
 *   - the server-side getTenantConfig() no-slug / unknown-slug fallback,
 *   - the base every reduced CLIENT_REGISTRY entry spreads from.
 *
 * §A-DOMAIN "P5": the in-code registry no longer carries rich per-tenant `features`
 * — runtime feature gating is served from the DB via AUTHENTICATED per-role
 * endpoints (/partner/me, /sales/me, /admin/settings/config) and read on the FE via
 * `useTenantFeatures` / `usePartnerIdentity`. So these feature flags are deliberately
 * CONSERVATIVE defaults (visibility/referral/RBAC OFF); they only affect rendering
 * before the authenticated features resolve, never backend enforcement (which is
 * DB-driven per D-1). Branding here is a neutral placeholder — real per-tenant
 * branding is overlaid from the DB routing snapshot via `applyDbBranding`.
 */

import type { ClientConfig } from './client-config';

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  slug: 'default',
  internalName: 'LoyaltyBase',
  status: 'ONBOARDING',
  onboardedAt: '1970-01-01',

  branding: {
    displayName: 'LoyaltyBase',
    primaryColor: '#16a34a',
    logoUrl: '',
    faviconUrl: '',
    supportEmail: '',
    supportPhone: '',
    productBrands: [],
  },

  features: {
    visibilityInvoiceModule: false,
    kycApprovalFlow: true,
    campaignEnrollmentForm: true,
    salesTeamApp: true,
    walletModule: true,
    referralModule: false,
    selfEnrollmentAllowed: true,
    nonKycOutletCampaigns: false,
    multiLevelApproval: false,
    rbacEnforcement: false,
    partnerApp: {
      showSchemes: true,
      showInvoices: false,
      showWallet: true,
      showTeam: true,
      showLeaderboard: false,
    },
  },

  partnerClasses: [
    { key: 'STANDARD', displayName: 'Standard', color: '#2563eb', order: 1 },
  ],

  approvalHierarchy: {
    levels: [
      {
        roleKey: 'L1',
        displayName: 'Sales Officer',
        shortName: 'SO',
        canInitiateKyc: true,
        canApproveKyc: true,
        canViewAllOutlets: false,
      },
    ],
    requireGifsyFinalApproval: true,
  },

  notifications: {
    msg91AuthKey: 'DEMO_KEY',
    whatsappSenderId: '',
    smsSenderId: '',
    templateIds: {
      schemePublished: '',
      enrollmentConfirm: '',
      otpVerification: '',
      kycApproved: '',
      kycRejected: '',
      payoutGenerated: '',
    },
  },

  invoicing: {
    sellerLegalName: 'Tech Gifsy Solutions Limited',
    sellerGstin: '',
    sellerState: '',
    sellerAddress: '',
    sellerPan: '',
    bankName: '',
    bankAccountNumber: '',
    bankIfsc: '',
    bankBranch: '',
    invoicePrefix: 'TGSL',
    sacCode: '998361',
  },

  wallet: {
    defaultHoldingPeriodDays: 30,
    pointsExpiryDays: 365,
    minRedemptionAmount: 500,
    redemptionModes: ['UPI', 'NEFT'],
    pointsToRupeeRatio: 1.0,
  },
};
