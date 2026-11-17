/**
 * GIFSY-reject fast-track (Bajaj-only, tenant flag `clients.features.gifsyRejectFastTrack`, default OFF).
 *
 * Business rule (owner + client agreed): when an outlet's KYC was REJECTED BY GIFSY AFTER the sales
 * managers had already approved it (i.e. the rejection happened while it sat at PENDING_GIFSY), the
 * rep's fresh resubmission skips the manager chain and goes STRAIGHT to PENDING_GIFSY at the outlet
 * owner's consent OTP. Gifsy re-validates the documents anyway, so what the rep changed is irrelevant.
 *
 * Not eligible (→ the normal manager route, unchanged):
 *   - the NEW submission is an SO Declaration (the ASM must re-sign — decided by the NEW variant only);
 *   - no prior routed submission (an outlet's first KYC);
 *   - the prior submission is APPROVED / in flight (admin re-KYC of an approved outlet is not a rejection);
 *   - the prior rejection was by a MANAGER, or by Gifsy while the KYC was still at a manager stage
 *     (Gifsy may reject at any stage via reject()) — i.e. the rejection row's fromStatus != PENDING_GIFSY.
 *
 * Pure helpers (plus ONE batched loader, loadKycFastTrackMap) so every consumer (consent routing,
 * detail/queue endpoints, exports, dashboards) reads the SAME marker the SAME way.
 */

import type { PrismaClient } from '@prisma/client';

/** Value of `KycStatusHistory.metadata.fastTrack` on the DRAFT→PENDING_GIFSY row a fast-track writes. */
export const KYC_FAST_TRACK_MARKER = 'GIFSY_REJECT_RESUBMISSION';

/** Tenant feature-flag key (clients.features). */
export const KYC_FAST_TRACK_FEATURE = 'gifsyRejectFastTrack';

/**
 * Status-history notes on the fast-track routing row (the skip must be visible — no silent pass-through). Same
 * sentence as the admin banner / approvals note (platform/src/lib/kyc-fast-track.ts FAST_TRACK_HEADLINE).
 */
export const KYC_FAST_TRACK_NOTE =
  'Resubmitted after a GIFSY rejection — sent directly to GIFSY; managers did not re-approve.';

/** Export "Routing" column header + the value for a fast-tracked submission (blank otherwise). */
export const KYC_ROUTING_HEADER = 'Routing';
export const KYC_ROUTING_FAST_TRACK_LABEL = 'Direct to GIFSY (resubmitted after GIFSY rejection)';

/** True iff a tenant features blob has the fast-track flag ON (exactly `true`). */
export function hasFastTrackFeature(features: unknown): boolean {
  return asObject(features)?.[KYC_FAST_TRACK_FEATURE] === true;
}

/** The rejected statuses a resubmission can follow. RESUBMISSION_REQUIRED is the legacy alias of RE_UPLOAD_REQUIRED. */
export const KYC_REJECTED_STATUSES = ['REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED'] as const;

/** API contract (`fastTrack` on the KYC detail + Gifsy review-queue entries). null = routed normally. */
export interface KycFastTrack {
  previousSubmissionId: string;
  /** ISO timestamp of the Gifsy rejection of the previous submission. */
  previousRejectedAt: string;
}

