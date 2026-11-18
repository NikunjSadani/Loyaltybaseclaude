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

/** The reporting window: [startMs, endMs) in UTC-ms — since the last SUCCESSFUL send (digest-run-state.ts). */
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
  /**
   * Of `gifsy.pending`: KYCs that went straight to Gifsy through the GIFSY-reject fast-track (Bajaj flag
   * `gifsyRejectFastTrack`; marker on the DRAFT→PENDING_GIFSY row, `isFastTrackRow`). They had NO field stage.
   */
  gifsyFastTracked: number;
  /**
   * Fast-tracked KYCs found at a FIELD status (not a path the code has today). They are EXCLUDED from the field SLA
   * (same rule as the admin dashboard's field-chain exclusion) and called out here instead of being aged.
   */
  fieldFastTrackedExcluded: number;
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
  /** STILL OPEN (now, not windowed): orders FAILED but still holding deducted points (pointsDeducted > 0 — never refunded). */
  failedNotRefunded: number;
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
  /**
   * Hubble-routed orders → FAILED in the window: voucherProvider 'Hubble' OR the no-Hubble-order refund
   * (cancelReason HUBBLE_NO_ORDER_REFUND_REASON — that path deliberately does not stamp the provider).
   * A subset of RedemptionsSection.failed.
   */
  failed: number;
  /** Hubble orders in PROCESSING whose latest PROCESSING history entry is > 30 min old (updatedAt when there is none). */
  stuckProcessing: number;
  /** Orders with an open hubbleNeedsReconcile flag right now. */
  needsReconcile: number;
}

export interface PayoutsSection {
  /** Credit batches confirmed in the window (CreditBatch.confirmedAt). */
  batchesConfirmed: number;
  /** Σ totalPoints of those batches. */
  batchPoints: number;
  /** Σ totalOutlets of those batches (the old Credits email's "Outlets" figure). */
  batchOutlets: number;
  /** Σ totalPayoutPaise of those batches (money committed). */
  batchPayoutPaise: bigint;
  /**
   * Credit payouts RECORDED as PAID in the window — CreditPayoutEntry status PAID with updatedAt in the window
   * (no app path writes a PAID entry again, so updatedAt = the UTR-apply moment; paidAt is the operator's
   * payment DATE at IST midnight and would fall in an already-sent window).
   */
  creditPaid: number;
  creditPaidPaise: bigint;
  /** Redemption payouts SUCCESS (PayoutTransaction.completedAt in the window). */
  redemptionPaid: number;
  redemptionPaidPaise: bigint;
  /** Credit entries recorded FAILED + payout transactions → FAILED/REVERSED in the window (updatedAt). */
  failedOrReturned: number;
  /** STILL OPEN (now): credit entries FAILED (awaiting re-bank or reversal). */
  openFailedCredit: number;
  openFailedCreditPaise: bigint;
  /** STILL OPEN (now): redemption payout transactions FAILED whose order was NOT failed/refunded (needs ops). */
  openFailedRedemption: number;
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
  /** Imports that went FAILED in the window (finishedAt — the retention purge bumps updatedAt). */
  failed: number;
  /** STILL OPEN (now): FAILED imports with no READY import created after them (not superseded). */
  failedOpen: number;
  /** OPEN months (last 6, not future), newest first. */
  openMonths: SalesOpenMonth[];
}

/**
 * Current-month billing progress for the tenant's report KPI — the SAME numbers as the admin "Billing progress"
 * dashboard card (`loadBillingProgress` + `summarizeBillingProgress`, unfiltered).
 */
export interface BillingSection {
  /** 'YYYY-MM' (the current IST month). */
  month: string;
  /** The report KPI's label; null = the tenant has no enabled KPI (the card is hidden on the dashboard too). */
  kpiLabel: string | null;
  /** Data date (YYYY-MM-DD) the figures run to; null = no sales uploaded for the month. */
  asOf: string | null;
  /** Live-roster outlets with a positive target for the KPI. */
  withTarget: number;
  /** Of `withTarget`: outlets with no (or net-negative) billing yet — the NOT_STARTED bucket. */
  notStarted: number;
  /** Live outlets in the KPI's scope with no target (not counted). */
  noTarget: number;
  /** Live outlets outside the KPI's applies-to scope (not counted). */
  notCovered: number;
  /** Positive-target rows whose outlet is not in the live roster (not counted). */
  targetsOutsideRoster: number;
}

/**
 * Gifsy-wide Voucher Dispersal (GIFSY-run Excel → Hubble → WhatsApp campaigns; not tied to a tenant — the
 * WhatsApp receipts are written under the platform tenant 'gifsy', so no tenant section can see them).
 */
