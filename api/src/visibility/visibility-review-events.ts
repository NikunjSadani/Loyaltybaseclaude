import { Prisma, VisibilityCaptureStatus, VisibilityReviewAction } from '@prisma/client';
import { readMediaValue } from './visibility-types';

/**
 * Old-app (vendor) captures imported into the platform (Bajaj prod 2026-11-12, ~51k rows; also staging).
 * The importer copied every photo into OUR storage under a path containing `/vendor-import/`
 * (`visibility-media/<tenant>/vendor-import/...`, see BAJAJ-PROD-OUTLET-IMPORT.md §8) — that path is
 * THE marker of an imported capture (there is no column for it). The migration
 * 20261120140000_visibility_review_events uses the SAME rule in SQL (formValues text LIKE '%/vendor-import/%').
 */
export const VENDOR_IMPORT_PATH_MARKER = '/vendor-import/';

/**
 * Who "reviewed" an imported capture: the OLD app approved it (approvedBy on the row is only the Gifsy
 * admin who ran the import, so it must never be shown as the reviewer). Same text as the migration backfill.
 */
export const IMPORTED_REVIEW_ACTOR_LABEL = 'Imported — old app approval';

/** True when any photo of the capture lives under the vendor-import path (an imported old-app capture). */
export function isImportedCapture(formValues: unknown): boolean {
  if (!formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return false;
  for (const v of Object.values(formValues as Record<string, unknown>)) {
    const { key } = readMediaValue(v);
    if (key && key.includes(VENDOR_IMPORT_PATH_MARKER)) return true;
  }
  return false;
}

/**
 * Tie-break rank for events sharing one timestamp (one transaction writes e.g. PHOTO_REJECTED +
 * CHANGES_REQUESTED_RESULT with the same `now`): a submission comes first, then a photo decision,
 * then a whole-capture decision, then the resulting status move. Newest-first lists sort by
 * (createdAt desc, version desc, rank desc, id desc) — fully deterministic.
 */
const ACTION_RANK: Record<VisibilityReviewAction, number> = {
  SUBMITTED: 0,
  RESUBMITTED: 0,
  PHOTO_APPROVED: 1,
  PHOTO_REJECTED: 1,
  CAPTURE_APPROVED_ALL: 2,
  CAPTURE_REJECTED_ALL: 2,
  CHANGES_REQUESTED_RESULT: 3,
};

/** Newest-first comparator for review events (see ACTION_RANK). */
export function compareEventsNewestFirst(
  a: { createdAt: Date; version: number; action: VisibilityReviewAction; id: string },
  b: { createdAt: Date; version: number; action: VisibilityReviewAction; id: string },
): number {
  return (
    b.createdAt.getTime() - a.createdAt.getTime() ||
    b.version - a.version ||
    (ACTION_RANK[b.action] ?? 0) - (ACTION_RANK[a.action] ?? 0) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/**
 * Permanent, append-only Visibility review history (`visibility_review_events`).
 *
 * The live VisibilityCapture row resets its review attribution on every resubmit, so these
 * events are the only lasting record of who submitted / approved / sent back which photo,
 * when and why. Every write path (submit, resubmit, per-photo review, approve-all, reject-all)
 * appends here INSIDE its own transaction (pass the `tx` client) — never update or delete.
 */
export interface ReviewEventInput {
  clientId: string;
  captureId: string;
  outletId: string;
  windowKey: string;
  version: number;
  action: VisibilityReviewAction;
  statusAfter?: VisibilityCaptureStatus | null;
  fieldId?: string | null;
  fieldLabel?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  createdAt?: Date;
}

type EventWriter = { visibilityReviewEvent: { createMany: Prisma.TransactionClient['visibilityReviewEvent']['createMany'] } };

/** Append review events in the caller's transaction. A no-op for an empty list. */
export async function appendReviewEvents(tx: EventWriter, events: ReviewEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await tx.visibilityReviewEvent.createMany({
    data: events.map((e) => ({
      clientId: e.clientId,
      captureId: e.captureId,
      outletId: e.outletId,
      windowKey: e.windowKey,
      version: e.version,
      action: e.action,
      statusAfter: e.statusAfter ?? null,
      fieldId: e.fieldId ?? null,
      fieldLabel: e.fieldLabel ?? null,
      reasonCode: e.reasonCode ?? null,
      reason: e.reason ?? null,
      actorUserId: e.actorUserId ?? null,
      actorName: e.actorName ? e.actorName : null,
      ...(e.createdAt ? { createdAt: e.createdAt } : {}),
    })),
  });
}
