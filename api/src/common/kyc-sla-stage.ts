/**
 * Two-stage KYC review-SLA model (owner decision 2026-08-11).
 *
 * A KYC submission's review time is split into TWO independently-owned, independently-targeted
 * business-hours clocks (both weekend/holiday-aware via businessHoursBetween):
 *
 *   • FIELD SLA  — from `submittedAt` (owner consent, leaving DRAFT) until the KYC reaches Gifsy.
 *                  Owned by the field/sales approval chain. Default target 24 business hours.
 *   • GIFSY SLA  — from the LATEST entry into the Gifsy queue (PENDING_GIFSY) until the decision.
 *                  Owned by Gifsy. Restarts if a bounced KYC re-enters the queue. Default 96.
 *
 * At any moment a submission is on exactly ONE clock (its current stage), or none:
 *   - field stage  → still with the sales chain (SUBMITTED … PENDING_RSM_APPROVAL)
 *   - gifsy stage  → PENDING_GIFSY
 *   - decided      → frozen; the clock it ended on stays displayed (gifsy if it reached Gifsy, else field)
 *   - none         → DRAFT / not-started / terminal-non-decided → no active SLA
 *
 * A mirror copy lives at platform/src/lib/kyc-sla-stage.ts (separate build root — keep logically
 * identical). The dashboard reuses the status SETS + targets; the list + report use kycStageSla().
 */

import { businessHoursBetween } from './business-hours';

/** Which SLA clock a submission is on (or was on, if decided). */
export type KycSlaClock = 'field' | 'gifsy' | 'none';

export interface KycSlaTargets {
  /** Field-stage target, business hours. */
  fieldHrs: number;
  /** Gifsy-stage target, business hours. */
  gifsyHrs: number;
}

/** Settings keys + bounds + defaults for the two per-tenant SLA targets. */
export const KYC_FIELD_SLA_KEY = 'fieldSlaTargetHours';
export const KYC_GIFSY_SLA_KEY = 'gifsySlaTargetHours';
export const KYC_FIELD_SLA_DEFAULT = 24;
export const KYC_GIFSY_SLA_DEFAULT = 96;
export const KYC_SLA_MIN_HOURS = 1;
export const KYC_SLA_MAX_HOURS = 168;

/** PENDING_GIFSY — awaiting Gifsy's final approval. */
const GIFSY_STATUS = 'PENDING_GIFSY';
/** Field/sales-chain stages: submitted and moving through the approval chain, before Gifsy. */
const FIELD_STATUSES = new Set<string>([
  'SUBMITTED',
  'UNDER_REVIEW',
  'PENDING_PENNY_DROP',
  'PENDING_AGREEMENT',
  'PENDING_SO_APPROVAL',
  'PENDING_ASM_APPROVAL',
  'PENDING_RSM_APPROVAL',
]);
/** Decided — a reviewer acted; the clock freezes at the decision. */
const DECIDED_STATUSES = new Set<string>([
  'APPROVED',
  'REJECTED',
  'RESUBMISSION_REQUIRED',
  'RE_KYC_REQUIRED',
]);

export { GIFSY_STATUS as KYC_GIFSY_STATUS, FIELD_STATUSES as KYC_FIELD_STATUSES, DECIDED_STATUSES as KYC_DECIDED_STATUSES };

/** The stage a raw KycStatus is in. Anything not field/gifsy/decided (DRAFT, terminal, …) → 'none'. */
export function kycStageOf(status: string): 'field' | 'gifsy' | 'decided' | 'none' {
  if (status === GIFSY_STATUS) return 'gifsy';
  if (FIELD_STATUSES.has(status)) return 'field';
  if (DECIDED_STATUSES.has(status)) return 'decided';
  return 'none';
}

export interface KycSlaInput {
  status: string;
  /** Consent/submit moment (leaves DRAFT). */
  submittedAt?: string | Date | number | null;
  /** The LATEST PENDING_GIFSY entry (computed from statusHistory by the caller/backend). */
  gifsyEnteredAt?: string | Date | number | null;
  /** Decision timestamps for a frozen (decided) row — first present wins. */
  approvedAt?: string | Date | number | null;
  reviewedAt?: string | Date | number | null;
  updatedAt?: string | Date | number | null;
  /** "now" passed in (never Date.now()) so the result is deterministic + testable. */
  nowMs: number;
}

