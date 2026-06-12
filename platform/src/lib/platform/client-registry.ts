/**
 * Client registry — seed configs for all onboarded tenants.
 *
 * GIFSY_ADMIN manages these records. In production these live in the database;
 * this file is the in-memory seed used for demo / dev.
 *
 * Adding a new client:
 *   1. Create a ClientConfig object below.
 *   2. Add it to CLIENT_REGISTRY.
 *   3. Provision subdomain DNS: <slug>.loyaltybase.in
 */

import type { ClientConfig } from './client-config';

// ─────────────────────────────────────────────────────────────────────────────
// Deoleo India
// ─────────────────────────────────────────────────────────────────────────────

export const DEOLEO_CONFIG: ClientConfig = {
  slug: 'deoleo',
  internalName: 'Deoleo India Pvt. Ltd.',
  status: 'ACTIVE',
  onboardedAt: '2025-01-01',

  branding: {
    displayName: 'Deoleo India',
    primaryColor: '#16a34a',
    logoUrl: '/logos/deoleo.svg',
    faviconUrl: '/favicons/deoleo.ico',
    supportEmail: 'support@deoleo.loyaltybase.in',
    supportPhone: '+91-1800-000-0001',
    productBrands: ['Bertolli', 'Figaro'],
  },

  features: {
    visibilityInvoiceModule: true,
    kycApprovalFlow: true,
    campaignEnrollmentForm: true,
    salesTeamApp: true,
    walletModule: true,
    referralModule: false,
    selfEnrollmentAllowed: true,
    nonKycOutletCampaigns: true,
    multiLevelApproval: true,
    partnerApp: {
      showSchemes: true,
      showInvoices: true,
      showWallet: true,
      showTeam: true,
    },
  },

  partnerClasses: [
    { key: 'PLATINUM', displayName: 'Platinum',  color: '#7c3aed', order: 1 },
    { key: 'GOLD',     displayName: 'Gold',       color: '#d97706', order: 2 },
    { key: 'SILVER',   displayName: 'Silver',     color: '#6b7280', order: 3 },
    { key: 'BRONZE',   displayName: 'Bronze',     color: '#c2410c', order: 4 },
    { key: 'STANDARD', displayName: 'Standard',   color: '#2563eb', order: 5 },
  ],

  approvalHierarchy: {
    levels: [
      {
        roleKey: 'L1',
        displayName: 'Sales Officer',
        shortName: 'SO',
        canInitiateKyc: true,
        canApproveKyc: false,
        canViewAllOutlets: false,
      },
      {
        roleKey: 'L2',
        displayName: 'Regional Sales Manager',
        shortName: 'RSM',
        canInitiateKyc: false,
        canApproveKyc: true,
        canViewAllOutlets: true,
      },
    ],
    requireGifsyFinalApproval: true,
  },

  notifications: {
    msg91AuthKey: process.env.DEOLEO_MSG91_AUTH_KEY ?? 'DEMO_KEY',
    whatsappSenderId: '91XXXXXXXXXX',
    smsSenderId: 'DEOLEO',
    templateIds: {
      schemePublished:    'deoleo_scheme_live',
      enrollmentConfirm:  'deoleo_enrol_confirm',
      otpVerification:    'deoleo_otp',
      kycApproved:        'deoleo_kyc_approved',
      kycRejected:        'deoleo_kyc_rejected',
      payoutGenerated:    'deoleo_payout',
    },
  },

  invoicing: {
    sellerLegalName:   'Tech Gifsy Solutions Limited',
    sellerGstin:       '19AABCT1234A1ZX',       // WB GSTIN
    sellerState:       'West Bengal',
    sellerAddress:     'Salt Lake, Sector V, Kolkata – 700 091, West Bengal',
    sellerPan:         'AABCT1234A',
    bankName:          'HDFC Bank',
    bankAccountNumber: '50XXXXXXXXXX',
    bankIfsc:          'HDFC0001234',
    bankBranch:        'Salt Lake, Kolkata',
    invoicePrefix:     'TGSL-VIS',
    sacCode:           '998361',
  },

  wallet: {
    defaultHoldingPeriodDays: 30,
    pointsExpiryDays: 365,
    minRedemptionAmount: 500,
    redemptionModes: ['UPI', 'NEFT'],
    pointsToRupeeRatio: 1.0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Demo Client B  (placeholder — replace when real client is onboarded)
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_B_CONFIG: ClientConfig = {
  slug: 'clientb',
  internalName: 'Client B (Demo)',
  status: 'ONBOARDING',
  onboardedAt: '2026-06-01',

  branding: {
    displayName: 'Client B Loyalty',
    primaryColor: '#2563eb',          // blue — different from Deoleo
    logoUrl: '/logos/clientb.svg',
    faviconUrl: '/favicons/clientb.ico',
    supportEmail: 'support@clientb.loyaltybase.in',
    supportPhone: '+91-1800-000-0002',
    productBrands: [],
  },

  features: {
    visibilityInvoiceModule: false,   // not purchased
    kycApprovalFlow: true,
    campaignEnrollmentForm: true,
    salesTeamApp: true,
    walletModule: true,
    referralModule: false,
    selfEnrollmentAllowed: true,
    nonKycOutletCampaigns: false,
    multiLevelApproval: false,        // single-level approval only
    partnerApp: {
      showSchemes: true,
      showInvoices: false,            // follows visibilityInvoiceModule
      showWallet: true,
      showTeam: true,
    },
  },

  partnerClasses: [
    { key: 'GOLD',     displayName: 'Gold Partner',   color: '#d97706', order: 1 },
    { key: 'SILVER',   displayName: 'Silver Partner', color: '#6b7280', order: 2 },
    { key: 'STANDARD', displayName: 'Associate',      color: '#2563eb', order: 3 },
  ],

  approvalHierarchy: {
    levels: [
      {
        roleKey: 'L1',
        displayName: 'Territory Manager',
        shortName: 'TM',
        canInitiateKyc: true,
        canApproveKyc: true,          // single level — TM approves directly
        canViewAllOutlets: false,
      },
    ],
    requireGifsyFinalApproval: true,
  },

  notifications: {
    msg91AuthKey: process.env.CLIENT_B_MSG91_AUTH_KEY ?? 'DEMO_KEY_B',
    whatsappSenderId: '91YYYYYYYYYY',
    smsSenderId: 'CLNTB',
    templateIds: {
      schemePublished:    'clientb_scheme_live',
      enrollmentConfirm:  'clientb_enrol_confirm',
      otpVerification:    'clientb_otp',
      kycApproved:        'clientb_kyc_approved',
      kycRejected:        'clientb_kyc_rejected',
      payoutGenerated:    'clientb_payout',
    },
  },

  invoicing: {
    sellerLegalName:   'Tech Gifsy Solutions Limited',
    sellerGstin:       '19AABCT1234A1ZX',
    sellerState:       'West Bengal',
    sellerAddress:     'Salt Lake, Sector V, Kolkata – 700 091, West Bengal',
    sellerPan:         'AABCT1234A',
    bankName:          'HDFC Bank',
    bankAccountNumber: '50XXXXXXXXXX',
    bankIfsc:          'HDFC0001234',
    bankBranch:        'Salt Lake, Kolkata',
    invoicePrefix:     'TGSL-CLB',
    sacCode:           '998361',
  },

  wallet: {
    defaultHoldingPeriodDays: 45,
    pointsExpiryDays: null,           // points never expire for Client B
    minRedemptionAmount: 250,
    redemptionModes: ['UPI'],
    pointsToRupeeRatio: 1.0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry map — slug → config
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_REGISTRY: Record<string, ClientConfig> = {
  [DEOLEO_CONFIG.slug]:   DEOLEO_CONFIG,
  [CLIENT_B_CONFIG.slug]: CLIENT_B_CONFIG,
};
