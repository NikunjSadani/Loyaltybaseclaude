/**
 * Per-tenant WhatsApp KYC template configuration.
 *
 * Keyed by clientId (the tenant slug). This map is now the DEFAULT SEED for the per-tenant
 * notification-templates resolver (notification-templates.config.ts): a tenant present here
 * defaults its four live events (KYC submission/approval + points/payout credit) to WhatsApp-on
 * with these template names + masterWhatsapp ON, so an unconfigured tenant sends exactly as it did
 * before those sends were routed through NotificationsService.notifyUserWithChannels. A clientId
 * absent from this map defaults every channel OFF. This keeps the tenant gate config-driven and
 * extensible (no `if (clientId === 'deoleo')` in logic): onboarding a tenant's WhatsApp is one
 * entry here (a stored program_settings row can then override per event).
 *
 * The template names must match templates already registered + approved in MSG91
 * for that tenant's integrated WhatsApp number. Body-variable contracts:
 *   submissionTemplate   — {{1}} owner name, {{2}} submission date, {{3}} program name
 *   approvalTemplate     — {{1}} owner name, {{2}} program name
 *   pointsCreditTemplate — {{1}} owner name, {{2}} points credited, {{3}} redeemable balance,
 *                          {{4}} month-year credited (e.g. "July 2026"), {{5}} date credited (e.g. "06 Jul 2026")
 *   payoutCreditTemplate — {{1}} owner name, {{2}} points, {{3}} UTR, {{4}} date of payment,
 *                          {{5}} month (e.g. "July 2026")
 */
export interface WhatsappKycTemplates {
  /** MSG91 template for the "KYC submitted" owner notification. */
  submissionTemplate: string;
  /** MSG91 template for the "KYC approved" owner notification. */
  approvalTemplate: string;
  /** MSG91 template for the "points credited" owner notification (credits batch confirm). */
  pointsCreditTemplate: string;
  /** MSG91 template for the "payout credited" owner notification (credit payout + redemption cash-out). */
  payoutCreditTemplate: string;
}

export const WHATSAPP_KYC: Record<string, WhatsappKycTemplates> = {
  deoleo: {
    submissionTemplate: 'deoleo_kyc_submission',
    approvalTemplate: 'deoleo_kyc_approval',
    pointsCreditTemplate: 'deoleo_points_credit',
    payoutCreditTemplate: 'deoleo_payout_credit',
  },
};