export interface VoucherDispersalSection {
  /** Rows → BOUGHT in the window (boughtAt). */
  bought: number;
  /** Rows → BUY_FAILED in the window (updatedAt). */
  buyFailed: number;
  /** BOUGHT rows whose WhatsApp is FAILED / UNKNOWN, recorded in the window (updatedAt). */
  messageFailed: number;
  /** QUEUED + BUYING + PENDING_RECONCILE right now (the campaign screen's "pending"). */
  pending: number;
  /** Of `pending`: PENDING_RECONCILE rows past the 2 h retry gate (an admin may Retry now). */
  pendingRetryable: number;
  /** STILL OPEN (now): rows in BUY_FAILED (a Retry moves a row out of BUY_FAILED). */
  buyFailedOpen: number;
  /** STILL OPEN (now): BOUGHT rows whose WhatsApp is FAILED / UNKNOWN (a Resend clears the status). */
  messageFailedOpen: number;
  /** NOW: campaigns whose spent + with-Hubble + failed-may-complete money exceeds the budget (queued not counted). */
  overBudgetCampaigns?: number;
  /** NOW: campaigns whose status update has failed SETTLE_FAILURES_BEFORE_ALERT times in a row. */
  settleErrorCampaigns?: number;
  /** In the window: purchases Hubble BOUGHT after they had failed / been refused (row.lateCompletedAt). */
  lateCompleted?: number;
  /**
   * In the window: OPEN earlier-order alerts CREATED or WORSENED (status moved up to SUCCESS / PROCESSING / an
   * unrecognised status, or re-opened) — one per reference; never counted as spend. Split in `earlierOrderAlertsBy`.
   */
  earlierOrderAlerts?: number;
  /**
   * `earlierOrderAlerts` by what happened: Hubble activity on an EARLIER (retired) reference / on the reference of a row
   * marked "not bought" / a completed CURRENT order that could not be applied to its row; `couldNotCheck` = the lookup
   * failed and no real status is known yet.
   */
  earlierOrderAlertsBy?: { superseded: number; marked: number; notApplied: number; couldNotCheck: number };
  /** In the window: alerts RESOLVED (Hubble confirmed the order failed / there is no order) — listed apart. */
  earlierOrderAlertsResolved?: number;
  /** NOW: rows an admin marked "not bought" — CLOSED (informational; not "still failed"). */
  markedClosed?: number;
  /**
   * NOW: pending rows whose last Hubble answer was undocumented (not in `pendingRetryable`), plus FAILED rows (not
   * marked) whose LATEST lookup was an undocumented status — need Gifsy tech.
   */
  unrecognisedStatus?: number;
}

/** Client.status values. */
export type TenantStatus = 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';

export interface TenantDigest {
  clientId: string;
  name: string;
  /** Client.status. A non-ACTIVE tenant is shown (with its status) only when it has activity or open items. */
  status?: TenantStatus;
  /** features.hubbleVoucherEnabled — the Vouchers section is loaded for EVERY tenant (live problems show even when off). */
  hubbleEnabled?: boolean;
  kyc: SectionResult<KycSection>;
  points: SectionResult<PointsSection>;
  redemptions: SectionResult<RedemptionsSection>;
  /** Loaded for every tenant; shown when non-empty (labelled "integration switched off" when the flag is off). */
  vouchers?: SectionResult<VouchersSection>;
  payouts: SectionResult<PayoutsSection>;
  messages: SectionResult<MessagesSection>;
  /** Present ONLY for tenants with the visibilityEnabled setting ON. */
  visibility?: SectionResult<VisibilitySection>;
  /** Present ONLY for tenants with features.salesImport. */
  salesImport?: SectionResult<SalesImportSection>;
  /** Present ONLY for tenants with features.salesImport (its own try/catch — a failure never hides Sales Import). */
  billing?: SectionResult<BillingSection>;
}

export interface DigestInput {
  window: DigestWindow;
  /** Date the digest is sent, e.g. "13 Nov 2026" (IST). */
  dateLabel: string;
  tenants: TenantDigest[];
  /** Gifsy-wide OTP delivery failures in the window: pre-login (no user) + Gifsy staff users (clientId 'gifsy'). */
  gifsyOtpFailed?: SectionResult<{ preLogin: number; gifsyStaff: number }>;
  /** Gifsy-wide Voucher Dispersal; hidden when every figure is zero, "couldn't load" when it failed. */
  voucherDispersal?: SectionResult<VoucherDispersalSection>;
  /**
   * Run-level problems (a shared loader failed, the window was capped, …). Each is rendered in a red
   * "This digest is incomplete" box at the top and counts as an attention item.
   */
  runNotices?: string[];
  /** Informational window notes (first tracked run, manual re-run) — shown under the window, not attention. */
  windowNotes?: string[];
  /** Configured recipients DROPPED at send time (not on an allowed internal domain) — named in the footer. */
  droppedRecipients?: string[];
  /** Shared inputs that failed (tenant list, holidays, SLA targets, run history): stable key + label. */
  sharedFailures?: Array<{ key: string; label: string }>;
  /** "This email repeats <from–to> because the <date> digest was incomplete (…)" — shown at the top. */
  repeatNotice?: string;
  /** The longest run of consecutive incomplete digests for the same section (≥ 3 → "INCOMPLETE N days"). */
  incompleteStreak?: { runs: number; sections: string[] };
}

/** The rendered digest. */
export interface DigestResult {
  key: ReportKey;
  subject: string;
  html: string;
  /** Tenants with at least one "needs attention" item. */
  tenantsNeedingAttention: number;
  /** Total attention EVENTS across tenants + Gifsy-wide (a merged window + still-open bullet counts max of the two). */
  attentionItems: number;
  /** Everything that failed to load (any entry = a DEGRADED run). */
  failedSections: Array<{ key: string; label: string }>;
  /** Gifsy-wide (not tenant) attention items: voucher dispersal, Gifsy-wide OTP failures, run notices. */
  gifsyWideItems: number;
  /** Non-ACTIVE tenants left out because they had no activity and no open items (named in the email). */
  hiddenTenants: number;
}
