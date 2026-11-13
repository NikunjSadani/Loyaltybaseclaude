/**
 * Shared contract for the scheduled INTERNAL Gifsy email — the Daily Operations Digest
 * (owner-approved 2026-11-13, replaces the earlier separate "Credits/Payouts summary" and
 * "KYC actionables digest" emails). See platform/docs/plans/DAILY-OPS-DIGEST.md.
 *
 * Seam: the RUNNER (scheduled-reports.service.ts) does ALL the Prisma, per tenant, per section
 * (each section in its own try/catch), and hands the PURE builder (daily-ops-digest-report.ts)
 * these plain structs. The builder never touches the DB or the clock — every value it renders
 * comes from here, so its HTML is deterministic and unit-testable.
 */

/** Stable report key — also the key the recipient list is stored under (reportRecipients). */
export type ReportKey = 'dailyDigest';

/** The reporting window: [startMs, endMs) in UTC-ms (computed in IST by digestWindow). */
export interface DigestWindow {
  startMs: number;
  endMs: number;
  /** Human window label, e.g. "Sat 08 Nov, 09:30 → Mon 10 Nov, 09:30 IST". */
  label: string;
}

/** A section either loaded, or failed (rendered as "couldn't load this section" — never omitted). */
export type SectionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** One SLA stage bucket: pending rows, split by how they sit against the stage's business-hours target. */
export interface SlaBucket {
  pending: number;
  /** age < 75% of the target. */
  within: number;
  /** 75% of the target ≤ age ≤ target — about to breach. */
  nearing: number;
  /** age > target. */
  breached: number;
}

export interface KycSection {
  /** KycSubmission.submittedAt in the window. */
  submitted: number;
  /** status APPROVED with approvedAt in the window. */
  approved: number;
  /** KycStatusHistory → REJECTED / RE_UPLOAD_REQUIRED / RESUBMISSION_REQUIRED in the window. */
  rejected: number;
  /** Pending in the field chain (submitted → reaching Gifsy). */
  field: SlaBucket;
  /** Pending at Gifsy (PENDING_GIFSY). */
  gifsy: SlaBucket;
}

export interface PointsSection {
  /** Σ PointsLedger EARN points in the window. */
  credited: number;
  /** |Σ PointsLedger REDEEM points| in the window. */
  redeemed: number;
  /** |Σ PointsLedger EXPIRE points| in the window. */
  expired: number;
  /** Wallets with redeemablePoints < 0 right now. */
  negativeWallets: number;
}

export interface FailedRedemptionRow {
  outlet: string;
  reward: string;
  reason: string;
}

export interface RedemptionsSection {
  /** RedemptionOrder.createdAt in the window. */
  requested: number;
  /** RedemptionStatusHistory → DELIVERED in the window. */
  completed: number;
  /** RedemptionStatusHistory → FAILED in the window. */
  failed: number;
  /** The most recent failures (≤ 10). */
  failedRows: FailedRedemptionRow[];
}

export interface VouchersSection {
  /** Hubble orders → DELIVERED in the window. */
  issued: number;
  /** Hubble orders → FAILED in the window. */
  failed: number;
  /** Hubble orders sitting in PROCESSING for more than 30 minutes right now. */
  stuckProcessing: number;
  /** Orders with an open hubbleNeedsReconcile flag right now. */
  needsReconcile: number;
}

export interface PayoutsSection {
  /** Credit batches confirmed in the window (CreditBatch.confirmedAt). */
  batchesConfirmed: number;
  /** Σ totalPoints of those batches. */
  batchPoints: number;
  /** Σ totalPayoutPaise of those batches (money committed). */
  batchPayoutPaise: bigint;
  /** Credit payouts marked PAID (CreditPayoutEntry.paidAt in the window). */
  creditPaid: number;
  creditPaidPaise: bigint;
  /** Redemption payouts SUCCESS (PayoutTransaction.completedAt in the window). */
  redemptionPaid: number;
  redemptionPaidPaise: bigint;
  /** Credit entries → FAILED + payout transactions → FAILED/REVERSED in the window. */
  failedOrReturned: number;
  /** Credit entries downloaded for the bank file and waiting for the UTR upload (PROCESSING, now). */
  awaitingUtr: number;
  awaitingUtrPaise: bigint;
}

export interface MessagesSection {
  /** OtpCode.deliveryStatus FAILED, flagged in the window. */
  otpFailed: number;
  /** MessageDeliveryReceipt channel SMS, status FAILED, flagged in the window. */
  smsFailed: number;
  /** MessageDeliveryReceipt channel WHATSAPP, status FAILED, flagged in the window. */
  whatsappFailed: number;
  /** WhatsappBroadcastRecipient status FAILED, flagged in the window. */
  broadcastFailed: number;
}

export interface VisibilitySection {
  /** VisibilityCaptureSubmission rows created in the window (incl. re-submissions). */
  submitted: number;
  /** Captures reviewed APPROVED in the window. */
  approved: number;
  /** Captures reviewed REJECTED / CHANGES_REQUESTED in the window. */
  rejected: number;
  /** Captures awaiting review (SUBMITTED) right now. */
  pending: number;
}

export interface SalesOpenMonth {
  /** 'YYYY-MM'. */
  month: string;
  /** SalesMonthStatus.lastAppliedAt (UTC-ms) or null when never applied. */
  lastAppliedAtMs: number | null;
  /** Targets written after the last apply (same rule as SalesMonthsService). */
  targetsChangedSinceApply: boolean;
}

export interface SalesImportSection {
  /** Imports that reached READY in the window (finishedAt). */
  processed: number;
  /** Imports that went FAILED in the window. */
  failed: number;
  /** OPEN months (last 6, not future), newest first. */
  openMonths: SalesOpenMonth[];
}

export interface TenantDigest {
  clientId: string;
  name: string;
  kyc: SectionResult<KycSection>;
  points: SectionResult<PointsSection>;
  redemptions: SectionResult<RedemptionsSection>;
  /** Present ONLY for tenants with features.hubbleVoucherEnabled. */
  vouchers?: SectionResult<VouchersSection>;
  payouts: SectionResult<PayoutsSection>;
  messages: SectionResult<MessagesSection>;
  /** Present ONLY for tenants with the visibilityEnabled setting ON. */
  visibility?: SectionResult<VisibilitySection>;
  /** Present ONLY for tenants with features.salesImport. */
  salesImport?: SectionResult<SalesImportSection>;
}

export interface DigestInput {
  window: DigestWindow;
  /** Date the digest is sent, e.g. "13 Nov 2026" (IST). */
  dateLabel: string;
  tenants: TenantDigest[];
  /** OTP delivery failures in the window that carry no user (pre-login) — no tenant to attach them to. */
  unattributedOtpFailed?: SectionResult<number>;
}

/** The rendered digest. */
export interface DigestResult {
  key: ReportKey;
  subject: string;
  html: string;
  /** Tenants with at least one "needs attention" item. */
  tenantsNeedingAttention: number;
  /** Total "needs attention" items across tenants. */
  attentionItems: number;
}