/** Minimal status-history row shape the helpers read. */
export interface KycFastTrackHistoryRow {
  fromStatus?: string | null;
  toStatus?: string | null;
  metadata?: unknown;
  createdAt?: Date | string | null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** True iff a history row's metadata carries the fast-track marker (for selects that omit fromStatus). */
export function hasFastTrackMarker(metadata: unknown): boolean {
  return asObject(metadata)?.fastTrack === KYC_FAST_TRACK_MARKER;
}

/** True iff this history row is the fast-track routing row (DRAFT→PENDING_GIFSY carrying the marker). */
export function isFastTrackRow(h: KycFastTrackHistoryRow | null | undefined): boolean {
  if (!h) return false;
  return h.fromStatus === 'DRAFT' && h.toStatus === 'PENDING_GIFSY' && hasFastTrackMarker(h.metadata);
}

/**
 * Derive the `fastTrack` API field from a submission's status history (any order; the LATEST fast-track
 * row wins — a submission is routed out of DRAFT at most once, so there is normally exactly one). null when
 * the submission was routed normally (every non-Bajaj tenant, incl. Deoleo).
 */
export function fastTrackFromHistory(
  history: KycFastTrackHistoryRow[] | null | undefined,
): KycFastTrack | null {
  if (!Array.isArray(history)) return null;
  let best: { row: KycFastTrackHistoryRow; ms: number } | null = null;
  for (const h of history) {
    if (!isFastTrackRow(h)) continue;
    const ms = h.createdAt ? new Date(h.createdAt).getTime() : 0;
    if (!best || ms > best.ms) best = { row: h, ms: Number.isFinite(ms) ? ms : 0 };
  }
  if (!best) return null;
  const m = asObject(best.row.metadata)!;
  const previousSubmissionId = typeof m.previousSubmissionId === 'string' ? m.previousSubmissionId : '';
  // previousRejectedAt is always written with the marker; fall back to the routing row's own time only
  // for a hand-edited/legacy row so the field is never a garbage value.
  const rejectedRaw = typeof m.previousRejectedAt === 'string' ? m.previousRejectedAt : null;
  const rejectedMs = rejectedRaw ? new Date(rejectedRaw).getTime() : NaN;
  const previousRejectedAt = Number.isFinite(rejectedMs)
    ? new Date(rejectedMs).toISOString()
    : new Date(best.ms).toISOString();
  return { previousSubmissionId, previousRejectedAt };
}

/** Minimal Prisma surface the batched loader needs (PrismaService or a tx client). */
interface FastTrackHistoryReader {
  kycStatusHistory: Pick<PrismaClient['kycStatusHistory'], 'findMany'>;
}

/**
 * Batched `fastTrack` lookup for a page/list of submissions — ONE query for the whole set (no N+1).
 * Only the DRAFT→PENDING_GIFSY transition can carry the marker (no other code path writes that edge),
 * so the query is narrow. Submissions absent from the map were routed normally (→ fastTrack null).
 */
export async function loadKycFastTrackMap(
  prisma: FastTrackHistoryReader,
  submissionIds: string[],
): Promise<Map<string, KycFastTrack>> {
  const out = new Map<string, KycFastTrack>();
  const ids = Array.from(new Set(submissionIds.filter((x) => typeof x === 'string' && x.length > 0)));
  if (ids.length === 0) return out;
  const rows = await prisma.kycStatusHistory.findMany({
    where: { kycSubmissionId: { in: ids }, fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY' },
    select: { kycSubmissionId: true, fromStatus: true, toStatus: true, metadata: true, createdAt: true },
  });
  const bySub = new Map<string, KycFastTrackHistoryRow[]>();
  for (const r of Array.isArray(rows) ? (rows as Array<KycFastTrackHistoryRow & { kycSubmissionId: string }>) : []) {
    const list = bySub.get(r.kycSubmissionId) ?? [];
    list.push(r);
    bySub.set(r.kycSubmissionId, list);
  }
  for (const [id, list] of bySub) {
    const ft = fastTrackFromHistory(list);
    if (ft) out.set(id, ft);
  }
  return out;
}

/** The export "Routing" cell for a submission. */
export function kycRoutingLabel(fastTrack: KycFastTrack | null | undefined): string {
  return fastTrack ? KYC_ROUTING_FAST_TRACK_LABEL : '';
}

function isRejectedStatus(s: string | null | undefined): boolean {
  return !!s && (KYC_REJECTED_STATUSES as readonly string[]).includes(s);
}

/**
 * Eligibility of the PRIOR submission: it is in a rejected state AND it FIRST entered its current rejected
 * chain from PENDING_GIFSY (Gifsy rejected it AFTER the managers had approved / after a previous fast-track).
 *
 * `history` = that submission's FULL status history (any order). From the LATEST row into the prior's current
 * status, walk back through consecutive rejected→rejected rows (REJECTED / RE_UPLOAD_REQUIRED /
 * RESUBMISSION_REQUIRED — e.g. Gifsy acting again on an already-rejected KYC: RE_UPLOAD_REQUIRED→REJECTED via
 * reject(), or REJECTED→REJECTED via PATCH) to the row where it FIRST entered the rejected chain; qualify iff that
 * row's fromStatus is PENDING_GIFSY. A manager rejection later re-rejected by Gifsy therefore does NOT qualify.
 * An unprovable chain (a gap: no earlier row into the rejected fromStatus) → null (the normal manager route).
 * Returns the time of the LATEST rejection (previousRejectedAt) or null when not eligible.
 */
export function gifsyRejectionAfterManagers(
  prior: { status: string } | null | undefined,
  history: KycFastTrackHistoryRow[] | null | undefined,
): { rejectedAt: Date } | null {
  if (!prior || !isRejectedStatus(prior.status)) return null;
  if (!Array.isArray(history)) return null;
  // Oldest → newest; ties keep the input (query) order. Rows without a readable time are unusable.
  const rows = history
    .map((h, idx) => ({ h, idx, ms: h?.createdAt ? new Date(h.createdAt).getTime() : NaN }))
    .filter((r) => !!r.h && Number.isFinite(r.ms))
    .sort((a, b) => a.ms - b.ms || a.idx - b.idx);
  // The LATEST row INTO the prior's CURRENT rejected status.
  let end = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].h.toStatus === prior.status) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  // Walk back to the first entry into the rejected chain.
  let i = end;
  while (isRejectedStatus(rows[i].h.fromStatus)) {
    const from = rows[i].h.fromStatus;
    let j = i - 1;
    while (j >= 0 && rows[j].h.toStatus !== from) j--;
    if (j < 0) return null; // gap — cannot prove who first rejected it → fail safe (manager route)
    i = j;
  }
  if (rows[i].h.fromStatus !== 'PENDING_GIFSY') return null;
  return { rejectedAt: new Date(rows[end].ms) };
}
