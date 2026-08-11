/**
 * Two-stage KYC review-SLA model (owner decision 2026-08-11) — FE mirror of
 * api/src/common/kyc-sla-stage.ts (separate build root; keep logically identical).
 *
 *   • FIELD SLA  — `submittedAt` → the KYC reaching Gifsy. Sales-chain owned. Default 24 business hrs.
 *   • GIFSY SLA  — LATEST PENDING_GIFSY entry → decision. Gifsy owned; restarts on re-entry. Default 96.
 *
 * A row is on exactly one clock (field / gifsy), frozen if decided, or 'none' (draft/terminal).
 */

import { businessHoursBetween } from '@/lib/business-hours';

export type KycSlaClock = 'field' | 'gifsy' | 'none';

export interface KycSlaTargets {
  fieldHrs: number;
  gifsyHrs: number;
}

export const KYC_FIELD_SLA_KEY = 'fieldSlaTargetHours';
export const KYC_GIFSY_SLA_KEY = 'gifsySlaTargetHours';
export const KYC_FIELD_SLA_DEFAULT = 24;
export const KYC_GIFSY_SLA_DEFAULT = 96;
export const KYC_SLA_MIN_HOURS = 1;
export const KYC_SLA_MAX_HOURS = 168;

const GIFSY_STATUS = 'PENDING_GIFSY';
const FIELD_STATUSES = new Set<string>([
  'SUBMITTED',
  'UNDER_REVIEW',
  'PENDING_PENNY_DROP',
  'PENDING_AGREEMENT',
  'PENDING_SO_APPROVAL',
  'PENDING_ASM_APPROVAL',
  'PENDING_RSM_APPROVAL',
]);
const DECIDED_STATUSES = new Set<string>([
  'APPROVED',
  'REJECTED',
  'RESUBMISSION_REQUIRED',
  'RE_KYC_REQUIRED',
]);

export function kycStageOf(status: string): 'field' | 'gifsy' | 'decided' | 'none' {
  if (status === GIFSY_STATUS) return 'gifsy';
  if (FIELD_STATUSES.has(status)) return 'field';
  if (DECIDED_STATUSES.has(status)) return 'decided';
  return 'none';
}

export interface KycSlaInput {
  status: string;
  submittedAt?: string | Date | number | null;
  gifsyEnteredAt?: string | Date | number | null;
  approvedAt?: string | Date | number | null;
  reviewedAt?: string | Date | number | null;
  updatedAt?: string | Date | number | null;
  nowMs: number;
}

export interface KycSlaResult {
  clock: KycSlaClock;
  ageHrs: number;
  targetHrs: number | null;
  breached: boolean;
  frozen: boolean;
}

function toMs(v: string | Date | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

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
  const onGifsy = stage === 'gifsy' || (decided && gifsyEnteredMs !== null);
  const clock: KycSlaClock = onGifsy ? 'gifsy' : 'field';

  // Gifsy-clock start = LATEST PENDING_GIFSY entry; fall back to submittedAt when that history
  // entry is missing so a stuck Gifsy row still ages + surfaces (matches the backend + dashboard).
  const startMs = onGifsy ? gifsyEnteredMs ?? submittedMs : submittedMs;
  if (startMs === null) {
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
