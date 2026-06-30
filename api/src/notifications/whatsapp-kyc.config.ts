/**
 * Per-tenant WhatsApp KYC template configuration.
 *
 * Keyed by clientId (the tenant slug). Only tenants present here send a KYC
 * WhatsApp notification — a clientId absent from this map is simply UNCONFIGURED
 * and `KycService.sendKycWhatsapp` no-ops for it. This keeps the tenant gate
 * config-driven and extensible (no `if (clientId === 'deoleo')` buried in logic):
 * onboarding another tenant's WhatsApp templates is one entry here.
 *
 * The template names must match templates already registered + approved in MSG91
 * for that tenant's integrated WhatsApp number. Body-variable contracts:
 *   submissionTemplate — {{1}} owner name, {{2}} submission date, {{3}} program name
 *   approvalTemplate   — {{1}} owner name, {{2}} program name
 */
export interface WhatsappKycTemplates {
  /** MSG91 template for the "KYC submitted" owner notification. */
  submissionTemplate: string;
  /** MSG91 template for the "KYC approved" owner notification. */
  approvalTemplate: string;
}

export const WHATSAPP_KYC: Record<string, WhatsappKycTemplates> = {
  deoleo: {
    submissionTemplate: 'deoleo_kyc_submission',
    approvalTemplate: 'deoleo_kyc_approval',
  },
};
