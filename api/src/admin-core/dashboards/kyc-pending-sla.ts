/**
 * The admin KYC dashboard's LIVE pending-SLA rule, shared so every surface that reports "KYCs
 * breaching the SLA" counts the same rows the same way (the dashboard `kycDashboard` and the Daily
 * Operations Digest both use it).
 *
 *  - POPULATION (`kycAddressableOutletWhere` + `KYC_LATEST_SUBMISSION_SELECT`): every ADDRESSABLE
 *    outlet of the tenant — not deleted, not deactivated, kycIntent not NOT_INTERESTED / PARKED (the
 *    OR keeps the kycIntent=NULL majority; Prisma `notIn` drops NULLs) — and, per outlet, the LATEST
 *    submission of its owning partner (createdAt desc, take 1). Grain = outlet, exactly as the
 *    dashboard's headline / buckets.
 *  - AGE (`kycPendingAge`): business hours (Mon–Fri minus the holiday set), UNROUNDED. Field-stage
 *    rows age from submittedAt (else createdAt); PENDING_GIFSY rows from the LATEST PENDING_GIFSY
 *    history entry (else submittedAt, else createdAt) — "restart on re-entry".
 *  - BREACH: age > target (age ≤ target is within). Compare the unrounded age; round only for display.
 */

import type { Prisma } from '@prisma/client';
import { businessHoursBetween } from '../../common/business-hours';
import { KYC_PENDING_FIELD_STATUSES } from '../../common/kyc-rekyc.helper';

/** The addressable-outlet universe of a tenant (optionally narrowed, e.g. by program). */
export function kycAddressableOutletWhere(clientId: string, extra: Prisma.OutletWhereInput = {}): Prisma.OutletWhereInput {
  return {
    clientId,
    deletedAt: null,
    deactivatedAt: null,
    ...extra,
    OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
  };
}

/** Per outlet: the owning partner's latest submission with its full status history. */
export const KYC_LATEST_SUBMISSION_SELECT = {
  kycSubmissions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      status: true,
      submittedAt: true,
      approvedAt: true,
      createdAt: true,
      statusHistory: {
        // fromStatus + metadata: a DRAFT→PENDING_GIFSY entry CARRYING the fast-track marker =
        // GIFSY-reject fast-track (no field stage).
        select: { fromStatus: true, toStatus: true, createdAt: true, metadata: true },
      },
    },
  },
};

type TimeLike = Date | string | number | null | undefined;
const toMs = (v: TimeLike): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

export interface KycPendingSubmission {
  status: string;
  submittedAt?: TimeLike;
  createdAt?: TimeLike;
  statusHistory?: Array<{ toStatus?: string | null; createdAt?: TimeLike }> | null;
}

/** The LATEST PENDING_GIFSY entry (epoch-ms) or null. */
export function latestPendingGifsyEntryMs(history: KycPendingSubmission['statusHistory']): number | null {
  if (!Array.isArray(history)) return null;
  let latest: number | null = null;
  for (const h of history) {
    if (!h || h.toStatus !== 'PENDING_GIFSY') continue;
    const t = toMs(h.createdAt);
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

/**
 * The live pending stage + UNROUNDED business-hours age of a submission, or null when it is not
 * pending (decided / draft / terminal) or has no start timestamp at all.
 */
export function kycPendingAge(
  sub: KycPendingSubmission,
  nowMs: number,
  holidays: Set<string>,
): { stage: 'field' | 'gifsy'; ageHrs: number } | null {
  let stage: 'field' | 'gifsy';
  let startMs: number | null;
  if (KYC_PENDING_FIELD_STATUSES.has(sub.status as never)) {
    stage = 'field';
    startMs = toMs(sub.submittedAt) ?? toMs(sub.createdAt);
  } else if (sub.status === 'PENDING_GIFSY') {
    stage = 'gifsy';
    startMs = latestPendingGifsyEntryMs(sub.statusHistory) ?? toMs(sub.submittedAt) ?? toMs(sub.createdAt);
  } else {
    return null;
  }
  if (startMs === null) return null;
  return { stage, ageHrs: businessHoursBetween(startMs, nowMs, holidays) };
}
