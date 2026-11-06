import { Prisma, RedemptionOrder, RedemptionStatus } from '@prisma/client';

/**
 * THE single write path for `RedemptionOrder.status` (order-timeline plan, owner D1).
 *
 * Every status change — partner confirm, admin/vendor transition, Hubble, cash UTR upload,
 * auto-supersede / OTP-fail cancel — goes through `transitionOrderStatus`, which updates the
 * order AND inserts its `RedemptionStatusHistory` row in the SAME transaction client, so the
 * partner's order timeline always has a dated row for every transition (forward-only: no
 * backfill of legacy gaps).
 *
 * Two forms:
 *  - UNGUARDED (`guard` omitted): `redemptionOrder.update({ where: { id } })` — throws if the
 *    row is missing, returns the updated row. History is skipped only for a same-status no-op
 *    (`fromStatus === toStatus`), e.g. re-marking an already-FAILED order FAILED.
 *  - GUARDED (`guard` set): an atomic claim `updateMany({ where: { id, ...guard } })` — returns
 *    `{ count }`; history is written ONLY when the claim won (count > 0), so a lost race / an
 *    idempotent re-run never leaves a phantom row.
 *
 * Callers keep their own money logic (refund claims, debits) untouched; this only owns the
 * status column + its audit row. `fromStatus: null` = "not known at the call site" (the
 * member timeline uses `toStatus` only). Never put member-visible text in `notes` — it is
 * ops-only and the member `/track` projection never selects it.
 */
type Tx = Prisma.TransactionClient;

interface TransitionCommon {
  orderId: string;
  fromStatus: RedemptionStatus | null;
  toStatus: RedemptionStatus;
  changedById?: string | null;
  notes?: string | null;
}

export interface UnguardedTransition extends TransitionCommon {
  guard?: undefined;
  /** Extra columns written with the status (never `status` itself). */
  data?: Omit<Prisma.RedemptionOrderUpdateInput, 'status'>;
}

export interface GuardedTransition extends TransitionCommon {
  /** Extra `where` conditions ANDed with `{ id: orderId }` — the atomic claim predicate. */
  guard: Prisma.RedemptionOrderWhereInput;
  data?: Omit<Prisma.RedemptionOrderUpdateManyMutationInput, 'status'>;
}

export function transitionOrderStatus(tx: Tx, args: GuardedTransition): Promise<{ count: number }>;
export function transitionOrderStatus(tx: Tx, args: UnguardedTransition): Promise<RedemptionOrder>;
export async function transitionOrderStatus(
  tx: Tx,
  args: GuardedTransition | UnguardedTransition,
): Promise<{ count: number } | RedemptionOrder> {
  const { orderId, fromStatus, toStatus } = args;
  const history = () =>
    tx.redemptionStatusHistory.create({
      data: {
        orderId,
        fromStatus,
        toStatus,
        changedById: args.changedById ?? null,
        notes: args.notes ?? null,
      },
    });

  if (args.guard) {
    const claim = await tx.redemptionOrder.updateMany({
      where: { id: orderId, ...args.guard },
      data: { status: toStatus, ...(args.data ?? {}) },
    });
    if (claim.count > 0) await history();
    return claim;
  }

  const updated = await tx.redemptionOrder.update({
    where: { id: orderId },
    data: { status: toStatus, ...(args.data ?? {}) },
  });
  if (fromStatus !== toStatus) await history();
  return updated;
}

/**
 * Single-active-OTP rule (redeem / redeemForOutlet): cancel the OUTLET's abandoned PENDING
 * orders (never debited → no refund). Same predicate as before (`partnerId` + `PENDING`),
 * applied as a per-order guarded claim so each cancelled order gets exactly one
 * `PENDING → CANCELLED` history row, and an order confirmed concurrently gets none.
 */
export async function supersedePendingOrders(
  tx: Tx,
  partnerId: string,
  changedById: string | null,
  now: Date,
): Promise<void> {
  const where = { partnerId, status: 'PENDING' as const };
  // Claim in id order so two concurrent redeems lock rows in the same order (no deadlock).
  const pending = await tx.redemptionOrder.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
  for (const { id } of pending) {
    await transitionOrderStatus(tx, {
      orderId: id,
      guard: where,
      fromStatus: RedemptionStatus.PENDING,
      toStatus: RedemptionStatus.CANCELLED,
      data: { cancelledAt: now },
      changedById,
      notes: 'Superseded — OTP not completed',
    });
  }
}
