import { Prisma, VisibilityCaptureStatus, VisibilityReviewAction } from '@prisma/client';

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