export interface KycSlaResult {
  /** Which clock is displayed. 'none' = no active SLA (draft/terminal). */
  clock: KycSlaClock;
  /** Business hours on that clock (rounded). 0 when clock is 'none'. */
  ageHrs: number;
  /** The target for the displayed clock, or null when 'none'. */
  targetHrs: number | null;
  /** ageHrs > targetHrs. Always false when 'none'. */
  breached: boolean;
  /** true = the row is decided (clock frozen at the decision), false = live. */
  frozen: boolean;
}

/** Coerce an ISO string / Date / epoch-ms to epoch-ms, else null. */
function toMs(v: string | Date | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Compute the current-stage SLA for a submission: which clock, its business-hours age, the stage
 * target, and whether it has breached. Pending rows run to `nowMs`; decided rows freeze at the
 * decision. A decided row that reached Gifsy is shown on the gifsy clock; one decided at field
 * (e.g. a field reject) on the field clock.
 */
export function kycStageSla(
  input: KycSlaInput,
  targets: KycSlaTargets,
  holidays: Set<string> = new Set(),
): KycSlaResult {
  const stage = kycStageOf(input.status);
  if (stage === 'none') return { clock: 'none', ageHrs: 0, targetHrs: null, breached: false, frozen: false };

  const decided = stage === 'decided';
  const gifsyEnteredMs = toMs(input.gifsyEnteredAt);
  const submittedMs = toMs(input.submittedAt);
  // On the gifsy clock if currently at Gifsy, OR decided after having reached Gifsy.
  // KNOWN LIMITATION (rare): a KYC that reached Gifsy, was bounced back to the field chain, and
  // was then DECIDED at field (e.g. a field-level reject) still reads as gifsy here, since only
  // the latest-gifsy-entry timestamp is threaded in, not the decision's stage. Telling the two
  // apart would need the full post-bounce history at every call site — deferred as low value.
  const onGifsy = stage === 'gifsy' || (decided && gifsyEnteredMs !== null);
  const clock: KycSlaClock = onGifsy ? 'gifsy' : 'field';

  // Gifsy-clock start = the LATEST PENDING_GIFSY entry. When that history entry is missing (a row
  // sitting in PENDING_GIFSY with no recorded transition — legacy/imported/direct-set rows), fall
  // back to submittedAt rather than reading 0h/healthy: a stuck Gifsy row must still age + surface.
  // This mirrors the dashboard's `enteredAt ?? submittedAt` fallback so all SLA surfaces agree.
  const startMs = onGifsy ? gifsyEnteredMs ?? submittedMs : submittedMs;
  if (startMs === null) {
    // Missing the clock's start timestamp → no defensible age.
    return { clock, ageHrs: 0, targetHrs: onGifsy ? targets.gifsyHrs : targets.fieldHrs, breached: false, frozen: decided };
  }

  const endMs = decided
    ? toMs(input.approvedAt) ?? toMs(input.reviewedAt) ?? toMs(input.updatedAt) ?? input.nowMs
    : input.nowMs;

  const ageHrs = Math.round(businessHoursBetween(startMs, endMs, holidays));
  const targetHrs = onGifsy ? targets.gifsyHrs : targets.fieldHrs;
  return { clock, ageHrs, targetHrs, breached: ageHrs > targetHrs, frozen: decided };
}

/** Pick the LATEST PENDING_GIFSY entry timestamp (epoch-ms) from a status-history list, else null. */
export function latestGifsyEntryMs(
  history: Array<{ toStatus?: string | null; createdAt?: string | Date | number | null }> | null | undefined,
): number | null {
  if (!Array.isArray(history)) return null;
  let latest: number | null = null;
  for (const h of history) {
    if (!h || h.toStatus !== GIFSY_STATUS) continue;
    const t = toMs(h.createdAt);
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}
